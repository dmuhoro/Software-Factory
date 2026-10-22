import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DoctrineService } from './doctrineService';
import { readFiles } from './parallelReadService';

/**
 * Repo-doctrine isolation.
 *
 * A target repository arrives with its own `AGENTS.md`, `CLAUDE.md`, `.claude/`, `.opencode/`
 * and `opencode.json` — instructions written by whoever owns that repository, which may
 * contradict the loop's rules, tell it to skip verification, or redefine what "done" means.
 *
 * Three properties are enforced here, all fail-closed:
 *
 *  1. The doctrine root must exist and must not be inside the target repository. Running the
 *     loop from within a target repo cannot make that repo the rulebook.
 *  2. The doctrine manifest must verify before anything runs, and is re-verified at `report`,
 *     so a doctrine edited mid-run halts the run instead of changing the rules under it.
 *  3. The target's instruction files are recorded with hashes into the run's quarantine manifest
 *     and are never read. Every process the loop spawns carries `OPENCODE_DISABLE_PROJECT_CONFIG=1`
 *     so a harness invoked downstream cannot pick them up either.
 *
 * The files themselves are never moved or deleted: a run that dies halfway must not leave a
 * repository missing a file its owner wrote.
 */

interface QuarantineEntry {
  relativePath: string;
  sha256: string;
  bytes: number;
  action: 'recorded-not-read';
}

export interface IsolationManifest {
  doctrineRoot: string;
  doctrineDigest: string;
  targetRepo: string;
  quarantine: QuarantineEntry[];
  childEnv: Record<string, string>;
  stagedAt: string;
  /** How the target's instruction files were read: 'parallel' (the loop's path) or 'sequential'.
   *  Recorded so a run record says which path produced its evidence. */
  readStrategy: 'parallel' | 'sequential';
}

/**
 * The durable evidence for a staged manifest: which instruction files the target carried, and their
 * hashes. Persisted on the run record so a resume can prove the target's rules did not change
 * between sessions. The scrubbed child environment is deliberately excluded: the evidence is what
 * was quarantined, not the environment it was quarantined in.
 */
export interface IsolationEvidence {
  doctrineRoot: string;
  doctrineDigest: string;
  targetRepo: string;
  stagedAt: string;
  quarantine: QuarantineEntry[];
  /** How the target's instruction files were read when this run staged its isolation. */
  readStrategy: 'parallel' | 'sequential';
}

const TARGET_INSTRUCTION_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'CLAUDE.local.md',
  'CONTEXT.md',
  'opencode.json',
  'opencode.jsonc',
  '.cursorrules',
  '.github/copilot-instructions.md',
  '.github/copilot-instructions.yaml',
] as const;

const TARGET_INSTRUCTION_DIRS = ['.claude', '.opencode', '.agents', '.cursor', '.rules'] as const;

function fail(code: string, detail?: string): Error {
  return new Error(detail ? `${code}:${detail}` : code);
}

function sha256(buffer: Buffer | string): string {
  return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function listFiles(dir: string, prefix = '', insideInstructionDir = false): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    // Symlinks are never descended into: `.claude/skills/*` in this repository points outside
    // itself, and following it would record content that is not actually in the target repo.
    const isDirectory = entry.isDirectory() || (entry.isSymbolicLink() && isDirSync(path.join(dir, entry.name)));
    if (isDirectory) {
      if (entry.isSymbolicLink()) continue;
      const isInstructionDir = (TARGET_INSTRUCTION_DIRS as readonly string[]).includes(entry.name);
      if (isInstructionDir) out.push(...listFiles(path.join(dir, entry.name), rel, true));
      else if (!['.git', 'node_modules', 'dist', 'build', 'target', '.data', '.factory-worktrees'].includes(entry.name)) {
        out.push(...listFiles(path.join(dir, entry.name), rel, insideInstructionDir));
      }
    } else if (insideInstructionDir || (TARGET_INSTRUCTION_FILES as readonly string[]).includes(rel)) {
      out.push(rel);
    }
  }
  return out;
}

