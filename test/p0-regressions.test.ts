/**
 * Layer 1 regression tests: the P0 defects found in the Phase 1 audit must never come
 * back. Each test names the exploit it forecloses, so a future change that removes a
 * guard fails here with an explanation instead of silently reopening a hole.
 *
 * These are in-process unit tests. They prove the guard logic; the end-to-end HTTP
 * behaviour (real binds, real egress, real restarts) is proven by
 * `npm run verify:layer1`, which must also stay green.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-p0-'));
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-p0-ws-'));
const REPO_ROOT = path.resolve(import.meta.dirname, '..');
process.env.FACTORY_DATA_DIR = DATA_DIR;
process.env.FACTORY_WORKSPACE_ROOT = WORKSPACE;

const { DurableStore } = await import('../src/services/durableStore');
const { resolveWithin, isWithin, workspaceRoot } = await import('../src/utils/pathGuard');
const { validateIncomingTelemetry } = await import('../src/utils/validation');
const { classifyReadiness } = await import('../src/services/healthService');
const { classifyDependencyFailure, OperationalError } = await import('../src/utils/operationalError');

const LEDGER = path.join(DATA_DIR, 'software-factory.json');

/** Drops both the in-memory copy and the file, so a test starts from a known-empty ledger. */
function resetLedger() {
  for (const entry of fs.readdirSync(DATA_DIR)) fs.rmSync(path.join(DATA_DIR, entry), { recursive: true, force: true });
  DurableStore.resetForTests();
}

test('P0-4: paths outside the approved workspace are refused, including traversal and symlinks', () => {
  const root = workspaceRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-outside-'));
  fs.writeFileSync(path.join(outside, '.env'), 'AWS_SECRET_ACCESS_KEY=must-never-be-read');

  for (const candidate of ['/', '/etc', outside, path.join(root, '..', path.basename(outside))]) {
    assert.throws(
      () => resolveWithin(candidate),
      /OUTSIDE_APPROVED_WORKSPACE|PATH_OUTSIDE_APPROVED_WORKSPACE/,
      `expected ${candidate} to be refused`,
    );
  }
  assert.equal(isWithin(root, outside), false);
  assert.equal(isWithin(root, '/'), false);

  // A symlink that points outside must not become a back door.
  const link = path.join(root, 'escape');
  fs.symlinkSync(outside, link);
  assert.throws(() => resolveWithin(link), /OUTSIDE_APPROVED_WORKSPACE|PATH_OUTSIDE_APPROVED_WORKSPACE/);

  // A legitimate in-workspace path must still resolve, or the guard is useless.
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), '{"name":"x"}');
  assert.equal(resolveWithin(project), fs.realpathSync(project));
});

test('P0-2: a corrupt ledger is quarantined, reported, and still writable', () => {
  fs.writeFileSync(LEDGER, '{"version":4,"telemetry":{"a"');
  DurableStore.resetForTests();

  // The store must survive a truncated document instead of throwing at import time.
  // This is the exact condition that previously killed the process before it bound a port.
  assert.deepEqual(DurableStore.list('telemetry'), []);
  assert.equal(DurableStore.isDegraded(), true);

  const recovery = DurableStore.lastRecovery();
  assert.ok(recovery, 'recovery must be recorded');
  assert.equal(recovery.recordsLost, true);
  assert.ok(fs.existsSync(recovery.quarantinedPath), 'the unreadable file must be preserved for audit');
  assert.equal(fs.readFileSync(recovery.quarantinedPath, 'utf8'), '{"version":4,"telemetry":{"a"');

  // Degraded, not broken: writes must still succeed, and twice, to prove the lock is released.
  DurableStore.upsert('telemetry', 'doc_a', { id: 'doc_a', tenantId: 't' });
  DurableStore.upsert('telemetry', 'doc_b', { id: 'doc_b', tenantId: 't' });
  assert.equal(DurableStore.list('telemetry').length, 2);

  // The rewritten ledger must be valid JSON on disk, not merely in memory.
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(LEDGER, 'utf8')));
});

test('P0-2: readiness reports degraded after recovery rather than a fake healthy', () => {
  // Re-corrupt on disk: the previous test already repaired the file, so a reset alone
  // would correctly report a healthy ledger and prove nothing.
  fs.writeFileSync(LEDGER, '{"version":4,"telemetry":{"a"');
  DurableStore.resetForTests();
  const report = classifyReadiness();
  assert.equal(report.status, 'degraded');
  assert.equal(report.checks.durableStore, 'degraded');
  assert.equal(report.details.find((check) => check.name === 'durableStore')?.state, 'warn');
  assert.match(report.details.find((check) => check.name === 'durableStore')?.detail ?? '', /recovered from an unreadable ledger/);
});

