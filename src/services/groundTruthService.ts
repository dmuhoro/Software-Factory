import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Ground truth.
 *
 * The single most important property of this upgrade: a stage is complete when a command was
 * executed and returned exit code 0 — never when something said it was complete.
 *
 * Everything this module produces is derived from an executed process or from git's own view of
 * the working tree. Narrated claims are accepted as *input* so they can be recorded and
 * discarded; they are never a check, never contribute to `passed`, and are counted so a report
 * can state how much narration was rejected.
 */

export type CheckKind = 'tree' | 'diff' | 'command';
export type CheckId =
  | 'tree:head'
  | 'tree:clean'
  | 'diff:non-empty'
  | 'diff:claimed'
  | 'diff:whitespace'
  | `cmd:${string}`;

export interface GroundTruthCheck {
  id: string;
  kind: CheckKind;
  /** The exact command executed. Absent for checks that read git state directly. */
  command?: string;
  exitCode: number;
  passed: boolean;
  outputDigest?: string;
  outputTail?: string;
  startedAt: string;
  completedAt: string;
}

export interface GroundTruthProof {
  passed: boolean;
  repo: string;
  head: string;
  checks: GroundTruthCheck[];
  claimedFiles: string[];
  observedFiles: string[];
  /** Narration supplied by an implementer or a caller, recorded and discarded. */
  rejectedNarration: string[];
  recordedAt: string;
}

export interface GroundTruthRequest {
  repo: string;
  /** Files the implementer claims to have changed. Each must actually differ from HEAD. */
  claimedFiles?: string[];
  /** Commands to execute. Each becomes its own check with its own exit code. */
  commands?: Array<{ id: string; command: string }>;
  /** Free text supplied by the implementer. Recorded, never trusted. */
  narratedClaims?: string[];
  requireNonEmptyDiff?: boolean;
  /** Asserts the tree is clean — used after a commit, not before. */
  requireCleanTree?: boolean;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

function digest(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function now(): string { return new Date().toISOString(); }

function git(repo: string, args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 30_000, maxBuffer: 4_000_000, stdio: ['ignore', 'pipe', 'pipe'] });
    // Trim trailing whitespace only. `git status --porcelain`'s first column is the
    // index-status char (a leading space for unstaged entries); trimming it corrupts the
    // first line's path in every porcelain consumer.
    return { code: 0, out: (out ?? '').replace(/\s+$/, '') };
  } catch (error: any) {
    const out = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
    return { code: typeof error.status === 'number' ? error.status : 1, out };
  }
}

