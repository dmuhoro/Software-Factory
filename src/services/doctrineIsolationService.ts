import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DoctrineService } from './doctrineService';

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

export interface QuarantineEntry {
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
}

export const TARGET_INSTRUCTION_FILES = [
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

export const TARGET_INSTRUCTION_DIRS = ['.claude', '.opencode', '.agents', '.cursor', '.rules'] as const;

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
   * Stages isolation for a run against `targetRepo`. Throws — before any work happens — when the
   * doctrine root is unusable, is inside the target repository, or fails its manifest check.
   */
  public static stage(targetRepo: string, extraEnv: Record<string, string> = {}): IsolationManifest {
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
    const digest = DoctrineService.digest();

    const quarantine: QuarantineEntry[] = listFiles(repo).map((relativePath) => {
      const full = path.join(repo, relativePath);
      const buffer = fs.readFileSync(full);
      return { relativePath, sha256: sha256(buffer), bytes: buffer.byteLength, action: 'recorded-not-read' as const };
    });

    return {
      doctrineRoot: root,
      doctrineDigest: digest,
      targetRepo: repo,
      quarantine,
      childEnv: this.childEnv(root, digest, extraEnv),
      stagedAt: new Date().toISOString(),
    };
  }

  /**
   * Re-checks the doctrine manifest and the target's instruction files. Called again at `report`
   * so that a run whose rulebook changed underneath it halts instead of reporting under rules it
   * did not actually follow.
   */
  public static verify(manifest: IsolationManifest): { ok: boolean; reasons: string[] } {
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
