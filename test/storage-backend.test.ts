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

import { IndustryNiche } from '../src/models/tenant';
import { ProcessingStatus } from '../src/models/telemetry';

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

/* ------------------------------------------------------------------------------------------- */
/* The read path. A restarted process is the only honest test of a read path, and that is exactly */
/* what a fresh instance stands in for: it has no in-process state, so anything it can read, it    */
/* read from the datastore.                                                                                              */
/* ------------------------------------------------------------------------------------------- */

/**
 * A `tables` double whose rows live in the double, not in the store.
 *
 * That is the property that makes these tests mean anything: the store cannot reach into the
 * double's state, so the only way a read succeeds is if the store issued a real list against a
 * datastore the previous instance also wrote to.
 */
type Row = Record<string, unknown>;
type ListArgs = { tableId: string; queries?: string[] };

function tableDouble(seed: Record<string, Row> = {}) {
  const tables: Map<string, Record<string, Row>> = new Map();
  for (const name of ['tenants', 'telemetry_events', 'ai_transformations', 'audit_logs']) {
    tables.set(name, {});
  }
  for (const [id, row] of Object.entries(seed)) {
    (tables.get('ai_transformations') as Record<string, Row>)[id] = row;
  }

  /** Every list query that crossed the boundary, so a test can assert on the filter itself. */
  const listCalls: string[][] = [];

  const service = {
    getRow: async () => ({ $id: 'tenant_ok' }),
    createRow: async (args: { tableId: string; rowId: string; data: Row }) => {
      (tables.get(args.tableId) as Record<string, Row>)[args.rowId] = args.data;
      return { $id: args.rowId };
    },
    createExecution: async () => ({ $id: 'exec_1' }),
    listRows: async (args: ListArgs) => {
      listCalls.push(args.queries ?? []);
      let rows = Object.entries(tables.get(args.tableId) ?? {}).map(([id, row]) => ({ $id: id, ...row }));
      for (const query of args.queries ?? []) {
        // The SDK encodes a query as JSON, not the string DSL. Parsing it the wrong way would make
        // this double filter nothing and quietly pass a tenant-isolation test -- the exact false
        // confidence this suite exists to prevent -- so an unparseable query is an error.
        const parsed = parseQuery(query);
        if (parsed.method === 'equal') {
          rows = rows.filter((row) => row[parsed.attribute] === parsed.values[0]);
        } else if (parsed.method === 'orderDesc') {
          const key = parsed.attribute ?? 'createdAt';
          rows = [...rows].sort((a, b) => String(b[key] ?? '').localeCompare(String(a[key] ?? '')));
        } else if (parsed.method === 'limit') {
          rows = rows.slice(0, Number(parsed.values[0]));
        }
      }
      return { rows, total: rows.length };
    },
  };

  return { tables, listCalls, service: service as never };
}

/** A transformation as `pipelineOrchestrator` persists it: the row `/history` must read back. */
const record = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 'xform_1', tenantId: 'tenant_ok', niche: IndustryNiche.CUSTOM_B2B, eventType: 'LEAD_CREATED',
  status: ProcessingStatus.COMPLETED, rawPayloadId: 'raw_1',
  structuredOutput: { summary: 'a lead', confidence: 0.9, extractedFields: { score: 7 } },
  auditTrail: { startedAt: '2026-09-30T00:00:00.000Z', completedAt: '2026-09-30T00:00:01.500Z', durationMs: 1500, retryAttempts: 0, circuitBreakerStatus: 'CLOSED' },
  createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:01.500Z',
  ...overrides,
} as never);

type QuerySpec = { method: string; attribute?: string; values: unknown[] };

function parseQuery(raw: string): QuerySpec {
  try {
    return JSON.parse(raw) as QuerySpec;
  } catch (error) {
    throw new Error(`test double received an unparseable query: ${raw}`, { cause: error });
  }
}

/** The limit a `limit` query asked for, or undefined when the query set carried none. */
function limitOf(queries: string[]): number | undefined {
  for (const raw of queries) {
    const spec = parseQuery(raw);
    if (spec.method === 'limit') return Number(spec.values[0]);
  }
  return undefined;
}

/** True when a `limit` query in this batch carried the given value. */
function hasLimit(queries: string[], value: number): boolean {
  return queries.some((raw) => { const spec = parseQuery(raw); return spec.method === 'limit' && Number(spec.values[0]) === value; });
}

/** True when a `limit` query in this batch asked for at most `max`. */
function allLimitsWithin(queries: string[], max: number): boolean {
  return queries.filter((raw) => parseQuery(raw).method === 'limit')
    .every((raw) => Number(parseQuery(raw).values[0]) <= max);
}

