/**
 * Die-and-resume drills: SIGKILL the real CLI mid-run at three kill points, then resume with
 * `--resume` and prove the run finishes with exactly one commit per unit — no duplicate commit,
 * no corrupted tree, no silent data loss. The final case replays the checkpoints of a run whose
 * commit landed a heartbeat before the checkpoint was persisted: resume must reconcile the
 * dangling commit from HEAD instead of re-committing it.
 *
 * The subject under test is the whole delivery path: the CLI spawns the real driver against a
 * real git repository and a real model port, so a kill at any point exercises the same code an
 * operator would run.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import test from 'node:test';

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-loop-die-'));
process.env.FACTORY_DATA_DIR = path.join(state, 'data');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });

const { DurableStore } = await import('../src/services/durableStore');
const { ExecutionLoopService } = await import('../src/services/executionLoopService');
const { FrontierModelService } = await import('../src/services/frontierModelService');

DurableStore.resetForTests();

const TENANT = 'loop-die';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLI = path.join(ROOT, 'scripts', 'run-factory-loop.ts');

// ── fixtures ───────────────────────────────────────────────────────────────

const CHECK_ALPHA = `const fs = require('node:fs');
const ok = fs.existsSync('feature-a.txt') && fs.readFileSync('feature-a.txt', 'utf8').includes('alpha');
if (!ok) { console.error('feature-a.txt is missing or does not contain alpha'); process.exit(1); }
console.log('check-a passed');
`;

/** A verify command that signals (by touching a file) that it is in flight, then stays busy. */
function gateSleep(marker: string, sleepMs: number): string {
  return `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(marker)}, '');
const end = Date.now() + ${sleepMs};
while (Date.now() < end) {}
const ok = fs.existsSync('feature-a.txt') && fs.readFileSync('feature-a.txt', 'utf8').includes('alpha');
if (!ok) { console.error('feature-a.txt is missing or does not contain alpha'); process.exit(1); }
`;
}

function makeTarget(name: string, extra: { gateSleep?: { check: string; verify: string }; preCommitHook?: string } = {}): string {
  const root = fs.mkdtempSync(path.join(state, `${name}-`));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'loop@example.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Loop Fixture']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, 'check-a.cjs'), CHECK_ALPHA);
  if (extra.gateSleep) fs.writeFileSync(path.join(root, 'gate-sleep-a.cjs'), extra.gateSleep.check);
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'initial']);
  // The hook is installed after the initial commit so it only ever runs on the run's own
  // commits — it is the kill marker, not a fixture of setup.
  if (extra.preCommitHook) fs.writeFileSync(path.join(root, '.git', 'hooks', 'pre-commit'), extra.preCommitHook, { mode: 0o755 });
  return root;
}

function writeTask(name: string, milestone: string): string {
  const file = path.join(state, `${name}-task.md`);
  fs.writeFileSync(file, [
    '# Task: Ship one feature',
    '',
    '## Goal',
    'Commit one independently verified feature without an operator present.',
    '',
    '## Constraints',
    '- No new dependencies',
    '',
    '## Models',
    'models.implementer: stub/stub-code',
    'models.reviewer: stub/stub-code',
    '',
    '## Milestones',
    milestone,
    '',
  ].join('\n'), 'utf8');
  return file;
}

function gitLines(repo: string, args: string[]): string[] {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
}

function porcelain(repo: string): string {
  return execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
}

// ── the model port: a local stub provider ──────────────────────────────────

type Reply = { files: Array<{ path: string; content: string }> };
type ReviewReply = { approved: boolean; findings: string[] };
const REVIEW_MARKER = 'You are the reviewer for an unattended software delivery loop.';

interface Stub {
  url: string;
  prompts: string[];
  close: () => Promise<void>;
}

