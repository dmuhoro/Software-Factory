import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { GroundTruthProof, verifiedStatement, proofDigest } from './groundTruthService';
import { ModelAssignment } from './doctrineService';

/**
 * Commit boundary.
 *
 * Nothing reaches git unless a ground-truth proof says the working tree is what was claimed and
 * every declared command exited 0. The message then states *what was verified*, not what was
 * attempted, so `git log` alone answers "how do I know this is true?".
 *
 * Two refusals sit in front of the commit: credential-shaped content in the staged diff, and
 * credential-shaped paths. Both fail closed, and both unstage the tree rather than discard it.
 */

export interface CommitRequest {
  repo: string;
  type: string;
  scope: string;
  title: string;
  proof: GroundTruthProof;
  unitId: string;
  attempt: number;
  models: ModelAssignment[];
  loopVersion: string;
  refusePathPatterns: string[];
  requireGroundTruth: boolean;
  requireProvenanceFooter: boolean;
  subjectMaxLength: number;
}

export interface CommitResult {
  sha: string;
  subject: string;
  message: string;
  files: string[];
}

/** Patterns that make a diff or a path a credential. Deliberately broad: refusal is the safe answer. */
export const SECRET_DIFF_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{30,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /AIza[0-9A-Za-z_-]{30,}/,
  /eyJhbGciOi[A-Za-z0-9_-]{10,}[.][A-Za-z0-9_-]{10,}/,
  /(?:api[_-]?key|secret|password|passwd|token)["']?\s*[:=]\s*["'][^"'\s]{16,}["']/i,
];

function fail(code: string, detail?: string): Error {
  return new Error(detail ? `${code}:${detail}` : code);
}

function git(repo: string, args: string[], options: { input?: string } = {}): string {
  try {
    const out = execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 8_000_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(options.input !== undefined ? { input: options.input } : {}),
    });
    return (out ?? '').trim();
  } catch (error: any) {
    const detail = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
    throw fail('GIT_COMMAND_FAILED', `git ${args.join(' ')} -> ${detail.slice(-500)}`);
  }
}

function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, (char) => `\\${char}`);
}

function globSegment(segment: string): string {
  return segment
    .split('?')
    .map((part) => part.split('*').map(escapeLiteral).join('[^/]*'))
    .join('[^/]');
}

/**
 * Tiny glob: `*` and `?` inside one path segment, `**` across segments.
 * `**​/.env*` matches `.env` at the root as well as `config/.env`, the way gitignore treats it.
 */
export function pathMatchesPattern(file: string, pattern: string): boolean {
  const source = pattern
    .split('**/')
    .map((part) => part.split('**').map(globSegment).join('.*'))
    .join('(?:.*/)?');
  return new RegExp(`^${source}$`).test(file);
}

function stagedPaths(repo: string): string[] {
  const out = git(repo, ['diff', '--cached', '--name-only']);
  if (!out) return [];
  return out.split('\n').map((line) => line.trim()).filter(Boolean);
}

function assertNoSecretPaths(files: string[], patterns: string[]): void {
  for (const file of files) {
    for (const pattern of patterns) {
      if (pathMatchesPattern(file, pattern) || pathMatchesPattern(path.basename(file), pattern)) {
        throw fail('SECRET_PATH_REFUSED', `${file} matches ${pattern}`);
      }
    }
  }
}

function assertNoSecretContent(repo: string, files: string[]): void {
  const diff = git(repo, ['diff', '--cached']);
  for (const pattern of SECRET_DIFF_PATTERNS) {
    if (pattern.test(diff)) throw fail('SECRET_CONTENT_REFUSED', `staged diff matches ${pattern}`);
  }
  // Untracked files are staged above, so `--cached` covers them; this second pass reads the
  // staged blob directly so a binary or very large add cannot slip past the diff view.
  for (const file of files) {
    let content = '';
    try {
      content = git(repo, ['show', `:${file}`]);
    } catch {
      continue;
    }
    for (const pattern of SECRET_DIFF_PATTERNS) {
      if (pattern.test(content)) throw fail('SECRET_CONTENT_REFUSED', `${file} matches ${pattern}`);
    }
  }
}