test('P0-2: readiness is healthy on an undamaged ledger', () => {
  resetLedger();
  const report = classifyReadiness();
  assert.equal(report.checks.durableStore, 'healthy');
  assert.equal(report.details.find((check) => check.name === 'durableStore')?.state, 'pass');
});

test('P0-4: a refused path is never read, so scanning / cannot hang or leak secrets', () => {
  // resolveWithin must reject on the containment check alone. If any caller could read
  // first and validate later, a scan of / would hang and could exfiltrate file contents.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-slow-'));
  fs.mkdirSync(path.join(outside, 'a'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'a', 'secret.txt'), 'SENSITIVE');
  const started = Date.now();
  assert.throws(() => resolveWithin(outside));
  assert.ok(Date.now() - started < 1000, 'refusal must be immediate, not a slow walk');
});

test('P0-3: production configuration errors are reported, not silently tolerated', async () => {
  const { resolveRuntimeConfig, errorsOf, warningsOf } = await import('../src/configurations/runtimeConfig');
  const saved = { ...process.env };

  // An allowlisted secret that is not set is a configuration error, never an anonymous request.
  process.env.NODE_ENV = 'production';
  process.env.FACTORY_API_KEY = 'probe-key-0123456789abcdef';
  process.env.FACTORY_ALLOWED_SECRET_REFS = 'FACTORY_MISSING_KEY';
  delete process.env.FACTORY_MISSING_KEY;
  let config = resolveRuntimeConfig();
  assert.ok(errorsOf(config).some((issue) => issue.variable === 'FACTORY_ALLOWED_SECRET_REFS'));

  // A mistyped control variable must be reported as inert, so an operator is never
  // misled into believing a permission was granted.
  process.env.FACTORY_ALLOWED_SECRET_REFS = '';
  process.env.FACTORY_ALLOWED_MODEL_HOSTS = 'api.openai.com';
  config = resolveRuntimeConfig();
  assert.ok(warningsOf(config).some((issue) => /not a recognised setting/.test(issue.message)));

  // An explicitly allowlisted secret reference is NOT a typo and must not be flagged.
  process.env.FACTORY_PERMITTED_REF = 'value';
  process.env.FACTORY_ALLOWED_SECRET_REFS = 'FACTORY_PERMITTED_REF';
  config = resolveRuntimeConfig();
  assert.equal(warningsOf(config).some((issue) => issue.variable === 'FACTORY_PERMITTED_REF'), false);

  process.env = saved as NodeJS.ProcessEnv;
});

