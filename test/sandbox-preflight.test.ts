/**
 * The sandbox preflight (Sprint 31, WP-1).
 *
 * Two things are proven here. First, the preflight's own decisions: disabled, unsupported
 * backend, missing binary, unusable binary, and the one case that may say `ok` — after a real
 * unshare succeeds on a host that has bubblewrap. Second, the wiring: the driver refuses to
 * start, and never creates a run, when the sandbox the doctrine enables cannot run.
 *
 * The dependency-injected cases exist so the four failure shapes are proven on any host. The
 * real-bwrap case is guarded, not skipped silently: it runs whenever `bwrap` resolves, which is
 * the condition under which the rest of the loop suite is meaningful anyway.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { preflightSandbox, resolveSandboxBinary } from '../src/services/sandboxPreflightService';
import type { LoopSandboxConfig } from '../src/services/loopTypes';
import { ExecutionLoopService } from '../src/services/executionLoopService';
import { DoctrineService } from '../src/services/doctrineService';
import { classifyApiError } from '../src/utils/apiError';

function config(overrides: Partial<LoopSandboxConfig> = {}): LoopSandboxConfig {
  return {
    enabled: true,
    backend: 'bwrap',
    enableNetwork: false,
    writableDirs: ['.'],
    bwrapBinary: 'bwrap',
    ...overrides,
  };
}

const realBwrap = resolveSandboxBinary('bwrap');

test('preflight: a disabled sandbox needs no container and passes', () => {
  const result = preflightSandbox(config({ enabled: false }));
  assert.equal(result.ok, true);
  assert.equal(result.code, undefined);
});

test('preflight: an unsupported backend is refused by name, with a remediation', () => {
  const result = preflightSandbox(config({ backend: 'docker' }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SANDBOX_BACKEND_UNSUPPORTED');
  assert.ok(result.remediation && result.remediation.length > 0, 'an operator needs the fix');
});

test('preflight: a binary that is not on the host is refused as MISSING', () => {
  const result = preflightSandbox(config({ bwrapBinary: 'bwrap' }), { resolveBinary: () => null });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SANDBOX_BINARY_MISSING');
  assert.match(result.detail, /bwrap/);
});

test('preflight: a binary that is present but cannot unshare is refused as UNUSABLE', () => {
  const result = preflightSandbox(config(), {
    resolveBinary: () => '/usr/bin/bwrap',
    probe: () => { throw Object.assign(new Error('bwrap: setting up uid map: Permission denied'), { stderr: Buffer.from('bwrap: setting up uid map: Permission denied\n') }); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SANDBOX_BINARY_UNUSABLE');
  assert.equal(result.binary, '/usr/bin/bwrap');
  assert.match(result.detail, /Permission denied/, 'the operator detail keeps the real reason');
});

test('preflight: it says ok only after the probe actually ran', () => {
  let probed: string | null = null;
  const result = preflightSandbox(config(), {
    resolveBinary: () => '/opt/sandbox/bwrap',
    probe: (binary) => { probed = binary; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.binary, '/opt/sandbox/bwrap');
  assert.equal(probed, '/opt/sandbox/bwrap', 'ok must be earned by running the probe, not assumed');
});

test('preflight: resolving a binary honours an explicit path and searches PATH for a bare name', () => {
  assert.equal(resolveSandboxBinary('/bin/sh'), '/bin/sh');
  assert.equal(resolveSandboxBinary('/nonexistent/bwrap-does-not-exist'), null);
  const sh = resolveSandboxBinary('sh');
  assert.ok(sh && path.isAbsolute(sh), 'a bare name resolves to an absolute path from PATH');
});

test('preflight: a host with bubblewrap passes the real probe', { skip: realBwrap ? false : 'bwrap is not installed on this host' }, () => {
  const result = preflightSandbox(config());
  assert.equal(result.ok, true, result.detail);
  assert.equal(result.binary, realBwrap);
});

test('the loop refuses to start, before creating a run, when the sandbox cannot run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-preflight-'));
  const originalLoad = DoctrineService.load;
  const loadBound = originalLoad.bind(DoctrineService);
  let runCreated = false;
  // The wiring is the point: drive the real driver, make only the sandbox unusable, and prove
  // it refuses. Pointing bwrapBinary at a path that cannot exist is how a host without
  // bubblewrap presents itself to the preflight.
  (DoctrineService as unknown as { load: typeof DoctrineService.load }).load = () => {
    const doctrine = loadBound();
    return { ...doctrine, loop: { ...doctrine.loop, sandbox: { ...doctrine.loop.sandbox, bwrapBinary: '/nonexistent/sf-bwrap-unusable' } } };
  };
  try {
    await assert.rejects(
      () => ExecutionLoopService.run({
        repo: dir,
        taskDocument: path.join(dir, 'task.md'),
        tenantId: 'default',
        onRunCreated: () => { runCreated = true; },
      }),
      (error: Error) => /SANDBOX_BINARY_MISSING/.test(error.message),
    );
    assert.equal(runCreated, false, 'the run must be refused before it is created');
  } finally {
    (DoctrineService as unknown as { load: typeof DoctrineService.load }).load = originalLoad;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the preflight codes are in the error contract and publish a safe message', () => {
  for (const code of ['SANDBOX_BACKEND_UNSUPPORTED', 'SANDBOX_BINARY_MISSING', 'SANDBOX_BINARY_UNUSABLE']) {
    const classified = classifyApiError(new Error(`${code}: /some/operator/path/that/must/not/leak`));
    assert.equal(classified.code, code, `${code} must not degrade to an internal error`);
    assert.equal(classified.status, 500);
    assert.ok(classified.message.length >= 10);
    assert.ok(!classified.message.includes('/some/'), 'the path-bearing detail must stay in the log');
  }
});