function isDirSync(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

export class DoctrineIsolationService {
  /** Quarantine home for the scrubbed environment handed to every spawned process. */
  private static homeDir?: string;

  private static home(): string {
    if (!this.homeDir) {
      this.homeDir = path.join(os.tmpdir(), 'factory-loop-home');
      fs.mkdirSync(this.homeDir, { recursive: true, mode: 0o700 });
    }
    return this.homeDir;
  }

  /**
   * Builds the environment every process the loop spawns receives. The ambient environment is
   * *not* inherited: only the entries below are passed, so a credential in the operator's shell
   * cannot leak into a target repository's build.
   */
  public static childEnv(doctrineRoot: string, doctrineDigest: string, extra: Record<string, string> = {}): Record<string, string> {
    return {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: this.home(),
      LANG: process.env.LANG ?? 'C.UTF-8',
      CI: 'true',
      NODE_ENV: 'test',
      // The harness honours this: project-level AGENTS.md / CLAUDE.md / opencode.json are not
      // loaded when it is set (verified against the installed binary's instruction loader).
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      FACTORY_DOCTRINE_ROOT: doctrineRoot,
      FACTORY_DOCTRINE_SHA256: doctrineDigest,
      ...extra,
    };
  }

  /**
   * The rules half of staging: the checks that must hold before any work happens.
   * Throws when the doctrine root is unusable, is inside the target repository, or fails its
   * manifest check. Shared by the synchronous and the parallel staging path so there is one
   * set of rules and not two that can drift.
   */
  private static validate(targetRepo: string): { repo: string; root: string; digest: string } {
    const repo = path.resolve(targetRepo);
    if (!fs.existsSync(path.join(repo, '.git'))) throw fail('TARGET_REPOSITORY_NOT_GIT', repo);

    const root = DoctrineService.root();
    if (!fs.existsSync(path.join(root, 'loop.json'))) throw fail('DOCTRINE_ROOT_MISSING', root);
    if (isInside(root, repo) || path.resolve(root) === repo) {
      // A repository may not supply the rules it is judged by. The one exception is running the
      // loop against Software Factory itself — same trust domain — and it must be asked for
      // explicitly; the default stays shut.
      if (process.env.FACTORY_ALLOW_SELF_DOCTRINE !== '1') {
        throw fail('DOCTRINE_ROOT_INSIDE_TARGET_REPOSITORY', `${root} is inside ${repo}; a repository cannot supply the rules it is judged by`);
      }
    }

    const verification = DoctrineService.verifyManifest();
    if (!verification.ok) {
      const detail = [...verification.mismatches.map((item) => `changed:${item}`), ...verification.missing.map((item) => `missing:${item}`), ...verification.unexpected.map((item) => `unhashed:${item}`)].join(',');
      throw fail('DOCTRINE_MANIFEST_MISMATCH', detail);
    }
    return { repo, root, digest: DoctrineService.digest() };
  }

  /** Turn the bytes of the target's instruction files into the quarantine record. */
  private static quarantineFrom(repo: string, files: string[], buffers: Map<string, Buffer>): QuarantineEntry[] {
    return files.map((relativePath) => {
      const buffer = buffers.get(relativePath);
      // A file that could not be read is still recorded: it exists in the target, it was not
      // read, and a run that cannot read it must not pretend the quarantine is empty.
      const bytes = buffer ?? Buffer.alloc(0);
      return {
        relativePath,
        sha256: buffer ? sha256(buffer) : 'sha256:unreadable',
        bytes: bytes.byteLength,
        action: 'recorded-not-read' as const,
      };
    });
  }

  /**
   * Stages isolation for a run against `targetRepo`. Throws — before any work happens — when the
   * doctrine root is unusable, is inside the target repository, or fails its manifest check.
   */
  public static stage(targetRepo: string, extraEnv: Record<string, string> = {}): IsolationManifest {
    const { repo, root, digest } = this.validate(targetRepo);
    const files = listFiles(repo);
    const buffers = new Map<string, Buffer>();
    for (const relativePath of files) {
      try {
        buffers.set(relativePath, fs.readFileSync(path.join(repo, relativePath)));
      } catch {
        // Recorded as unreadable below; the run continues to quarantine it.
      }
    }
    const quarantine = this.quarantineFrom(repo, files, buffers);

    return {
      doctrineRoot: root,
      doctrineDigest: digest,
      targetRepo: repo,
      quarantine,
      childEnv: this.childEnv(root, digest, extraEnv),
      stagedAt: new Date().toISOString(),
      readStrategy: 'sequential',
    };
  }

  /**
   * Stages isolation with the target's instruction files read in parallel.
   *
   * The work is identical to `stage` — the same validation, the same file list, the same hashes
   * over the same bytes — but the reads of the target's instruction files overlap instead of
   * queueing. The hash is taken over the raw bytes, so a file that is not valid UTF-8 hashes
   * identically here and in the re-check at `report`.
   */
  public static async stageAsync(
    targetRepo: string,
    extraEnv: Record<string, string> = {},
    options: { concurrency?: number } = {},
  ): Promise<IsolationManifest> {
    const { repo, root, digest } = this.validate(targetRepo);
    const files = listFiles(repo);
    const reads = await readFiles(repo, files, { concurrency: options.concurrency, maxBytes: 8 * 1024 * 1024 });
    const buffers = new Map<string, Buffer>();
    for (const read of reads) {
      if (read.base64 === undefined) continue;
      buffers.set(read.path, Buffer.from(read.base64, 'base64'));
    }
    const quarantine = this.quarantineFrom(repo, files, buffers);

    return {
      doctrineRoot: root,
      doctrineDigest: digest,
      targetRepo: repo,
      quarantine,
      childEnv: this.childEnv(root, digest, extraEnv),
      stagedAt: new Date().toISOString(),
      readStrategy: 'parallel',
    };
  }

  /** The durable evidence for a staged manifest, persisted on the run record and re-verifyable.
   * A returned copy, not a view: a run's evidence must not change if the manifest object does. */
  public static evidence(manifest: IsolationManifest): IsolationEvidence {
    return {
      doctrineRoot: manifest.doctrineRoot,
      doctrineDigest: manifest.doctrineDigest,
      targetRepo: manifest.targetRepo,
      stagedAt: manifest.stagedAt,
      quarantine: manifest.quarantine.map((entry) => ({ ...entry })),
      readStrategy: manifest.readStrategy,
    };
  }

  /**
   * Re-checks the doctrine manifest and the target's instruction files. Called again at `report`
   * so that a run whose rulebook changed underneath it halts instead of reporting under rules it
   * did not actually follow.
   */
  public static verify(manifest: IsolationEvidence): { ok: boolean; reasons: string[] } {
    const reasons: string[] = [];
    try {
      const verification = DoctrineService.verifyManifest();
      if (!verification.ok) reasons.push(`doctrine manifest drift: ${[...verification.mismatches, ...verification.missing, ...verification.unexpected].join(',')}`);
      else if (DoctrineService.digest() !== manifest.doctrineDigest) reasons.push('doctrine digest changed since the run was staged');
    } catch (error) {
      reasons.push(`doctrine unavailable: ${(error as Error).message}`);
    }

    for (const entry of manifest.quarantine) {
      const full = path.join(manifest.targetRepo, entry.relativePath);
      if (!fs.existsSync(full)) {
        reasons.push(`quarantined instruction file disappeared during the run: ${entry.relativePath}`);
        continue;
      }
      const actual = sha256(fs.readFileSync(full));
      if (actual !== entry.sha256) reasons.push(`quarantined instruction file changed during the run: ${entry.relativePath}`);
    }

    const nowPresent = listFiles(manifest.targetRepo).filter((rel) => !manifest.quarantine.some((entry) => entry.relativePath === rel));
    for (const rel of nowPresent) reasons.push(`target repository gained an instruction file mid-run: ${rel}`);

    return { ok: reasons.length === 0, reasons };
  }

  /** Proof that the target's instruction content never entered a payload: content must not appear. */
  public static assertNoTargetInstructionContent(manifest: IsolationManifest, payloads: Record<string, string>): void {
    for (const entry of manifest.quarantine) {
      const full = path.join(manifest.targetRepo, entry.relativePath);
      let content = '';
      try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }
      const distinctive = content.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 24);
      for (const [name, payload] of Object.entries(payloads)) {
        for (const line of distinctive) {
          if (payload.includes(line)) throw fail('TARGET_DOCTRINE_LEAKED_INTO_RUN', `${entry.relativePath} content found in ${name}`);
        }
      }
    }
  }
}