export function slugify(value: string, max: number): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (slug || 'change').slice(0, Math.max(8, max));
}

/**
 * Stages the working tree and scans what it staged for credential-shaped paths and content.
 *
 * Exported because the `secret-scan` hook runs this *before* the commit gate so a refusal is
 * observed at its own stage, and `commitUnit` runs it again so the check cannot be skipped by
 * reaching the commit through another path. `unstage()` puts the index back exactly as it found
 * it for the paths this call staged — an operator's own staged work is never touched.
 */
export function stageAndScanSecrets(repo: string, refusePathPatterns: string[]): { files: string[]; unstage: () => void } {
  const target = path.resolve(repo);
  const stagedBefore = new Set(stagedPaths(target));
  git(target, ['add', '-A']);
  const files = stagedPaths(target);
  const unstage = (): void => {
    for (const file of files) {
      if (!stagedBefore.has(file)) git(target, ['reset', '-q', '--', file]);
    }
  };
  try {
    assertNoSecretPaths(files, refusePathPatterns);
    assertNoSecretContent(target, files);
  } catch (error) {
    // An unstage is not a discard: the work stays on disk and the refusal is the record.
    unstage();
    throw error;
  }
  return { files, unstage };
}

export function buildCommitMessage(request: CommitRequest, files: string[]): { subject: string; message: string } {
  const scope = request.scope.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'factory';
  const type = /^[a-z]+$/.test(request.type) ? request.type : 'feat';
  const subjectBudget = Math.max(8, request.subjectMaxLength - type.length - scope.length - 4);
  const subject = `${type}(${scope}): ${slugify(request.title, subjectBudget)}`;

  const lines: string[] = [subject, '', verifiedStatement(request.proof), ''];
  lines.push(`Unit: ${request.unitId} (attempt ${request.attempt})`);
  lines.push(`Files: ${files.length}`);
  lines.push(`Proof: ${proofDigest(request.proof)}`);
  if (request.requireProvenanceFooter) {
    lines.push('');
    const models = request.models.map((model) => `${model.role}=${model.providerId}/${model.model}`).join(', ');
    lines.push(`AI-Assisted: ${models}; loop=software-factory/${request.loopVersion}`);
  }
  return { subject, message: `${lines.join('\n')}\n` };
}

export function commitUnit(request: CommitRequest): CommitResult {
  const repo = path.resolve(request.repo);
  if (request.requireGroundTruth && !request.proof.passed) {
    throw fail('GROUND_TRUTH_REQUIRED', `refusing to commit unit ${request.unitId}: ${request.proof.checks.filter((item) => !item.passed).length} check(s) failed`);
  }

  const { files, unstage } = stageAndScanSecrets(repo, request.refusePathPatterns);
  if (!files.length) throw fail('NOTHING_STAGED', `unit ${request.unitId} produced no change`);

  const { subject, message } = buildCommitMessage(request, files);

  let identity: string[] = [];
  try {
    git(repo, ['config', 'user.email']);
    git(repo, ['config', 'user.name']);
  } catch {
    // A repository with no identity gets one from the flag, never by writing to its config.
    identity = ['-c', 'user.name=Software Factory Loop', '-c', 'user.email=loop@software-factory.local'];
  }

  execFileSync('git', ['-C', repo, ...identity, 'commit', '-F', '-'], {
    input: message,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 8_000_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const sha = git(repo, ['rev-parse', 'HEAD']);
  const committed = git(repo, ['show', '--name-only', '--format=', 'HEAD'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return { sha, subject, message, files: committed };
}

export function readLoopVersion(): string {
  let dir = process.cwd();
  for (let depth = 0; depth < 12; depth += 1) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
      if (parsed.name === 'software-factory' && typeof parsed.version === 'string' && parsed.version) return parsed.version;
    } catch {
      // keep walking toward the factory root
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '0.0.0';
}