/** Runs a shell command inside the repository under the loop's scrubbed environment. */
export function runCommand(repo: string, command: string, timeoutMs: number, env?: NodeJS.ProcessEnv): { exitCode: number; output: string; startedAt: string; completedAt: string } {
  const startedAt = now();
  try {
    const out = execFileSync('sh', ['-c', command], {
      cwd: repo,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 4_000_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    return { exitCode: 0, output: (out ?? '').trim(), startedAt, completedAt: now() };
  } catch (error: any) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim().slice(-400_000);
    const exitCode = typeof error.status === 'number' ? error.status : (error.killed ? 124 : 1);
    return { exitCode, output, startedAt, completedAt: now() };
  }
}

function changedPaths(repo: string): string[] {
  const porcelain = git(repo, ['status', '--porcelain']);
  if (porcelain.code !== 0) return [];
  return porcelain.out
    .split('\n')
    .map((line) => line.slice(3).trim())
    .map((entry) => entry.replace(/^.* -> /, ''))
    .filter(Boolean);
}

function check(id: string, kind: CheckKind, exitCode: number, extra: Partial<GroundTruthCheck> = {}): GroundTruthCheck {
  return {
    id,
    kind,
    exitCode,
    passed: exitCode === 0,
    startedAt: extra.startedAt ?? now(),
    completedAt: extra.completedAt ?? now(),
    ...extra,
  };
}

/**
 * Executes every check against the real working tree and returns the proof.
 *
 * `passed` is computed from `checks` alone. There is deliberately no parameter that can make a
 * proof pass without a check passing — that is the hole this module exists to close.
 */
export function collectGroundTruth(request: GroundTruthRequest): GroundTruthProof {
  const repo = path.resolve(request.repo);
  const checks: GroundTruthCheck[] = [];
  const claimedFiles = [...new Set(request.claimedFiles ?? [])];

  const head = git(repo, ['rev-parse', 'HEAD']);
  checks.push(check('tree:head', 'tree', head.code, { outputTail: head.out }));

  const observed = changedPaths(repo);

  if (request.requireCleanTree) {
    const status = git(repo, ['status', '--porcelain']);
    checks.push(check('tree:clean', 'tree', status.code === 0 && status.out === '' ? 0 : 1, {
      outputTail: status.out || '(clean)',
    }));
  }

  if (request.requireNonEmptyDiff) {
    checks.push(check('diff:non-empty', 'diff', observed.length > 0 ? 0 : 1, {
      outputTail: observed.length ? observed.join('\n') : 'working tree is identical to HEAD',
    }));
  }

  for (const claimed of claimedFiles) {
    const absolute = path.join(repo, claimed);
    const exists = fs.existsSync(absolute);
    const differs = observed.includes(claimed);
    checks.push(check(`diff:claimed:${claimed}`, 'diff', exists && differs ? 0 : 1, {
      outputTail: !exists
        ? `claimed file does not exist: ${claimed}`
        : differs
          ? `changed: ${claimed}`
          : `claimed file is unchanged from HEAD: ${claimed}`,
    }));
  }

  const whitespace = git(repo, ['diff', '--check']);
  checks.push(check('diff:whitespace', 'diff', whitespace.code, { outputTail: whitespace.out || '(no whitespace errors)' }));

  for (const step of request.commands ?? []) {
    if (!step.command || !step.command.trim()) {
      checks.push(check(`cmd:${step.id}`, 'command', 1, { command: step.command ?? '', outputTail: 'empty command refused' }));
      continue;
    }
    const result = runCommand(repo, step.command, request.timeoutMs, request.env);
    checks.push(check(`cmd:${step.id}`, 'command', result.exitCode, {
      command: step.command,
      outputDigest: digest(result.output),
      outputTail: result.output.slice(-4000),
      startedAt: result.startedAt,
      completedAt: result.completedAt,
    }));
  }

  const rejectedNarration = (request.narratedClaims ?? []).filter((claim) => typeof claim === 'string' && claim.trim() !== '');

  return {
    passed: checks.every((item) => item.passed),
    repo,
    head: head.out,
    checks,
    claimedFiles,
    observedFiles: observed,
    rejectedNarration,
    recordedAt: now(),
  };
}

/** The statement a commit body must carry: commands actually executed, with their exit codes. */
export function verifiedStatement(proof: GroundTruthProof): string {
  const executed = proof.checks.filter((item) => item.kind === 'command');
  const parts = executed.map((item) => `${item.command} (exit ${item.exitCode})`);
  const diffFiles = proof.observedFiles.length;
  const narration = proof.rejectedNarration.length;
  const statement = [
    `Verified: ${parts.length ? parts.join('; ') : 'no commands declared'}`,
    `Ground truth: ${proof.checks.filter((item) => item.passed).length}/${proof.checks.length} checks passed; diff: ${diffFiles} path(s); head ${proof.head.slice(0, 12)}`,
    narration ? `Narration rejected: ${narration} claim(s) recorded and discarded` : undefined,
  ].filter(Boolean);
  return statement.join('\n');
}

export function proofDigest(proof: GroundTruthProof): string {
  const canonical = proof.checks
    .map((item) => `${item.id}:${item.exitCode}:${item.outputDigest ?? ''}`)
    .sort()
    .join('|');
  return digest(`${proof.head}|${canonical}|${proof.observedFiles.slice().sort().join(',')}`);
}
