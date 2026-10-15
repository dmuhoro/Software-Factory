/**
 * WP-7 follow-up: repository verification profiles run through the doctrine sandbox (R-14).
 *
 * `POST /api/factory-jobs/:id/verify` reaches `executeVerification`, which must not call
 * `execFileSync` bare — it routes every profile step through `runCommand` with the loop sandbox.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { parseLoopConfig } from '../src/services/doctrineService';
import { isSandboxVisible } from '../src/services/groundTruthService';
import {
  detectVerificationProfile,
  executeVerification,
  verificationStepCommand,
} from '../src/services/verificationProfileService';

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-wp7-verify-'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'verify@test.local']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Verify Test']);
  fs.writeFileSync(path.join(dir, 'probe.cjs'), 'process.exit(0);\n');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'initial']);
  return dir;
}

function doctrineSandbox(overrides: Record<string, unknown> = {}) {
  const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'doctrine', 'loop.json'), 'utf8')) as Record<string, unknown>;
  return parseLoopConfig({ ...raw, sandbox: { ...(raw.sandbox as object), ...overrides } }).sandbox;
}

test('WP-7: executeVerification refuses when the sandbox cannot start', () => {
  const repo = makeRepo();
  const profile = {
    id: 'probe',
    name: 'probe',
    steps: [{ id: 'probe', label: 'node probe.cjs', executable: 'node', args: ['probe.cjs'] }],
    detectedFrom: ['fixture'],
  };
  const execution = executeVerification(repo, profile, 60_000, doctrineSandbox({ bwrapBinary: '/nonexistent/bwrap' }));
  assert.equal(execution.passed, false);
  assert.match(execution.output, /refused|bwrap|not found/i, execution.output);
});

test('WP-7: executeVerification runs profile steps inside the sandbox', () => {
  const repo = makeRepo();
  const profile = detectVerificationProfile(repo);
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { verify: 'node probe.cjs' } }));
  const execution = executeVerification(repo, profile, 60_000, doctrineSandbox());
  assert.equal(execution.passed, true, execution.output);
});

test('WP-7: verificationProfileService does not execute commands outside runCommand', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/services/verificationProfileService.ts'), 'utf8');
  assert.doesNotMatch(source, /execFileSync|spawnSync|spawn\(/);
  assert.match(source, /runCommand/);
});

test('WP-7: verificationStepCommand shell-quotes argv for sh -c', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { verify: "node -e \"process.exit(0)\"" } }));
  const command = verificationStepCommand({ id: 'x', label: 'x', executable: 'npm', args: ['run', "weird'name"] }, repo);
  assert.match(command, /PATH='/);
  assert.match(command, /weird'\\''name/);
});

test('WP-7: the sandboxed verification process does not inherit the ambient environment', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'probe-env.cjs'), "process.stdout.write('CANARY=' + (process.env.SF_LEAK_CANARY || 'absent'));\n");
  const profile = {
    id: 'probe',
    name: 'probe',
    steps: [{ id: 'probe', label: 'node probe-env.cjs', executable: 'node', args: ['probe-env.cjs'] }],
    detectedFrom: ['fixture'],
  };
  process.env.SF_LEAK_CANARY = 'canary-should-never-appear';
  try {
    const execution = executeVerification(repo, profile, 60_000, doctrineSandbox());
    assert.equal(execution.passed, true, execution.output);
    assert.match(execution.output, /CANARY=absent/, 'an ambient credential must not be handed to the verification process');
    assert.doesNotMatch(execution.output, /canary-should-never-appear/);
  } finally {
    delete process.env.SF_LEAK_CANARY;
  }
});

test('WP-7: a sandbox failure names the condition instead of dumping the command line', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'fail.cjs'), 'process.exit(1);\n');
  const profile = {
    id: 'probe',
    name: 'probe',
    steps: [{ id: 'probe', label: 'node fail.cjs', executable: 'node', args: ['fail.cjs'] }],
    detectedFrom: ['fixture'],
  };
  const execution = executeVerification(repo, profile, 60_000, doctrineSandbox());
  assert.equal(execution.passed, false);
  assert.doesNotMatch(execution.output, /--setenv|--ro-bind|Command failed:/, 'the sandbox command line must not be persisted as the failure output');
  assert.match(execution.output, /exited with code 1|produced no output/i, execution.output);
});

test('WP-1: a sandboxed node step resolves a toolchain outside /usr/bin', () => {
  const repo = makeRepo();
  const command = verificationStepCommand({ id: 'x', label: 'node probe.cjs', executable: 'node', args: ['probe.cjs'] }, repo);
  const pathToken = command.match(/^PATH='([^']*)'/);
  assert.ok(pathToken, `the command must lead with a PATH assignment: ${command}`);
  const entries = pathToken![1].split(':');
  assert.ok(entries.includes('/usr/local/bin'), `the sandbox PATH must include /usr/local/bin, where node lives in node:22-slim: ${command}`);
  assert.ok(
    entries.includes(path.dirname(process.execPath)),
    `the sandbox PATH must include the running interpreter's directory so node resolves when it is not under /usr/bin: ${command}`,
  );
});

test('WP-1: a masked sandbox root is never offered as a toolchain directory', () => {
  assert.equal(isSandboxVisible('/home/runner/.nvm/versions/node/v22/bin'), false);
  assert.equal(isSandboxVisible('/tmp/scratch/bin'), false);
  assert.equal(isSandboxVisible('/root/.nvm/bin'), false);
  assert.equal(isSandboxVisible('/usr/local/bin'), true);
  assert.equal(isSandboxVisible('/opt/hostedtoolcache/node/22.22.1/x64/bin'), true);
});
