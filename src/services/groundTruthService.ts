import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { LoopSandboxConfig } from './loopTypes';

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
  | 'diff:escape-mangling'
  | 'diff:comment-claim'
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
  /** When enabled, every verification command runs inside the sandbox. Fail-closed. */
  sandbox?: LoopSandboxConfig;
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
export function runCommand(repo: string, command: string, timeoutMs: number, env?: NodeJS.ProcessEnv, sandbox?: LoopSandboxConfig): { exitCode: number; output: string; startedAt: string; completedAt: string } {
  const startedAt = now();
  if (sandbox?.enabled) {
    let argv: string[];
    try {
      const built = sandboxArgv(repo, sandbox, command, env);
      if ('reason' in built) return { exitCode: 1, output: built.reason, startedAt, completedAt: now() };
      argv = built.argv;
    } catch (error) {
      return { exitCode: 1, output: `refused: could not build the sandbox command: ${(error as Error).message}`, startedAt, completedAt: now() };
    }
    const binary = argv[0];
    try {
      const out = execFileSync(binary, argv.slice(1), {
        cwd: repo,
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 4_000_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { exitCode: 0, output: (out ?? '').trim(), startedAt, completedAt: now() };
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        return { exitCode: 1, output: `refused: sandbox binary not found (${binary}); verification commands fail closed when the sandbox cannot start`, startedAt, completedAt: now() };
      }
      const output = `${error?.stdout ?? ''}${error?.stderr ?? ''}`.trim().slice(-400_000) || `sandbox: ${error?.message ?? 'execution failed'}`;
      const exitCode = typeof error?.status === 'number' ? error.status : 1;
      // `sh: 1: <tool>: not found` inside the sandbox is almost always a hidden toolchain, not a
      // typo: the sandbox masks /home, /tmp, /run and /root, so a version-manager node or npm
      // installed under the operator's home is invisible. An opaque exit 127 here once burned a
      // whole attempt cap (sprint 22, finding 5), so it is named at the boundary that observed it.
      if (exitCode === 127) {
        return {
          exitCode,
          output: `SANDBOX_TOOLCHAIN_HIDDEN: a sandboxed verification command could not find its executable (exit 127). The sandbox masks /home, /tmp, /run and /root, so a toolchain installed under your home directory (a version-manager node or npm, for example) is invisible inside it. Use a system binary (/usr/bin) or a repository-local one (node_modules/.bin/…). Shell said: ${output}`,
          startedAt,
          completedAt: now(),
        };
      }
      return { exitCode, output, startedAt, completedAt: now() };
    }
  }
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

/** Build the bubblewrap invocation for a verification command. Refuses, does not warn. */
function sandboxArgv(repo: string, sandbox: LoopSandboxConfig, command: string, env?: NodeJS.ProcessEnv): { ok: true; argv: string[] } | { ok: false; reason: string } {
  const repoPath = path.resolve(repo);
  if (sandbox.backend !== 'bwrap') {
    return { ok: false, reason: `refused: sandbox backend "${sandbox.backend}" is not supported; only bwrap is accepted` };
  }

  const argv: string[] = [
    sandbox.bwrapBinary,
    '--unshare-user-try', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup',
    ...(sandbox.enableNetwork ? [] : ['--unshare-net']),
    '--die-with-parent', '--new-session',
    // The container root, read-only. Must stay BEFORE the fresh /proc and /dev mounts
    // below: bubblewrap applies mounts in order and the last mount at a path wins. If the
    // ro-bind of `/` comes last it shadows the fresh procfs with the host's read-only
    // /proc, which would expose the entire host process table (and their cmdlines) to a
    // verification command. The fixed order exposes only the container's own processes.
    '--ro-bind', '/', '/',
    '--tmpfs', '/tmp',
    '--tmpfs', '/run',
    '--tmpfs', '/home',
    '--tmpfs', '/root',
    '--dev', '/dev',
    '--proc', '/proc',
  ];

  for (const relative of sandbox.writableDirs ?? []) {
    const resolved = path.resolve(repoPath, relative);
    if (resolved !== repoPath && !resolved.startsWith(`${repoPath}${path.sep}`)) {
      return { ok: false, reason: `refused: sandbox writableDirs may not escape the repository: ${relative}` };
    }
    argv.push('--bind', resolved, resolved);
  }
  argv.push('--bind', repoPath, repoPath);

  argv.push('--clearenv');
  argv.push('--setenv', 'HOME', '/tmp/loop');
  argv.push('--setenv', 'PATH', env?.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
  for (const [key, value] of Object.entries(env ?? {})) {
    if (key === 'PATH' || key === 'HOME') continue;
    argv.push('--setenv', key, value);
  }
  argv.push('--chdir', repoPath, 'sh', '-c', command);
  return { ok: true, argv };
}

function changedPaths(repo: string): string[] {
  // `--untracked-files=all` is load-bearing, not cosmetic. Plain `git status --porcelain`
  // collapses an untracked directory to a single `?? dir/` entry, so a unit that creates a new
  // file inside a new directory — an ordinary thing to do — reports the directory and the
  // `claimed-files-exist` gate then refuses the unit with "claimed file is unchanged from HEAD"
  // even though the file is present and new. The gate must see the file it was told about.
  const porcelain = git(repo, ['status', '--porcelain', '--untracked-files=all']);
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
 * Finding (c) of sprint 22: comment truth was outside every gate. The loop's M2 commit put a
 * comment claiming the empty string directly above `tenantId: 'default'`; the greps check code,
 * the reviewer checks intent, and nobody checked the comment. Operator remediation f32dde2.
 *
 * This is not a natural-language claim verifier, and it does not pretend to be one. It is one
 * mechanical falsity: a comment this change *added* that names a value — a quoted literal or
 * the words "empty string" — where the next code lines below it use a string literal and none
 * of them equals the named value. Scope is stated in the pass output: only comments added by
 * this change are judged, and only files with a HEAD baseline are examined.
 */
const COMMENT_LINE = /^\s*(\/\/|#|\/\*|\*|--|<!--)/;

function literalsIn(text: string): string[] {
  const values: string[] = [];
  for (const match of text.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`\n]*)`/g)) {
    values.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return values;
}

function commentClaimFindings(repo: string, observed: string[]): { findings: string[]; commentsChecked: number } {
  const findings: string[] = [];
  let commentsChecked = 0;
  for (const relative of observed) {
    const diff = git(repo, ['diff', '--no-color', '--unified=0', 'HEAD', '--', relative]);
    if (diff.code !== 0 || !diff.out.trim()) continue;
    // Only comments this change *added* are judged; a pre-existing comment is not this
    // run's claim. The annotated line is read from the working tree, because a false
    // comment is usually added next to code that already existed — the real M2 case was a
    // one-line comment change above an unchanged `tenantId: 'default'`.
    const addedComments: number[] = [];
    let newLine = 0;
    for (const raw of diff.out.split('\n')) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (hunk) { newLine = Number(hunk[1]); continue; }
      if (raw.startsWith('+++') || raw.startsWith('---')) continue;
      if (raw.startsWith('+')) { if (COMMENT_LINE.test(raw.slice(1))) addedComments.push(newLine); newLine += 1; continue; }
      if (raw.startsWith(' ')) { newLine += 1; continue; }
    }
    if (addedComments.length === 0) continue;
    let lines: string[];
    try {
      lines = fs.readFileSync(path.join(repo, relative), 'utf8').split(/\r?\n/);
    } catch {
      continue;
    }
    for (const lineNo of addedComments) {
      const comment = lines[lineNo - 1] ?? '';
      commentsChecked += 1;
      const claimed = new Set<string>(literalsIn(comment));
      if (/empty[-\s]?string/i.test(comment)) claimed.add('');
      if (!claimed.size) continue;
      let codeLine: string | undefined;
      let scanned = 0;
      for (let index = lineNo; index < lines.length && scanned < 3; index += 1) {
        const text = lines[index];
        if (!text.trim() || COMMENT_LINE.test(text)) continue;
        scanned += 1;
        if (literalsIn(text).length > 0) { codeLine = text; break; }
      }
      if (codeLine === undefined) continue;
      const actual = literalsIn(codeLine);
      if ([...claimed].some((value) => actual.includes(value))) continue;
      const said = [...claimed].map((value) => (value === '' ? 'the empty string' : JSON.stringify(value))).join(' or ');
      const used = actual.map((value) => (value === '' ? "''" : JSON.stringify(value))).join(', ') || 'no string literal';
      findings.push(`${relative}:${lineNo}: the comment names ${said}, but the annotated line uses ${used}`);
      if (findings.length >= 20) return { findings, commentsChecked };
    }
  }
  return { findings, commentsChecked };
}

/**
 * Finds the corruption a re-emitting model produces: two HEAD lines fused into one by a
 * literal backslash-n (or backslash-r) escape instead of a real newline.
 *
 * The mechanical signature, because a judge must not guess: a changed line carries a literal
 * escape whose left and right context both appear in HEAD separated by a real line break —
 * the escape stands exactly where git holds a newline. Lines reproduced verbatim from HEAD
 * are the model faithfully copying content, not mangling it. Files with no HEAD baseline
 * (new or renamed) cannot be judged and are named in the pass output so the scope is honest.
 */
function escapeManglingFindings(repo: string, observed: string[]): { findings: string[]; compared: number } {
  const findings: string[] = [];
  let compared = 0;
  for (const relative of observed) {
    const absolute = path.join(repo, relative);
    if (!fs.existsSync(absolute)) continue;
    const head = git(repo, ['show', `HEAD:${relative}`]);
    if (head.code !== 0) continue;
    let raw: Buffer;
    try {
      raw = fs.readFileSync(absolute);
    } catch {
      continue;
    }
    if (raw.includes(0)) continue;
    compared += 1;
    const headText = head.out;
    const lines = raw.toString('utf8').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!/\\r\\n|\\[rn]/.test(line)) continue;
      if (headText.includes(line)) continue;
      const escapes = /\\r\\n|\\[rn]/g;
      let escape: RegExpExecArray | null;
      while ((escape = escapes.exec(line)) !== null) {
        const before = line.slice(Math.max(0, escape.index - 80), escape.index);
        const after = line.slice(escape.index + escape[0].length, escape.index + escape[0].length + 80);
        if (!before || !after) continue;
        if (headText.includes(`${before}\n${after}`) || headText.includes(`${before}\r\n${after}`)) {
          findings.push(`${relative}:${index + 1}: literal ${escape[0]} stands where HEAD holds a real line break (HEAD ends: ${JSON.stringify(before.slice(-40))}; begins: ${JSON.stringify(after.slice(0, 40))})`);
          break;
        }
      }
      if (findings.length >= 20) return { findings, compared };
    }
  }
  return { findings, compared };
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

  const mangling = escapeManglingFindings(repo, observed);
  checks.push(check('diff:escape-mangling', 'diff', mangling.findings.length ? 1 : 0, {
    outputTail: mangling.findings.length
      ? mangling.findings.join('\n').slice(0, 4000)
      : `no literal escape reconstructs a real line break HEAD holds; ${mangling.compared} changed file(s) with a HEAD baseline compared`,
  }));

  const claims = commentClaimFindings(repo, observed);
  checks.push(check('diff:comment-claim', 'diff', claims.findings.length ? 1 : 0, {
    outputTail: claims.findings.length
      ? claims.findings.join('\n').slice(0, 4000)
      : `no added comment names a value its annotated line does not use; ${claims.commentsChecked} comment(s) examined, files with no HEAD baseline not judged`,
  }));

  for (const step of request.commands ?? []) {
    if (!step.command || !step.command.trim()) {
      checks.push(check(`cmd:${step.id}`, 'command', 1, { command: step.command ?? '', outputTail: 'empty command refused' }));
      continue;
    }
    const result = runCommand(repo, step.command, request.timeoutMs, request.env, request.sandbox);
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

/**
 * Finding (b) of sprint 22: a command that fails must reach the next attempt with the same kind
 * of locator the diff checks already carry. A failed diff check's detail was enriched with its
 * output tail, but a failed *command* still arrived as `cmd:unit-M1 exit 1` -- the output tail
 * is up to 4000 characters of compiler or test log, and the operator's (and the model's) first
 * move is to find the `file:line`. This extracts those locator lines, de-duplicated and bounded,
 * covering the three shapes seen in the wild: `file.ext:12:3:`, `file.ext(12,3):` (TypeScript),
 * and node stack frames `at fn (file.ext:12:3)`.
 */
const LOCATOR_PATTERNS: readonly RegExp[] = [
  /(?:^|[\s("'])([\w./-]+\.[A-Za-z0-9]+):(\d+)(?::(\d+))?/,
  /(?:^|[\s("'])([\w./-]+\.[A-Za-z0-9]+)\((\d+),(\d+)\)/,
];

export function extractLocators(outputTail: string, limit = 6): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const raw of outputTail.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    for (const pattern of LOCATOR_PATTERNS) {
      const match = pattern.exec(line);
      if (!match) continue;
      const locator = match[0].replace(/^[\s("']/, '').slice(0, 200);
      if (!seen.has(locator)) {
        seen.add(locator);
        found.push(locator);
      }
      break;
    }
    if (found.length >= limit) break;
  }
  return found;
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
