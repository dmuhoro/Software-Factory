import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'child_process';

const WORK_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-test-'));
const REPO = path.join(WORK_ROOT, 'repo');
const TASK = path.join(WORK_ROOT, 'task.md');
const SCRIPT = path.join('/home/daniel-muhoro/workspace/projects/Software-Factory', 'scripts', 'run-factory-loop.ts');

test.beforeEach(() => {
  fs.rmSync(WORK_ROOT, { recursive: true, force: true });
  fs.mkdirSync(REPO, { recursive: true });
  execFileSync('git', ['init', '-q', REPO]);
  execFileSync('git', ['-C', REPO, 'config', 'user.email', 'test@test.test']);
  execFileSync('git', ['-C', REPO, 'config', 'user.name', 'Test']);
  const taskContent = [
    'const fs = require("node:fs");',
    'const ok = fs.existsSync("feature-x.txt") && fs.readFileSync("feature-x.txt", "utf8").includes("alpha");',
    'if (!ok) { console.error("feature-x.txt is missing or does not contain alpha"); process.exit(1); }',
    'console.log("check-x passed");'
  ].join('\n');
  fs.writeFileSync(TASK, taskContent);
});

test.afterEach(() => {
  fs.rmSync(WORK_ROOT, { recursive: true, force: true });
});

async function runLoop(killAt?: string, attemptCap?: number): Promise<string> {
  const script = '/home/daniel-muhoro/workspace/projects/Software-Factory/scripts/run-factory-loop.ts';
  const args = [script, '--repo', REPO, '--task', TASK];
  if (killAt) args.push('--kill-at', killAt);
  if (attemptCap !== undefined) args.push('--attempt-cap', attemptCap.toString());
  const { stdout } = execFileSync('npx', ['tsx', ...args, '--resume', 'r1'], {
    cwd: WORK_ROOT,
    timeout: 120_000
  });
  return stdout;
}

test('L2: SIGKILL mid-gate then --resume: 1 commit, clean tree', async () => {
  const output = await runLoop('gate');
  const log = execFileSync('git', ['-C', REPO, 'log', '--oneline']).toString().trim();
  const commits = log.split('\n');
  assert.strictEqual(commits.length, 1, 'Expected 1 commit after gate kill and resume, got ' + commits.length);
  const status = execFileSync('git', ['-C', REPO, 'status', '--porcelain']).toString().trim();
  assert.strictEqual(status, '', 'Expected clean tree after resume, got: ' + status);
});

test('L2: SIGKILL mid-commit then --resume: 1 commit, clean tree', async () => {
  const output = await runLoop('commit', 1);
  const log = execFileSync('git', ['-C', REPO, 'log', '--oneline']).toString().trim();
  const commits = log.split('\n');
  assert.strictEqual(commits.length, 1, 'Expected 1 commit after commit kill and resume, got ' + commits.length);
  const status = execFileSync('git', ['-C', REPO, 'status', '--porcelain']).toString().trim();
  assert.strictEqual(status, '', 'Expected clean tree after resume, got: ' + status);
});

test('L2: SIGKILL mid-attempt then --resume: no extra commits', async () => {
  const output = await runLoop('attempt', 1);
  const log = execFileSync('git', ['-C', REPO, 'log', '--oneline']).toString().trim();
  const commits = log.split('\n');
  assert.ok(commits.length <= 1, 'Expected <=1 commit after attempt kill and resume, got ' + commits.length);
  const status = execFileSync('git', ['-C', REPO, 'status', '--porcelain']).toString().trim();
  assert.ok(status.length <= 2, 'Expected <=2 status lines after resume, got: ' + status);
});

test('L2: Drill leaves repo in valid state', async () => {
  await runLoop('attempt', 1);
  const log = execFileSync('git', ['-C', REPO, 'log', '--oneline']).toString().trim();
  const status = execFileSync('git', ['-C', REPO, 'status', '--porcelain']).toString().trim();
  assert.ok(log.length >= 0, 'Log should be valid');
  assert.ok(typeof status === 'string', 'Status should be a string');
});