test('a read from a fresh store instance sees a write made by a previous instance', async () => {
  // This is the whole reason the cache was removed. The old implementation answered reads from an
  // in-process map that only its own writes populated, so a restarted process reported an empty
  // history while the rows sat in the database. A second instance is indistinguishable from a
  // restart for this purpose, and it is observable in a unit test instead of in production.
  const { AppwriteTelemetryStore } = await import('../src/services/telemetryStore');

  const db = tableDouble();
  const firstProcess = new AppwriteTelemetryStore(appwriteSettings, { tables: db.service } as never);
  await firstProcess.recordTransformation(record());

  const restarted = new AppwriteTelemetryStore(appwriteSettings, { tables: db.service } as never);
  const history = await restarted.getTransformationsByTenant('tenant_ok');

  assert.equal(history.length, 1, 'a restarted process must read the row that was already committed');
  assert.equal(history[0].id, 'xform_1');
  assert.equal(history[0].tenantId, 'tenant_ok');
  // The empty-cache implementation returned `[]` here, so this line is the gate.
  assert.notDeepEqual(history, [], 'a read that only ever sees this process is a cache, not a read');
});

test('the record survives the round trip, not just the row count', async () => {
  // A read that returns the right number of rows built from empty defaults is a read that looks
  // correct and is worthless. These are the fields an operator inspects after an incident.
  const { AppwriteTelemetryStore } = await import('../src/services/telemetryStore');
  const db = tableDouble();
  const writer = new AppwriteTelemetryStore(appwriteSettings, { tables: db.service } as never);
  await writer.recordTransformation(record());

  const reader = new AppwriteTelemetryStore(appwriteSettings, { tables: db.service } as never);
  const [row] = await reader.getTransformationsByTenant('tenant_ok');

  assert.ok(row, 'the row must be readable');
  assert.equal(row.tenantId, 'tenant_ok');
  assert.equal(row.niche, IndustryNiche.CUSTOM_B2B, 'the enum round-trips as its stored value, not its label');
  assert.equal(row.eventType, 'LEAD_CREATED');
  assert.equal(row.status, 'COMPLETED');
  assert.ok(row.rawPayloadId, 'rawPayloadId must be populated, not blank');
  assert.ok(row.createdAt, 'createdAt must be populated, not blank');
  assert.ok(row.updatedAt, 'updatedAt must be populated, not blank');
  assert.ok(row.auditTrail, 'the audit trail must be parsed, not defaulted away');
  assert.equal(typeof row.auditTrail.durationMs, 'number');
  assert.ok(row.structuredOutput, 'a structured output column must parse back to an object');
});

test('the tenant filter is applied by the datastore, not by the caller after the fetch', async () => {
  // Filtering in memory after an unfiltered fetch still returns the right rows, so a value-only
  // assertion cannot tell a real fence from a convenience filter. This asserts on the query that
  // crossed the boundary: a tenant must never receive another tenant's rows, and the only place
  // that is guaranteed is the query itself.
  const { AppwriteTelemetryStore } = await import('../src/services/telemetryStore');
  const db = tableDouble();

  const alphaWriter = new AppwriteTelemetryStore(appwriteSettings, { tables: db.service } as never);
  await alphaWriter.recordTransformation(record({ tenantId: 'tenant_alpha' }));

  const beta = new AppwriteTelemetryStore(appwriteSettings, { tables: db.service } as never);
  await beta.recordTransformation(record({ id: 'xform_2', tenantId: 'tenant_beta' }));

  const alpha = await new AppwriteTelemetryStore(appwriteSettings, { tables: db.service } as never)
    .getTransformationsByTenant('tenant_alpha');

  assert.equal(alpha.length, 1, 'tenant_alpha sees only its own row');
  assert.ok(alpha.every((r) => r.tenantId === 'tenant_alpha'), 'tenant_beta must never appear');
  assert.ok(
    db.listCalls.some((q) => q.some((raw) => { const spec = parseQuery(raw); return spec.method === 'equal' && spec.attribute === 'tenantId' && spec.values[0] === 'tenant_alpha'; })),
    'the tenant filter must cross the network boundary; an in-memory filter is one refactor from a leak',
  );
});