async function startStub(responder: (prompt: string) => Reply | ReviewReply | Promise<Reply | ReviewReply>): Promise<Stub> {
  const prompts: string[] = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      (async () => {
        try {
          const parsed = JSON.parse(body || '{}') as { messages?: Array<{ content?: string }> };
          const prompt = (parsed.messages ?? []).map((message) => message.content ?? '').join('\n');
          prompts.push(prompt);
          const reply = await responder(prompt);
          // A caller that returns a verdict answers the review itself; the implementer-focused
          // fixtures get a default approval so the loop still advances.
          const wrapped = prompt.includes(REVIEW_MARKER) && 'approved' in reply
            ? reply
            : prompt.includes(REVIEW_MARKER) ? { approved: true, findings: [] } : reply;
          const content = ['```json', JSON.stringify(wrapped), '```'].join('\n');
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ choices: [{ message: { content } }] }));
        } catch (error) {
          response.writeHead(500, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: String(error) }));
        }
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    prompts,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

// ── driving the real CLI as a child process ────────────────────────────────

interface CliHandle {
  kill: (signal: NodeJS.Signals) => void;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  runId: Promise<string>;
  output: () => string;
}

function startCli(args: string[]): CliHandle {
  let child: ReturnType<typeof spawn>;
  let resolveRunId!: (value: string) => void;
  const runId = new Promise<string>((resolve) => { resolveRunId = resolve; });
  // The CLI is launched through node with the tsx loader so it runs as one node process — the
  // `tsx` wrapper spawns its own runner that would survive a kill of the wrapper and finish the
  // run after the test moved on. The child is its own process group so a kill takes the whole
  // tree with it: a SIGKILL mid-`git commit` must not orphan the in-flight git/verify child to
  // race the resume.
  child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  const timer = setInterval(() => {
    const match = output.match(/watch\s+([^\s]+\.events\.jsonl)/);
    if (match) {
      clearInterval(timer);
      resolveRunId(path.basename(match[1]).replace(/\.events\.jsonl$/, ''));
    }
  }, 25);
  // A child that refuses to start (or never prints its stream) must not hang the test: on
  // close without a watch line, hand back an empty id and let the caller assert.
  child.once('close', () => {
    clearInterval(timer);
    if (!output.match(/watch\s+([^\s]+\.events\.jsonl)/)) resolveRunId('');
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
  });

  const killGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-child.pid!, signal);
    } catch {
      child.kill(signal);
    }
  };

  return {
    kill: killGroup,
    exited,
    runId,
    output: () => output,
  };
}

async function waitForFile(file: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!fs.existsSync(file)) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for the kill marker at ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function defer<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

interface DrillSetup {
  repo: string;
  task: string;
  reportDir: string;
  marker: string;
}

interface DrillOptions {
  expectRestore: boolean;
  /** When to SIGKILL the child. Defaults to the marker file appearing. */
  killTrigger?: () => Promise<void>;
  args?: string[];
}

async function runKillThenResume(setup: DrillSetup, options: DrillOptions): Promise<void> {
  const { repo, task, reportDir } = setup;
  const args = options.args ?? ['--repo', repo, '--task', task, '--tenant', TENANT, '--report-dir', reportDir];
  // The test process holds the durable-store writer lock for its whole lifetime. The child is a
  // real second process, so the lock must be surrendered before it starts, exactly as a CLI run
  // would be launched by an operator.
  DurableStore.releaseWriterLock();
  const handle = await startCli(args);
  const runId = await handle.runId;
  assert.ok(runId, `the child never opened an event stream:\n${handle.output()}`);
  const trigger = options.killTrigger ?? (async () => waitForFile(setup.marker));
  await trigger();
  handle.kill('SIGKILL');
  const killed = await handle.exited;
  assert.equal(killed.signal, 'SIGKILL', `expected to SIGKILL the child, got ${killed.signal ?? killed.code}`);

  const beforeResume = gitLines(repo, ['rev-list', '--count', 'HEAD'])[0];
  assert.equal(beforeResume, '1', 'the interrupted run committed nothing before it was killed');

  const resumed = await startCli(['--repo', repo, '--task', task, '--tenant', TENANT, '--report-dir', reportDir, '--resume', runId]);
  const exit = await resumed.exited;
  assert.equal(exit.code, 0, `resume failed: ${resumed.output()}`);

  const finalRecord = JSON.parse(fs.readFileSync(path.join(reportDir, `${runId}.json`), 'utf8')) as {
    status: string;
    commits: unknown[];
    restoredOnResume?: { paths: string[] };
    events: Array<{ level: string; message: string }>;
  };
  assert.equal(finalRecord.status, 'completed', `resumed run is not completed: ${finalRecord.status}`);
  assert.equal(finalRecord.commits.length, 1, 'the resume re-committed an interrupted unit');
  assert.equal(gitLines(repo, ['rev-list', '--count', 'HEAD'])[0], '2', 'initial + exactly one commit for the unit');
  assert.equal(porcelain(repo), '', 'the resumed run left a dirty tree');

  const message = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%B'], { encoding: 'utf8' });
  assert.match(message, /^Unit: M1 \(attempt \d+\)/m);
  assert.match(message, /^Verified: node \S+\.cjs \(exit 0\)/m);
  assert.match(message, /Proof: sha256:/);
  assert.match(message, /AI-Assisted:/);

  if (options.expectRestore) {
    assert.ok(finalRecord.restoredOnResume, 'the resume did not announce the tree it restored');
    assert.ok(
      finalRecord.restoredOnResume!.paths.some((file) => file.includes('feature-a.txt')),
      `the interrupted attempt residue was not restored: ${JSON.stringify(finalRecord.restoredOnResume!.paths)}`,
    );
    assert.ok(finalRecord.events.some((entry) => entry.level === 'warn' && /restored \d+ path\(s\)/.test(entry.message)), 'the resume did not say what it restored');
  } else {
    assert.equal(finalRecord.restoredOnResume, undefined, 'the resume claimed a restore of a tree that was already clean');
  }
}