test('P0-3: the shipped .env.example key satisfies the production key policy check', async () => {
  const { resolveRuntimeConfig, errorsOf, isPlaceholderSecret } = await import('../src/configurations/runtimeConfig');
  const example = fs.readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8');
  const settings = [...example.matchAll(/^(FACTORY_[A-Z_]+)=(.*)$/gm)]
    .map((match) => ({ key: match[1], value: match[2] }))
    .filter((entry) => entry.value.length > 0);

  // Every documented setting must be a setting the code actually reads. If a name is
  // documented but inert, the "unrecognised setting" warning would fire on a correct
  // deployment and train operators to ignore the very warning meant to catch typos.
  const { FACTORY_SETTING_NAMES } = await import('../src/configurations/runtimeConfig');
  for (const entry of settings) {
    const isGrantedSecret = entry.key.endsWith('_API_KEY') || entry.key.endsWith('_SECRET_REF') || entry.key === 'FACTORY_API_KEY';
    assert.ok(
      FACTORY_SETTING_NAMES.has(entry.key) || isGrantedSecret,
      `${entry.key} is documented in .env.example but is not a recognised setting; it would have no effect`,
    );
  }

  // A documented placeholder must be rejected in production even though it is long
  // enough to satisfy a length check, otherwise copying the example file deploys a
  // publicly-known credential.
  for (const entry of settings) {
    if (entry.key === 'FACTORY_API_KEY') {
      assert.ok(entry.value.length >= 24, 'the example key is long enough to pass a naive length check, which is the point');
      assert.equal(isPlaceholderSecret(entry.value), true);
    }
  }
  const config = resolveRuntimeConfig({
    NODE_ENV: 'production',
    FACTORY_API_KEY: 'replace-with-a-long-random-secret',
  } as NodeJS.ProcessEnv);
  assert.ok(errorsOf(config).some((issue) => /known placeholder/.test(issue.message)));

  // A genuine random key must be accepted, or the guard would be useless.
  const accepted = resolveRuntimeConfig({ NODE_ENV: 'production', FACTORY_API_KEY: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' } as NodeJS.ProcessEnv);
  assert.equal(errorsOf(accepted).some((issue) => issue.variable === 'FACTORY_API_KEY'), false);
});

test('known placeholder credentials are rejected however long they are', async () => {
  const { isPlaceholderSecret } = await import('../src/configurations/runtimeConfig');
  for (const value of ['replace-with-a-long-random-secret', 'CHANGEME', 'your-secret-key-here', 'xxxxxxxxxxxxxxxxxxxxxxxxxxxx']) {
    assert.equal(isPlaceholderSecret(value), true, `${value} must be treated as a placeholder`);
  }
  for (const value of ['a1b2c3d4e5f60718293a4b5c6d7e8f90', 'sk-proj-9f3a2b1c8d7e6f5a4b3c2d1e0f9a8b7c']) {
    assert.equal(isPlaceholderSecret(value), false, `${value} must not be treated as a placeholder`);
  }
});

test('ADR-001: idempotencyKey is required, and the composite key is deterministic', () => {
  const withoutKey = validateIncomingTelemetry({
    tenantId: 't1', niche: 'healthcare', eventType: 'x', payload: { patientCohortId: 'C-1' },
  });
  assert.equal(withoutKey.isValid, false);
  assert.match(withoutKey.error?.message ?? '', /idempotencyKey/);

  const blank = validateIncomingTelemetry({
    tenantId: 't1', niche: 'healthcare', eventType: 'x', payload: { patientCohortId: 'C-1' }, metadata: { idempotencyKey: '   ' },
  });
  assert.equal(blank.isValid, false);

  const good = validateIncomingTelemetry({
    tenantId: 't1', niche: 'healthcare', eventType: 'x', payload: { patientCohortId: 'C-1' }, metadata: { idempotencyKey: 'k1' },
  });
  assert.equal(good.isValid, true);

  // The same [tenant_id, idempotency_key] must always resolve to the same document id,
  // and different tenants must never collide on the same key.
  const a = DurableStore.deterministicId('doc_telem', 't1', 'k1');
  assert.equal(a, DurableStore.deterministicId('doc_telem', 't1', 'k1'));
  assert.notEqual(a, DurableStore.deterministicId('doc_telem', 't1', 'k2'));
  assert.notEqual(a, DurableStore.deterministicId('doc_telem', 't2', 'k1'));
});

test('ADR-001: a replayed event does not duplicate, and the replay is reported', async () => {
  resetLedger();
  const { AppwriteService } = await import('../src/services/appwriteService');
  const payload = {
    tenantId: 't1', niche: 'healthcare', eventType: 'x',
    payload: { patientCohortId: 'C-1' }, metadata: { idempotencyKey: 'replay-1' },
  } as never;

  const first = await AppwriteService.recordTelemetryEvent(payload);
  const second = await AppwriteService.recordTelemetryEvent(payload);
  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(second.documentId, first.documentId);
  assert.equal(DurableStore.list('telemetry').length, 1);
});

test('a dependency failure never leaks upstream detail to the client', () => {
  // This is the exact leak observed in the field: the Google SDK puts its whole
  // response body, including credential state, into error.message.
  const upstream = new Error('{"error":{"code":400,"message":"API key not valid.","status":"INVALID_ARGUMENT","domain":"googleapis.com"}}');
  const classified = classifyDependencyFailure(upstream, { rawPayloadPersisted: true, rawDocumentId: 'doc_1' });
  const body = JSON.stringify(classified.toResponse());

  assert.ok(!body.includes('API key not valid'), 'upstream message must not be forwarded');
  assert.ok(!body.includes('INVALID_ARGUMENT'), 'upstream status must not be forwarded');
  assert.ok(!body.includes('googleapis'), 'upstream domain must not be forwarded');
  assert.equal(classified.code, 'ENRICHMENT_DEGRADED');
  assert.equal(classified.status, 503);
  // The durability facts must survive sanitisation, or the caller cannot retry safely.
  assert.equal(classified.rawPayloadPersisted, true);
  assert.equal(classified.rawDocumentId, 'doc_1');
});

test('an open circuit is reported distinctly so a client knows to back off', () => {
  const classified = classifyDependencyFailure(new Error('CircuitBreaker [gemini-structured-engine] is OPEN. Fast-failing to protect downstream systems.'));
  assert.equal(classified.code, 'ENRICHMENT_UNAVAILABLE');
  assert.equal(classified.retryAfterSeconds, 30);
});

test('an OperationalError response is JSON-serialisable and carries no upstream text', () => {
  const error = new OperationalError('LEDGER_UNAVAILABLE', 'The ledger is not writable.', 503, { cause: new Error('EACCES /var/lib/factory'), retryAfterSeconds: 5 });
  const body = JSON.stringify(error.toResponse());
  assert.ok(!body.includes('EACCES'), 'the cause must never be serialised to the client');
  assert.ok(body.includes('LEDGER_UNAVAILABLE'));
  assert.ok(body.includes('"retryable":true'));
});