test('reads are bounded and newest-first, so one request cannot pull the whole table', async () => {
  // An unbounded list is a denial-of-service vector on a shared table. The cap applies to the
  // query that is sent, not merely to the array that comes back, so a large table is never fully
  // transferred to be truncated locally.
  const { AppwriteTelemetryStore, LocalTelemetryStore } = await import('../src/services/telemetryStore');
  const db = tableDouble();
  const store = new AppwriteTelemetryStore(appwriteSettings, { tables: db.service } as never);

  for (let i = 0; i < 12; i += 1) {
    const writer = new AppwriteTelemetryStore(appwriteSettings, { tables: db.service } as never);
    const minute = String(i).padStart(2, '0');
    await writer.recordTransformation(record({
      id: `xform_${i}`,
      createdAt: `2026-09-30T00:${minute}:00.000Z`,
      updatedAt: `2026-09-30T00:${minute}:00.000Z`,
    }));
  }

  const everything = await store.getAllTransformations();
  assert.equal(everything.length, 12, 'no explicit limit reads the whole small table');
  assert.equal((await store.getAllTransformations(5)).length, 5, 'an explicit limit is honoured');
  // Newest-first, so a page shows the most recent work rather than the oldest. The assertion below
  // on the *query* is the one that matters: the ordering is the datastore's job, and a store that
  // never asked for it would pass a value-only test whenever the double happened to sort.
  assert.ok(
    db.listCalls.every((q) => q.some((raw) => { const spec = parseQuery(raw); return spec.method === 'orderDesc' && spec.attribute === 'createdAt'; })),
    'a history read must ask the datastore to order by createdAt descending',
  );
  assert.equal(everything[0]?.id, 'xform_11', 'history must be newest-first');
  assert.equal(everything[0]?.createdAt, '2026-09-30T00:11:00.000Z');

  const beforeAbuse = db.listCalls.length;
  assert.ok(db.listCalls.some((q) => hasLimit(q, 5)), 'the requested limit must reach the datastore, not just slice the result');
  assert.ok(db.listCalls.every((q) => allLimitsWithin(q, 500)), 'no query may exceed the cap');

  await store.getAllTransformations(10_000);
  assert.ok(hasLimit(db.listCalls[beforeAbuse] ?? [], 500), 'an absurd limit is clamped to the cap, not obeyed');

  const zeroAt = db.listCalls.length;
  await store.getAllTransformations(0);
  await store.getAllTransformations(-5);
  for (const batch of db.listCalls.slice(zeroAt)) {
    for (const raw of batch.filter((q) => parseQuery(q).method === 'limit')) {
      assert.ok(Number(parseQuery(raw).values[0]) >= 1, 'a non-positive limit is raised, never passed through');
    }
  }

  // The local adapter applies the same default, so a caller's answer does not change shape with
  // the backend. Asserted on the cap rather than a magic number that the other tests could move.
  const { boundedLimit, MAX_READ_LIMIT, DEFAULT_READ_LIMIT } = await import('../src/services/localTelemetryStore');
  assert.equal(boundedLimit(undefined), DEFAULT_READ_LIMIT);
  assert.equal(boundedLimit(5), 5);
  assert.equal(boundedLimit(10_000), MAX_READ_LIMIT);
  assert.equal(boundedLimit(0), 1);
  assert.ok(Array.isArray(await new LocalTelemetryStore().getAllTransformations()));
});

test('audit logs are read from the datastore, and fenced by tenant the same way', async () => {
  const { AppwriteTelemetryStore } = await import('../src/services/telemetryStore');
  const db = tableDouble();
  const store = new AppwriteTelemetryStore(appwriteSettings, { tables: db.service } as never);
  await store.recordTelemetryEvent(strangerEvent('tenant_alpha'));
  await store.recordTransformation(record({ tenantId: 'tenant_alpha' }));

  const alpha = await store.getAuditLogs('tenant_alpha');
  assert.ok(alpha.length > 0, 'the audit entry written by a previous call must be readable');
  const auditBatch = db.listCalls[db.listCalls.length - 1] ?? [];
  assert.ok(
    auditBatch.some((raw) => { const spec = parseQuery(raw); return spec.method === 'equal' && spec.attribute === 'tenantId' && spec.values[0] === 'tenant_alpha'; }),
    'an audit read must push the tenant filter down, same as a transformation read',
  );

  // An operator-wide read is a legitimate request, and it must still be bounded.
  const all = await store.getAuditLogs(undefined);
  assert.ok(all.length >= alpha.length);
  const auditLimits = db.listCalls.map(limitOf).filter((n): n is number => n !== undefined);
  assert.ok(auditLimits.every((n) => n <= 500));
});

test('a corrupt JSON column is an error, not a plausible empty record', async () => {
  // Returning `{}` for a row it cannot parse would turn data loss into a believable empty answer,
  // which is the class of quiet failure this repository refuses to ship. The row id is in the
  // message so an operator can find the damaged row.
  const { AppwriteTelemetryStore } = await import('../src/services/telemetryStore');
  const { OperationalError } = await import('../src/utils/operationalError');

  const db = tableDouble({
    doc_xform_corrupt: {
      transformId: 'xform_corrupt', tenantId: 'tenant_ok', niche: 'CustomB2B',
      eventType: 'LEAD_CREATED', status: 'COMPLETED', rawPayloadId: 'raw_1',
      structuredOutputJson: '{ this is not json',
    },
  });
  const store = new AppwriteTelemetryStore(appwriteSettings, { tables: db.service } as never);

  await assert.rejects(
    () => store.getAllTransformations(),
    (error: unknown) => error instanceof OperationalError
      && (error as { code: string }).code === 'LEDGER_UNAVAILABLE'
      && /xform_corrupt/.test((error as { message: string }).message),
  );
});
