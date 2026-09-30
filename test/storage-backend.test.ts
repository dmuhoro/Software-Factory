/**
 * STORAGE_BACKEND selection.
 *
 * These tests exercise the seam the four production call sites actually use (`AppwriteService`,
 * which delegates to `resolveTelemetryStore`), not the store classes in isolation. A test of
 * `AppwriteTelemetryStore` alone would prove nothing about whether a customer request reaches it,
 * which is the failure mode this repository was hardened against.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const VALID_ENV = {
  APPWRITE_ENDPOINT: 'https://fra.cloud.appwrite.io/v1',
  APPWRITE_PROJECT_ID: 'a1b2c3d4e5f6a7b8c9d0',
  APPWRITE_API_KEY: `standard_${'0123456789abcdef'.repeat(8)}`,
  APPWRITE_DATABASE_ID: 'b2b_software_factory',
} as NodeJS.ProcessEnv;

test('STORAGE_BACKEND defaults to the offline local store', async () => {
  const { resolveStorageBackend } = await import('../src/services/telemetryStore');
  assert.equal(resolveStorageBackend(undefined), 'local', 'unset means local, so offline keeps working');
  assert.equal(resolveStorageBackend(''), 'local', 'empty means local');
  assert.equal(resolveStorageBackend('local'), 'local');
  assert.equal(resolveStorageBackend('  LOCAL  '), 'local', 'case and whitespace are not a typo');
});

test('an unrecognised STORAGE_BACKEND refuses instead of falling back', async () => {
  const { resolveStorageBackend } = await import('../src/services/telemetryStore');
  // This is the whole point of the control. `appwirte` silently becoming `local` would mean a
  // process that believes it is writing to Appwrite writes to a local file nobody monitors, and
  // the mismatch is discovered by a customer rather than by an alert.
  // Note `'Appwrite '` is deliberately absent: a trailing space from copy-paste is tolerated, and
  // refusing it would train operators to work around the validator. A *wrong word* is refused.
  for (const bad of ['appwirte', 'aws', 'postgres', 'true', '1', 'cloud', 'local2', 'appwrite2']) {
    assert.throws(
      () => resolveStorageBackend(bad),
      /STORAGE_BACKEND must be/,
      `"${bad}" must be refused, not silently treated as local`,
    );
  }
});

test('startup validation rejects a bad STORAGE_BACKEND as an error, not a warning', async () => {
  const { resolveRuntimeConfig } = await import('../src/configurations/runtimeConfig');
  const bad = resolveRuntimeConfig({
    NODE_ENV: 'production', FACTORY_API_KEY: 'x'.repeat(40), STORAGE_BACKEND: 'appwirte',
  } as NodeJS.ProcessEnv);
  const issue = bad.issues.find((i: { variable: string }) => i.variable === 'STORAGE_BACKEND');
  assert.ok(issue, 'the banner must surface an invalid STORAGE_BACKEND');
  assert.equal((issue as { severity: string }).severity, 'error', 'a typo in the backend is an error, never a warning');
});

test('the startup banner states which store is actually in use', async () => {
  const { resolveRuntimeConfig, describeConfig } = await import('../src/configurations/runtimeConfig');
  const config = resolveRuntimeConfig({
    NODE_ENV: 'production', FACTORY_API_KEY: 'x'.repeat(40), STORAGE_BACKEND: 'appwrite', ...VALID_ENV,
  } as NodeJS.ProcessEnv);
  const banner = describeConfig(config);
  assert.match(banner, /storage\s+appwrite/, 'an operator must be able to see the backend in the banner');
  // The reverse: with nothing configured, the banner must say local, not omit the line.
  const localBanner = describeConfig(resolveRuntimeConfig({
    NODE_ENV: 'production', FACTORY_API_KEY: 'x'.repeat(40),
  } as NodeJS.ProcessEnv));
  assert.match(localBanner, /storage\s+local/, 'the default must be stated, never implied by absence');
});

test('the facade resolves the local backend and the local store is the default path', async () => {
  const { resetTelemetryStore } = await import('../src/services/telemetryStore');
  const { AppwriteService } = await import('../src/services/appwriteService');
  resetTelemetryStore();
  const previous = process.env.STORAGE_BACKEND;
  try {
    process.env.STORAGE_BACKEND = 'local';
    resetTelemetryStore();
    assert.equal(AppwriteService.activeBackend(), 'local');
  } finally {
    if (previous === undefined) delete process.env.STORAGE_BACKEND; else process.env.STORAGE_BACKEND = previous;
    resetTelemetryStore();
  }
});

test('selecting the Appwrite backend with no credentials fails closed, at selection time', async () => {
  const { resolveTelemetryStore, resetTelemetryStore } = await import('../src/services/telemetryStore');
  const { AppwriteService } = await import('../src/services/appwriteService');
  const previous = process.env.STORAGE_BACKEND;
  // Remove every Appwrite variable so `requireAppwriteConfig` must refuse.
  const saved = Object.fromEntries(Object.keys(VALID_ENV).map((k) => [k, process.env[k]]));
  try {
    for (const k of Object.keys(VALID_ENV)) delete process.env[k];
    process.env.STORAGE_BACKEND = 'appwrite';
    resetTelemetryStore();
    assert.throws(
      () => AppwriteService.activeBackend(),
      /APPWRITE_|placeholder|Appwrite/i,
      'an appwrite backend with no credentials must refuse to start rather than write nowhere',
    );
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (previous === undefined) delete process.env.STORAGE_BACKEND; else process.env.STORAGE_BACKEND = previous;
    resetTelemetryStore();
  }
});

test('the local backend really is a different object from the Appwrite one', async () => {
  // Guards against a refactor that quietly routes both backends to the same implementation, which
  // would make `STORAGE_BACKEND=appwrite` a label on a local write.
  const { LocalTelemetryStore, AppwriteTelemetryStore } = await import('../src/services/telemetryStore');
  assert.equal(new LocalTelemetryStore().name, 'local');
  assert.notEqual(LocalTelemetryStore, AppwriteTelemetryStore);
  assert.equal(AppwriteTelemetryStore.prototype.constructor.name, 'AppwriteTelemetryStore');
});

const notFoundError = () => Object.assign(new Error('Row not found'), { code: 404 });

const appwriteSettings = {
  endpoint: 'https://example.invalid', projectId: 'p', apiKey: 'k'.repeat(40), databaseId: 'db',
  collections: {
    tenants: 'tenants', telemetryEvents: 'telemetry_events',
    aiTransformations: 'ai_transformations', auditLogs: 'audit_logs',
  },
  limits: { retryAttempts: 1 },
} as never;

const strangerEvent = (tenantId: string) => ({
  tenantId, niche: 'CustomB2B', eventType: 'LEAD_CREATED',
  timestamp: new Date().toISOString(), payload: {},
  metadata: { idempotencyKey: 'k1', sourceSystem: 'test', region: 'fra', clientVersion: '0' },
} as never);

test('the Appwrite backend refuses an event for a tenant that was never onboarded', async () => {
  // The orphan-write hole: telemetry_events has a tenantId column but Appwrite has no foreign key,
  // so a row for a tenant that does not exist is well-formed and passes every shape check while
  // referring to nothing. The store is the enforcement point, so it is tested here directly.
  const { AppwriteTelemetryStore } = await import('../src/services/telemetryStore');
  const { OperationalError } = await import('../src/utils/operationalError');

  const created: string[] = [];
  const services = {
    tables: {
      getRow: async () => { throw notFoundError(); },
      createRow: async (args: { rowId: string }) => { created.push(args.rowId); return { $id: args.rowId }; },
      createExecution: async () => ({ $id: 'exec_1' }),
    },
  } as never;

  const store = new AppwriteTelemetryStore(appwriteSettings, services);
  await assert.rejects(
    () => store.recordTelemetryEvent(strangerEvent('tenant_never_onboarded')),
    (error: unknown) => error instanceof OperationalError && (error as { code: string }).code === 'TENANT_NOT_ONBOARDED',
  );

  // The refusal must happen BEFORE any row is written. A store that created the orphan first and
  // complained afterwards would satisfy a message-based assertion while leaving the hole open.
  assert.deepEqual(created, [], 'no row may be created for an un-onboarded tenant');
});

test('the Appwrite backend writes the event when the tenant does exist', async () => {
  // The negative control for the test above. A check that only ever sees the refusal cannot
  // distinguish a real tenant check from a store that refuses everything, which is a different
  // outage and an equally silent one.
  const { AppwriteTelemetryStore } = await import('../src/services/telemetryStore');

  const created: string[] = [];
  const services = {
    tables: {
      getRow: async () => ({ $id: 'tenant_ok' }),
      createRow: async (args: { rowId: string }) => { created.push(args.rowId); return { $id: args.rowId }; },
      createExecution: async () => ({ $id: 'exec_1' }),
    },
  } as never;

  const store = new AppwriteTelemetryStore(appwriteSettings, services);
  const result = await store.recordTelemetryEvent(strangerEvent('tenant_ok'));

  assert.equal(created.length, 1, 'an onboarded tenant must still be able to write');
  assert.equal(result.documentId, created[0]);
});
