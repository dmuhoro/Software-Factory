/**
 * Layer 3, part 1: the error contract.
 *
 * The rule under test is that a message is publishable only if this codebase wrote it.
 * Anything the runtime, the filesystem or a dependency produced is logged, never
 * returned, and the caller gets a correlation id instead.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyApiError, knownDomainErrorCodes, toErrorBody } from '../src/utils/apiError';
import { OperationalError } from '../src/utils/operationalError';

// Every code the service layer actually throws. If a new one is added without a status
// and a written message, it degrades to a 500 and this test fails.
const THROWN_CODES = [
  'AGENT_REPOSITORY_NOT_GIT', 'AGENT_RUN_NOT_FOUND', 'AGENT_TASK_IDS_MUST_BE_UNIQUE', 'AGENT_TASKS_REQUIRED',
  'APPROVAL_ALREADY_DECIDED', 'APPROVAL_NOT_FOUND', 'AUTONOMY_APPROVAL_REQUIRED', 'AUTONOMY_COST_BUDGET_EXCEEDED',
  'AUTONOMY_SESSION_NOT_ACTIVE', 'AUTONOMY_SESSION_NOT_FOUND', 'AUTONOMY_STEP_BUDGET_EXCEEDED',
  'BACKUP_CHECKSUM_MISMATCH', 'BACKUP_FILE_NOT_FOUND', 'BACKUP_NOT_FOUND', 'BUILD_OUTPUT_NOT_FOUND',
  'CLIENT_WORKSPACE_NOT_FOUND', 'COMPLETION_TASK_NOT_FOUND', 'DELIVERY_EVIDENCE_REQUIRED',
  'EXECUTION_MANIFEST_NOT_FOUND', 'EXECUTION_SOURCE_NOT_GIT', 'EXECUTION_SOURCE_OUTSIDE_APPROVED_WORKSPACE',
  'FACTORY_JOB_NOT_FOUND', 'FACTORY_LEDGER_NOT_FOUND', 'FAILURE_NOT_FOUND', 'FILE_PATH_REQUIRED',
  'HANDOVER_NOT_FOUND', 'HOSTED_DEPLOYMENT_APPROVAL_REQUIRED', 'HOSTED_DEPLOYMENT_NOT_FOUND',
  'HOSTED_ROLLBACK_TARGET_NOT_FOUND', 'HOSTED_SOURCE_ARTIFACT_NOT_FOUND', 'HOSTED_TARGET_NOT_FOUND',
  'HOSTED_TARGET_SECRET_REFERENCE_REQUIRED', 'LEDGER_ANOTHER_WRITER_ACTIVE', 'LEDGER_RECORD_ID_REQUIRED',
  'LEDGER_ROOT_NOT_AN_OBJECT', 'MODEL_PROVIDER_BASE_URL_REQUIRED', 'MODEL_PROVIDER_INVALID_RESPONSE',
  'MODEL_PROVIDER_KIND_NOT_RECOGNIZED', 'MODEL_PROVIDER_MODEL_LIST_TOO_LARGE', 'MODEL_PROVIDER_NOT_AVAILABLE',
  'MODEL_PROVIDER_NOT_FOUND', 'MODEL_PROVIDER_REQUEST_TIMEOUT', 'MODEL_PROVIDER_REQUEST_UNSUPPORTED',
  'MODEL_PROVIDER_RESPONSE_TOO_LARGE', 'MODEL_PROVIDER_SECRET_REF_NOT_ALLOWED', 'MODEL_PROVIDER_URL_INVALID',
  'MODEL_PROVIDER_URL_MALFORMED_URL',    'MODEL_PROVIDER_TIMEOUT_OUT_OF_RANGE',
  'OUTCOME_NOTE_REQUIRED', 'PASSED_PROOF_REQUIRES_OBSERVATION', 'PASSED_VERIFICATION_REQUIRED',
  'PATH_DOES_NOT_EXIST', 'PATH_MISSING', 'PATH_NOT_A_DIRECTORY', 'PREVIEW_REQUIRED', 'PROJECT_ID_REQUIRED',
  'PROJECT_NOT_FOUND', 'PROJECT_REPOSITORY_NOT_GIT', 'QUEUE_JOB_NOT_FOUND',
  'READINESS_CRITERION_NOT_RECOGNIZED', 'RELEASE_ENTRYPOINT_NOT_FOUND', 'REPOSITORY_CONTEXT_NOT_FOUND',
  'REPOSITORY_OUTSIDE_APPROVED_WORKSPACE', 'REPOSITORY_SOURCE_NOT_GIT', 'RESOURCE_EXHAUSTED', 'ROLLBACK_TARGET_NOT_FOUND',
  'ROLLBACK_TARGET_UNHEALTHY', 'SANDBOX_ALLOWLIST_REQUIRED', 'SANDBOX_POLICY_NOT_FOUND',
  'SANDBOX_SECRET_REFERENCE_INVALID', 'SANDBOX_SOURCE_NOT_FOUND',
  'SANDBOX_SOURCE_OUTSIDE_APPROVED_WORKSPACE', 'TASK_DOCUMENT_NOT_FOUND', 'TENANT_CONTEXT_REQUIRED', 'WORKTREE_NOT_FOUND',
  'EXECUTION_MODE_UNSUPPORTED', 'GATE_REFUSED', 'HARD_STOP', 'LOOP_RUN_INCOMPATIBLE', 'LOOP_RUN_NOT_FOUND', 'REPO_NOT_CLEAN',
  // Remote control plane (sprint 24).
  'LOOP_REPO_REQUIRED', 'LOOP_REPO_OUTSIDE_WORKSPACE', 'LOOP_REPO_NOT_GIT', 'LOOP_TASK_DOCUMENT_REQUIRED',
  'LOOP_TASK_DOCUMENT_OUTSIDE_WORKSPACE', 'LOOP_RUN_ALREADY_ACTIVE', 'LOOP_GOAL_REQUIRED', 'LOOP_GOAL_DRAFT_INVALID',
  'INVALID_EVIDENCE', 'INVALID_FACTORY_JOB', 'INVALID_PRODUCT_BRIEF', 'INVALID_REPAIR_LOOP',
];

test('L3: every code the service throws has an explicit status and a written message', () => {
  const uncovered: string[] = [];
  const wrongStatus: string[] = [];
  for (const code of THROWN_CODES) {
    const classified = classifyApiError(new Error(code));
    if (classified.code === 'INTERNAL_ERROR') { uncovered.push(code); continue; }
    // A domain condition is a decision about the caller's request or the system's state.
    // None of these is an unexpected internal fault, so none may be reported as 500: that
    // would tell a client the server broke when it did not, and invite a pointless retry.
    if (classified.status === 500) wrongStatus.push(code);
  }
  assert.deepEqual(uncovered, [], `codes that would degrade to a 500: ${uncovered.join(', ')}`);
  assert.deepEqual(wrongStatus, [], `codes reported as 500: ${wrongStatus.join(', ')}`);
});

test('L3: not-found is 404 and policy refusals are 403, not a blanket 409', () => {
  assert.equal(classifyApiError(new Error('PROJECT_NOT_FOUND')).status, 404);
  assert.equal(classifyApiError(new Error('FACTORY_JOB_NOT_FOUND')).status, 404);
  assert.equal(classifyApiError(new Error('REPOSITORY_OUTSIDE_APPROVED_WORKSPACE')).status, 403);
  assert.equal(classifyApiError(new Error('SANDBOX_SOURCE_OUTSIDE_APPROVED_WORKSPACE')).status, 403);
  assert.equal(classifyApiError(new Error('PASSED_VERIFICATION_REQUIRED')).status, 409);
});

test('L3: a dependency or ledger outage is 503 with Retry-After, not a client error', () => {
  const timeout = classifyApiError(new Error('MODEL_PROVIDER_REQUEST_TIMEOUT'));
  assert.equal(timeout.status, 503);
  assert.equal(timeout.retryAfterSeconds, 30);

  const ledger = classifyApiError(new Error('LEDGER_ANOTHER_WRITER_ACTIVE'));
  assert.equal(ledger.status, 503);
  assert.equal(ledger.retryAfterSeconds, 5);

  // A corrupt ledger is the service's problem. Reporting 409 would tell the caller their
  // request conflicted with something, and they would retry a request that cannot succeed.
  const corrupt = classifyApiError(new Error('LEDGER_ROOT_NOT_AN_OBJECT'));
  assert.equal(corrupt.status, 503);
  assert.equal(corrupt.internal, true);
});

test('L3: an unrecognised fault is 500 and does not describe itself', () => {
  const classified = classifyApiError(new TypeError("Cannot read properties of undefined (reading 'tenantId')"));
  assert.equal(classified.status, 500);
  assert.equal(classified.code, 'INTERNAL_ERROR');
  assert.ok(classified.incidentId, 'a correlation id is required so the log stays findable');
  assert.ok(!classified.message.includes('tenantId'), 'the runtime text must not be published');
  const body = JSON.stringify(toErrorBody(classified));
  assert.ok(!body.includes('Cannot read properties'), 'no part of the raw message may be serialised');
});

test('L3: a filesystem error does not disclose the server path layout', () => {
  const fsError = Object.assign(new Error("ENOENT: no such file or directory, open '/var/lib/software-factory/software-factory.json'"), { code: 'ENOENT' });
  const classified = classifyApiError(fsError);
  const body = JSON.stringify(toErrorBody(classified));
  assert.equal(classified.status, 500);
  assert.ok(!body.includes('/var/lib'), 'an absolute path leaked to the caller');
  assert.ok(!body.includes('software-factory.json'), 'a ledger filename leaked to the caller');
});

test('L3: a CODE: detail message resolves by code and discards the invented detail', () => {
  const classified = classifyApiError(new Error('INVALID_FACTORY_JOB: title, problem, and desiredOutcome are required'));
  assert.equal(classified.status, 400);
  assert.equal(classified.code, 'INVALID_FACTORY_JOB');
  assert.ok(!classified.message.includes('desiredOutcome'), 'the call-site sentence must not be the published message');
});

test('L3: an unknown CODE: detail prefix fails closed instead of echoing the detail', () => {
  const classified = classifyApiError(new Error('SOME_INTERNAL_CODE: connection to db-primary.internal:5432 refused'));
  const body = JSON.stringify(toErrorBody(classified));
  assert.equal(classified.status, 500);
  assert.ok(!body.includes('db-primary.internal'), 'an internal hostname leaked');
  assert.ok(!body.includes('5432'), 'an internal port leaked');
});

test('L3: a typed OperationalError keeps its own vetted status and message', () => {
  const upstream = new OperationalError('ENRICHMENT_UNAVAILABLE', 'The enrichment provider is unavailable.', 503, {
    retryAfterSeconds: 12,
    details: { rawPayloadPersisted: true },
  });
  const classified = classifyApiError(upstream);
  assert.equal(classified.code, 'ENRICHMENT_UNAVAILABLE');
  assert.equal(classified.retryAfterSeconds, 12);
  assert.deepEqual(classified.details, { rawPayloadPersisted: true });
});

test('L3: the published message for every known code contains no path or host', () => {
  const suspicious = knownDomainErrorCodes().filter((code) => {
    const { message } = classifyApiError(new Error(code));
    return /(\/etc\/|\/var\/|\/home\/|https?:\/\/|@[a-z0-9.-]+\.(com|internal|local)|:\d{4}\b)/i.test(message);
  });
  assert.deepEqual(suspicious, [], `messages that look like they carry internals: ${suspicious.join(', ')}`);
});

test('L3: every known code has a distinct, non-empty, sentence-shaped message', () => {
  const problems = knownDomainErrorCodes().filter((code) => {
    const { message, code: resolved } = classifyApiError(new Error(code));
    if (resolved !== code) return true;
    if (!message || message === code) return true;
    // A message that is just the code re-published leaks nothing but tells the caller nothing.
    return message.trim().length < 10;
  });
  assert.deepEqual(problems, [], `codes without a usable message: ${problems.join(', ')}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Source-level guards.
//
// The table above was built by grepping for `throw new Error('CODE')`, and that
// grep missed two codes that turned out to matter: PATH_MISSING and
// PROJECT_OUTSIDE_APPROVED_WORKSPACE, because the path guard builds its code from
// a parameter. A coverage list assembled by grep is only as good as the grep, so
// these tests read the source instead and fail if a code or a leak appears that
// the table does not account for.
// ─────────────────────────────────────────────────────────────────────────────

const { readdirSync, readFileSync, statSync } = await import('node:fs');
const { join } = await import('node:path');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const SRC = join(process.cwd(), 'src');
const ALL_SOURCE = sourceFiles(SRC);

test('L3: every path-guard boundary code has a status and a written message', () => {
  // These are passed as `code: '...'` to resolveWithin/resolveFileWithin, so they never
  // appear as a literal in a throw and a grep for thrown codes cannot see them.
  const boundaryCodes = new Set<string>();
  for (const file of ALL_SOURCE) {
    const text = readFileSync(file, 'utf8');
    // Three shapes, because the earlier two missed helper-wrapped throws:
    //   code: 'CODE'                  — an option-based code (the path guard)
    //   throw <helper>('CODE', ...)   — throw fail(...), throw parseError(...)
    //   new Error(`CODE: ...`)        — the direct and helper-body forms
    // The single-quoted `throw new Error('CODE:` and the helper `throw fail('CODE')`
    // shapes were invisible to the first regex, so every loop refusal that used them
    // degraded to INTERNAL_ERROR while this gate stayed green — the same blindness,
    // wearing a new hat, that once hid PATH_MISSING. A gate assembled from a grep is
    // only as good as the grep. Enum members are still deliberately not scanned:
    // 'BUILD' and 'APPROVED' are values, not error codes.
    for (const m of text.matchAll(/code:\s*['`]([A-Z][A-Z0-9_]+)['`]/g)) boundaryCodes.add(m[1]);
    for (const m of text.matchAll(/throw (?:new )?\w+\(['`]([A-Z][A-Z0-9_]+)/g)) boundaryCodes.add(m[1]);
    for (const m of text.matchAll(/new Error\(['`]([A-Z][A-Z0-9_]+)[:`]/g)) boundaryCodes.add(m[1]);
  }
  const uncovered = [...boundaryCodes]
    // INTERNAL_ERROR is the classifier's own fallback literal, not a boundary code.
    .filter((code) => code !== 'INTERNAL_ERROR')
    .filter((code) => classifyApiError(new Error(code)).code === 'INTERNAL_ERROR')
    .sort();
  assert.ok(boundaryCodes.size > 0, 'the scan found no boundary codes, so it is not actually scanning');
  assert.deepEqual(uncovered, [], `boundary codes with no status: ${uncovered.join(', ')}`);
});

test('L3: no route forwards a caught error message into a response', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(join(SRC, 'api'))) {
    const text = readFileSync(file, 'utf8');
    // A log line is the correct place for the raw message; a response body is not.
    for (const line of text.split('\n')) {
      if (/TelemetryLogger|console\.(log|error|warn)/.test(line)) continue;
      if (/\.(json|send)\([^)]*error\??\.message/.test(line) || /code:\s*error\??\.message/.test(line)) {
        offenders.push(`${file.replace(process.cwd(), '.')}: ${line.trim().slice(0, 90)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `routes still echoing a raw error message:\n${offenders.join('\n')}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// The writer lock, and the API 404.
//
// Both of these were claimed protections that did not hold. The lock was
// released at the end of every write, so it was only ever held during the first
// load, and a second process started freely against the same ledger. The
// pre-flight then merely *printed* an unhealthy result and bound a port anyway.
// An unknown /api path was answered by the SPA fallback with 200 and HTML.
// ─────────────────────────────────────────────────────────────────────────────

test('L3: a contended writer is a startup failure, not a warning', async () => {
  const { classifyReadiness } = await import('../src/services/healthService');
  const { DurableStore } = await import('../src/services/durableStore');
  const { mkdirSync, writeFileSync, unlinkSync } = await import('node:fs');
  const previous = process.env.FACTORY_DATA_DIR;
  process.env.FACTORY_DATA_DIR = join(process.cwd(), '.data');
  try {
    DurableStore.resetForTests();
    // Force the load path so the store has actually taken its own lock.
    DurableStore.stats();
    // Now make the lock look like a different, live process holds it. The parent pid is
    // alive by definition, so `process.kill(pid, 0)` succeeds and this is a true positive.
    const lock = `${DurableStore.dataFile()}.lock`;
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, acquiredAt: new Date().toISOString() }));
    try {
      assert.equal(DurableStore.hasContendedWriter(), true, 'the live lock must be detected');
      const report = classifyReadiness();
      assert.equal(report.status, 'unhealthy', 'a contended writer must not be reported as merely degraded');
      assert.equal(report.details.find((check) => check.name === 'durableStore')?.state, 'fail');
    } finally {
      try { unlinkSync(lock); } catch { /* already released */ }
    }
  } finally {
    if (previous === undefined) delete process.env.FACTORY_DATA_DIR; else process.env.FACTORY_DATA_DIR = previous;
    DurableStore.resetForTests();
  }
});