// ── kill points ────────────────────────────────────────────────────────────

test('SIGKILL while the implementer model call is in flight, then --resume: one commit, clean tree', async () => {
  const marker = path.join(state, 'mid-attempt-marker');
  fs.rmSync(marker, { force: true });
  const repo = makeTarget('mid-attempt');
  const task = writeTask('mid-attempt', `### M1: Feature alpha
type: feat
verify: node check-a.cjs
- [ ] feature-a.txt exists and contains alpha
`);
  const reportDir = fs.mkdtempSync(path.join(state, 'mid-attempt-report-'));

  let firstCall = true;
  const requestInFlight = defer();
  const stub = await startStub((prompt) => {
    if (firstCall && prompt.includes('Unit: M1')) {
      firstCall = false;
      requestInFlight.resolve();
      return new Promise<Reply>((resolve) => setTimeout(() => resolve({ files: [{ path: 'feature-a.txt', content: 'alpha\n' }] }), 6000));
    }
    return { files: [{ path: 'feature-a.txt', content: 'alpha\n' }] };
  });
  FrontierModelService.register({ tenantId: TENANT, id: 'stub', kind: 'local', baseUrl: stub.url, modelIds: ['stub-code'] });
  try {
    // The model call is in flight, so no marker appears: the kill trigger is the HTTP request
    // itself, which this test observes while nothing has been written to the tree yet.
    await runKillThenResume({ repo, task, reportDir, marker }, { expectRestore: false, killTrigger: () => requestInFlight.promise });
  } finally {
    await stub.close();
  }
});

test('SIGKILL while a verification command is running, then --resume: one commit, residue restored', async () => {
  const marker = path.join(state, 'mid-verify-marker');
  fs.rmSync(marker, { force: true });
  const repo = makeTarget('mid-verify', {
    gateSleep: { check: gateSleep(marker, 6000), verify: 'node gate-sleep-a.cjs' },
  });
  const task = writeTask('mid-verify', `### M1: Feature alpha
type: feat
verify: node gate-sleep-a.cjs
- [ ] feature-a.txt exists and contains alpha
`);
  const reportDir = fs.mkdtempSync(path.join(state, 'mid-verify-report-'));

  const stub = await startStub(() => ({ files: [{ path: 'feature-a.txt', content: 'alpha\n' }] }));
  FrontierModelService.register({ tenantId: TENANT, id: 'stub', kind: 'local', baseUrl: stub.url, modelIds: ['stub-code'] });
  try {
    await runKillThenResume({ repo, task, reportDir, marker }, { expectRestore: true });
  } finally {
    await stub.close();
  }
});

