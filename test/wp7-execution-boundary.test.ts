/**
 * WP-7: the isolated execution boundary is enforced, and refuses escapes.
 *
 * Two claims are on trial here.
 *
 * 1. The doctrine can never disable the sandbox. R-14 says verification commands "run
 *    sandboxed and fail closed; a command that cannot be sandboxed is refused, never run
 *    bare". `parseLoopConfig` used to accept `sandbox.enabled: false`, which would make
 *    `runCommand` fall through to its bare `sh -c` path. It is now refused at the config
 *    boundary.
 *
 * 2. The path-containment checks on the two boundary services decide on REAL paths.
 *    `ExecutionBoundaryService.createManifest` and `SandboxPolicyService.createPolicy` used
 *    to compare `path.resolve` prefixes, which a symlink inside the workspace defeats. They
 *    now route through `pathGuard`, the canonical guard whose own header says a duplicated
 *    prefix check is "a chance to forget symlink resolution".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-wp7-ws-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-wp7-data-'));
process.env.NODE_ENV = 'test';
process.env.FACTORY_DATA_DIR = DATA_DIR;
process.env.FACTORY_WORKSPACE_ROOT = WORKSPACE;
delete process.env.ALLOW_INSECURE_LOCAL;

const { ExecutionBoundaryService } = await import('../src/services/executionBoundaryService');
const { SandboxPolicyService } = await import('../src/services/sandboxPolicyService');
const { parseLoopConfig } = await import('../src/services/doctrineService');
const { resolveWithin, resolveFileWithin } = await import('../src/utils/pathGuard');

function gitRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
}

function doctrineLoop(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'doctrine', 'loop.json'), 'utf8')) as Record<string, unknown>;
}

test('WP-7: a doctrine that disables the sandbox is refused, so the loop can never run bare', () => {
  const raw = doctrineLoop();
  const sandbox = raw.sandbox as Record<string, unknown>;
  sandbox.enabled = false;
  assert.throws(
    () => parseLoopConfig(raw),
    /sandbox:enabled must be true; verification commands are never run bare/,
    'R-14 must be enforced at the config boundary, not left to a caller',
  );
  // Control: the shipped doctrine (enabled true) parses.
  assert.equal(parseLoopConfig(doctrineLoop()).sandbox.enabled, true);
});

test('WP-7: createManifest refuses a source outside the approved workspace', () => {
  const outside = gitRepo(path.join(os.tmpdir(), `factory-wp7-outside-${process.pid}`));
  assert.throws(
    () => ExecutionBoundaryService.createManifest('tenant_wp7', outside),
    /EXECUTION_SOURCE_OUTSIDE_APPROVED_WORKSPACE/,
  );
});

test('WP-7: createManifest refuses a symlink inside the workspace that points outside it', () => {
  const outside = gitRepo(path.join(os.tmpdir(), `factory-wp7-target-${process.pid}`));
  const link = path.join(WORKSPACE, 'escape-link');
  fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync(outside, link, 'dir');
  assert.throws(
    () => ExecutionBoundaryService.createManifest('tenant_wp7', link),
    /EXECUTION_SOURCE_OUTSIDE_APPROVED_WORKSPACE/,
    'a prefix check on the unresolved path would have let this through',
  );
});

test('WP-7: createPolicy refuses a source outside the approved workspace', () => {
  assert.throws(
    () => SandboxPolicyService.createPolicy({ tenantId: 'tenant_wp7', sourcePath: '/home' }),
    /SANDBOX_SOURCE_OUTSIDE_APPROVED_WORKSPACE/,
  );
});

test('WP-7: createPolicy refuses a symlink inside the workspace that points outside it', () => {
  const outside = path.join(os.tmpdir(), `factory-wp7-pol-${process.pid}`);
  fs.mkdirSync(outside, { recursive: true });
  const link = path.join(WORKSPACE, 'policy-escape-link');
  fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync(outside, link, 'dir');
  assert.throws(
    () => SandboxPolicyService.createPolicy({ tenantId: 'tenant_wp7', sourcePath: link }),
    /SANDBOX_SOURCE_OUTSIDE_APPROVED_WORKSPACE/,
  );
});

test('WP-7: pathGuard refuses absolute escapes, traversal, and symlink escapes', () => {
  assert.throws(() => resolveWithin('/etc', { mustExist: false }), /PATH_OUTSIDE_APPROVED_WORKSPACE/);
  assert.throws(() => resolveWithin(path.join(WORKSPACE, '..', '..'), { mustExist: false }), /PATH_OUTSIDE_APPROVED_WORKSPACE/);
  assert.throws(() => resolveFileWithin(WORKSPACE, '../escape.ts'), /FILE_OUTSIDE_REPOSITORY/);
  assert.throws(() => resolveFileWithin(WORKSPACE, '/etc/passwd'), /FILE_OUTSIDE_REPOSITORY/);

  const outside = path.join(os.tmpdir(), `factory-wp7-guard-${process.pid}`);
  fs.mkdirSync(outside, { recursive: true });
  const link = path.join(WORKSPACE, 'guard-escape-link');
  fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync(outside, link, 'dir');
  assert.throws(() => resolveWithin(link, { mustExist: false }), /PATH_OUTSIDE_APPROVED_WORKSPACE/, 'the guard must compare real paths');
});

test('WP-7: ExecutionBoundaryService.run executes only through the sandbox and fails closed', () => {
  const dir = path.join(WORKSPACE, 'sandbox-run');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'wp7', scripts: { verify: 'definitely-not-a-real-tool-wp7' } }));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'wp7@test.local']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'WP7']);
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'init']);

  const manifest = ExecutionBoundaryService.createManifest('tenant_wp7', dir, { timeoutMs: 30000 });
  assert.equal(manifest.network, 'disabled');
  const run = ExecutionBoundaryService.run('tenant_wp7', manifest.id);
  assert.equal(run.passed, false);
  assert.match(run.output, /SANDBOX_TOOLCHAIN_HIDDEN/, 'a bare execFileSync never produces the sandbox refusal');
  assert.equal(run.failedStep, 'verify');
});