test('L3: the writer lock is held across writes, not released after each one', async () => {
  const { DurableStore } = await import('../src/services/durableStore');
  const { existsSync, unlinkSync } = await import('node:fs');
  const previous = process.env.FACTORY_DATA_DIR;
  process.env.FACTORY_DATA_DIR = join(process.cwd(), '.data');
  try {
    DurableStore.resetForTests();
    DurableStore.stats();
    const lock = `${DurableStore.dataFile()}.lock`;
    assert.ok(existsSync(lock), 'the lock must exist once the store has loaded');
    // Several writes, as separate operations.
    for (let i = 0; i < 3; i += 1) {
      DurableStore.upsert('qualitySnapshots', `locktest-${i}`, { id: `locktest-${i}`, tenantId: 't' });
      assert.ok(existsSync(lock), `the lock was released by write ${i + 1}; the ledger is unprotected between writes`);
    }
    // Releasing is explicit, and only the shutdown/test path does it.
    DurableStore.releaseWriterLock();
    assert.equal(existsSync(lock), false, 'an explicit release must remove the lock');
    try { unlinkSync(lock); } catch { /* already gone */ }
  } finally {
    if (previous === undefined) delete process.env.FACTORY_DATA_DIR; else process.env.FACTORY_DATA_DIR = previous;
    DurableStore.resetForTests();
  }
});