test('SIGKILL inside a pre-commit hook, then --resume: one commit, staged residue restored', async () => {
  const marker = path.join(state, 'mid-commit-marker');
  fs.rmSync(marker, { force: true });
  const repo = makeTarget('mid-commit', { preCommitHook: `#!/bin/sh\ntouch '${marker}'\nsleep 4\n` });
  const task = writeTask('mid-commit', `### M1: Feature alpha
type: feat
verify: node check-a.cjs
- [ ] feature-a.txt exists and contains alpha
`);
  const reportDir = fs.mkdtempSync(path.join(state, 'mid-commit-report-'));

  const stub = await startStub(() => ({ files: [{ path: 'feature-a.txt', content: 'alpha\n' }] }));
  FrontierModelService.register({ tenantId: TENANT, id: 'stub', kind: 'local', baseUrl: stub.url, modelIds: ['stub-code'] });
  try {
    await runKillThenResume({ repo, task, reportDir, marker }, { expectRestore: true });
  } finally {
    await stub.close();
  }
});

// ── the checkpoint-lost case ───────────────────────────────────────────────

function recoveredDigest(repo: string): string {
  const message = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%B'], { encoding: 'utf8' });
  const match = message.match(/^Proof: (sha256:[0-9a-f]{64})/m);
  assert.ok(match, 'the commit does not carry a Proof digest');
  return match![1];
}

test('a commit that landed a heartbeat before its checkpoint persisted is reconciled from HEAD, not re-committed', async () => {
  const repo = makeTarget('reconcile');
  const task = writeTask('reconcile', `### M1: Feature alpha
type: feat
verify: node check-a.cjs
- [ ] feature-a.txt exists and contains alpha
`);
  const stub = await startStub(() => ({ files: [{ path: 'feature-a.txt', content: 'alpha\n' }] }));
  FrontierModelService.register({ tenantId: TENANT, id: 'stub', kind: 'local', baseUrl: stub.url, modelIds: ['stub-code'] });
  try {
    const first = await ExecutionLoopService.run({ repo, taskDocument: task, tenantId: TENANT });
    assert.equal(first.exitCode, 0);
    assert.equal(first.record.commits.length, 1);

    // Replay the checkpoint a kill would have left behind: the commit landed, but the final
    // persist died with the process. Revert the durable record to the pre-success snapshot —
    // unit still "running", no commit recorded, no stored proof.
    const stored = DurableStore.get('factoryLoopRuns', first.record.runId) as unknown as {
      status: string;
      hardStop?: string;
      commits: unknown[];
      units: Array<Record<string, unknown>>;
    };
    stored.status = 'halted';
    stored.hardStop = 'test: killed between commit and persist';
    stored.commits = [];
    const unit = stored.units[0];
    unit.status = 'running';
    delete unit.commitSha;
    delete unit.commitSubject;
    delete unit.proofDigest;
    delete unit.proof;
    delete unit.finishedAt;
    const lastAttempt = (unit.attempts as Array<Record<string, unknown>>).at(-1)!;
    lastAttempt.passed = false;
    lastAttempt.reason = '';
    lastAttempt.detail = '';
    DurableStore.upsert('factoryLoopRuns', first.record.runId, stored as Record<string, unknown>);

    const resumed = await ExecutionLoopService.run({ repo, taskDocument: task, tenantId: TENANT, resumeRunId: first.record.runId });
    assert.equal(resumed.exitCode, 0, `resume failed: ${resumed.record.hardStop ?? ''}`);

    const reconciled = resumed.record.units[0];
    assert.equal(reconciled.status, 'done');
    assert.equal(reconciled.attempts.at(-1)?.reason, 'reconciled-on-resume', 'the dangling commit was not reconciled from HEAD');
    assert.equal(resumed.record.commits.length, 1, 'the resume re-committed the dangling commit');
    assert.equal(gitLines(repo, ['rev-list', '--count', 'HEAD'])[0], '2', 'the resume added a second commit for the same unit');
    assert.equal(reconciled.proofDigest, recoveredDigest(repo), 'the reconciled digest does not match the commit on HEAD');
    assert.equal(resumed.record.commits[0].sha, gitLines(repo, ['rev-parse', 'HEAD'])[0]);
    assert.ok(resumed.record.events.some((entry) => /reconciled as done/.test(entry.message)), 'the resume did not announce the reconciliation');
    assert.equal(porcelain(repo), '');
  } finally {
    await stub.close();
  }
});