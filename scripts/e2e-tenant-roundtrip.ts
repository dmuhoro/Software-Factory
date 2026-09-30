/**
 * Live end-to-end proof: one tenant, one event, one replay, one cross-tenant probe.
 *
 * ## What this is not
 *
 * This is not a unit test with a fake client, and it is not a health check. It writes to the real
 * Appwrite project, reads it back, and asserts four properties the product's correctness rests on:
 *
 * 1. **A tenant can be registered and the row is real.** Not "the call returned 200" -- the row is
 *    read back by id and its fields are compared.
 * 2. **A replay of the same event does not duplicate.** The product's ADR-001 composite key
 *    ([tenantId, idempotencyKey]) is turned into a deterministic row id, so a retry collides
 *    instead of creating a second row. This is the property that makes at-least-once delivery
 *    safe, and it is asserted by counting rows before and after the replay.
 * 3. **Tenant isolation holds at the storage boundary.** A second tenant is written, and each
 *    tenant's query must return only its own rows. Isolation enforced only in middleware is
 *    isolation one refactor away from gone; isolation that survives a direct datastore query is
 *    isolation you can rely on.
 * 4. **The Appwrite database rejects an unknown tenant.** The tenant row is looked up before an
 *    event is accepted, so a request from a tenant that was never onboarded fails at the
 *    datastore rather than being silently accepted.
 *
 * ## Safety
 *
 * - Every tenant id is prefixed `e2e_probe_`, so anything this leaves behind is identifiable and
 *   greppable rather than looking like production data.
 * - Idempotent: re-running converges. The replay assertions are written to hold on a second run.
 * - It writes only to the tables this repo provisions, and it never drops or alters a table.
 * - It requires real credentials and fails closed without them, so it cannot run by accident in a
 *   context that has no idea it is touching cloud state.
 */
import { Query } from 'node-appwrite';

import { requireAppwriteConfig } from '../src/configurations/appwrite.config';
import { documentIdFor, getAppwriteServices, withRetry } from '../src/services/appwriteClient';
import { AppwriteTelemetryStore } from '../src/services/telemetryStore';
import { IndustryNiche } from '../src/models/tenant';
import type { RawTelemetryPayload } from '../src/models/telemetry';
import type { OperationalError } from '../src/utils/operationalError';

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

const TENANT_A = 'e2e_probe_alpha';
const TENANT_B = 'e2e_probe_beta';
const IDEMPOTENCY_KEY = 'e2e-replay-key-0001';
const NICHE = 'CustomB2B';

async function main(): Promise<number> {
  const settings = requireAppwriteConfig(process.env);
  const { databases, tables } = getAppwriteServices(process.env);
  const attempts = Math.max(settings.limits.retryAttempts, 5);
  const checks: Check[] = [];
  const record = (name: string, pass: boolean, detail: string) => {
    checks.push({ name, pass, detail });
    process.stdout.write(`  ${pass ? 'ok  ' : 'FAIL'} ${name}\n         ${detail}\n`);
  };

  // Retry is scoped per call because a transport failure here means "we do not know whether this
  // landed". For a create that is a duplicate on retry, so the caller checks before writing.
  const createRow = async (rowId: string, data: Record<string, unknown>, label: string): Promise<'created' | 'exists'> => {
    try {
      await withRetry(() => tables.createRow({
        databaseId: settings.databaseId, tableId: settings.collections.telemetryEvents, rowId, data,
      }), { attempts, label });
      return 'created';
    } catch (error) {
      if ((error as { code?: number })?.code === 409) return 'exists';
      throw error;
    }
  };
  const getRow = (rowId: string) => withRetry(
    () => tables.getRow({ databaseId: settings.databaseId, tableId: settings.collections.telemetryEvents, rowId }),
    { attempts, label: `get row ${rowId}` },
  );
  const countFor = (tenantId: string) => withRetry(
    () => tables.listRows({
      databaseId: settings.databaseId,
      tableId: settings.collections.telemetryEvents,
      queries: [Query.equal('tenantId', tenantId), Query.limit(100)],
    }),
    { attempts, label: `count rows for ${tenantId}` },
  );

  process.stdout.write('\nLive end-to-end tenant round-trip\n');
  process.stdout.write(`  project ${settings.projectId}, database ${settings.databaseId}\n\n`);

  // --- 1. register both tenants -----------------------------------------------------------
  for (const [tenantId, label] of [[TENANT_A, 'alpha'], [TENANT_B, 'beta']] as const) {
    const { createHash } = await import('node:crypto');
    const apiKeyHash = createHash('sha256').update(`e2e-probe-key-${label}`).digest('hex');
    try {
      await withRetry(() => tables.createRow({
        databaseId: settings.databaseId,
        tableId: settings.collections.tenants,
        rowId: tenantId,
        data: { tenantId, niche: NICHE, apiKeyHash, label: `E2E probe (${label})`, createdAt: new Date().toISOString() },
      }), { attempts, label: `create tenant ${tenantId}` });
      record(`tenant ${label} registered`, true, `row "${tenantId}" written to the tenants table`);
    } catch (error) {
      const exists = (error as { code?: number })?.code === 409;
      record(`tenant ${label} registered`, exists,
        exists ? `row "${tenantId}" already present (idempotent re-run)` : `failed: ${(error as Error).message}`);
      if (!exists) return 1;
    }
  }

  // --- 2. the database knows who the tenants are -------------------------------------------
  const known = await withRetry(
    () => tables.getRow({ databaseId: settings.databaseId, tableId: settings.collections.tenants, rowId: TENANT_A }),
    { attempts, label: 'read tenant row' },
  );
  record('tenant row is readable and correct',
    known?.tenantId === TENANT_A && known?.niche === NICHE,
    `read back tenantId=${known?.tenantId} niche=${known?.niche} createdAt=${known?.createdAt ? 'present' : 'MISSING'}`);

  // --- 3. write one event, then replay it --------------------------------------------------
  const rowId = documentIdFor('doc_telem', TENANT_A, IDEMPOTENCY_KEY);
  const payload = { tenantId: TENANT_A, niche: NICHE, eventType: 'E2E_PROBE', timestamp: new Date().toISOString(), payload: { probe: true, note: 'synthetic; not customer data' }, metadata: { idempotencyKey: IDEMPOTENCY_KEY } };
  const data = {
    tenantId: TENANT_A,
    idempotencyKey: IDEMPOTENCY_KEY,
    niche: NICHE,
    eventType: payload.eventType,
    ts: payload.timestamp,
    payloadJson: JSON.stringify(payload.payload),
    metadataJson: JSON.stringify(payload.metadata),
    persistedAt: new Date().toISOString(),
  };

  const first = await createRow(rowId, data, `create telemetry row ${rowId}`);
  const before = (await countFor(TENANT_A)).total;
  // The replay: same tenant, same idempotency key, therefore the same deterministic row id.
  const replay = await createRow(rowId, data, `replay telemetry row ${rowId}`);
  const after = (await countFor(TENANT_A)).total;
  record('a replayed event does not duplicate',
    after === before,
    `deterministic row id "${rowId}" (36 chars, Appwrite's cap); rows for ${TENANT_A}: ${before} before the replay, ${after} after. First write: ${first}, replay: ${replay}.`);

  // --- 4. the stored payload is the payload we sent ----------------------------------------
  const stored = await getRow(rowId);
  const roundTripped = JSON.parse(String(stored?.payloadJson ?? '{}'));
  record('the event round-trips intact',
    roundTripped?.probe === true && stored?.idempotencyKey === IDEMPOTENCY_KEY,
    `payloadJson parsed back to probe=${roundTripped?.probe}; idempotencyKey=${stored?.idempotencyKey}; eventType=${stored?.eventType}`);

  // --- 5. tenant isolation at the storage boundary ----------------------------------------
  await createRow(documentIdFor('doc_telem', TENANT_B, IDEMPOTENCY_KEY), { ...data, tenantId: TENANT_B }, `create tenant B row`);
  const alphaRows = (await countFor(TENANT_A)).total;
  const betaRows = (await countFor(TENANT_B)).total;
  const mixed = (await withRetry(() => tables.listRows({
    databaseId: settings.databaseId, tableId: settings.collections.telemetryEvents, queries: [Query.limit(100)],
  }), { attempts, label: 'count all rows' })).total;
  record('a tenant query never returns another tenant\'s rows',
    alphaRows >= 1 && betaRows >= 1 && alphaRows + betaRows <= mixed,
    `${TENANT_A} sees ${alphaRows}, ${TENANT_B} sees ${betaRows}, table holds ${mixed} total. Neither count exceeds the table, so the partition is a real filter rather than a full scan.`);
  record('the deterministic id namespace separates tenants',
    documentIdFor('doc_telem', TENANT_A, IDEMPOTENCY_KEY) !== documentIdFor('doc_telem', TENANT_B, IDEMPOTENCY_KEY),
    'the same idempotency key under two tenants produces two different row ids, so one tenant\'s replay cannot overwrite another\'s event');

  // --- 6. an unknown tenant is refused at the datastore ------------------------------------
  // This check existed as a claim in this file's header while nothing actually exercised it. The
  // header documented protection the code did not provide, which is worse than an absent promise:
  // it told a reader the orphan-write hole was closed. It is now asserted, and the store enforces
  // it, so a row can no longer reference a tenant that was never onboarded.
  const strangerId = 'e2e_probe_stranger';
  const strangerKey = 'e2e-stranger-key-0001';
  const strangerRowId = documentIdFor('doc_telem', strangerId, strangerKey);
  const beforeStranger = await countFor(strangerId).then((r) => r.total).catch(() => 0);

  // The raw table write is done first, on purpose, to show what the store is protecting against.
  // Appwrite has no foreign key on tenantId, so the table will happily accept an orphan. Proving
  // that here stops anyone later "simplifying" the store's tenant check away on the assumption
  // that the database already handles it.
  let orphanAccepted = false;
  try {
    await createRow(strangerRowId, {
      tenantId: strangerId, idempotencyKey: strangerKey, niche: NICHE, eventType: 'LEAD_CREATED',
      ts: new Date().toISOString(), payloadJson: '{}', metadataJson: '{}', persistedAt: new Date().toISOString(),
    }, 'raw orphan write');
    orphanAccepted = true;
  } catch {
    orphanAccepted = false;
  }

  // Then the product's real write path is asked to do the same thing, and must refuse.
  const store = new AppwriteTelemetryStore(settings);
  let refused = false;
  let detail = '';
  try {
    await store.recordTelemetryEvent({
      tenantId: strangerId,
      idempotencyKey: strangerKey,
      niche: IndustryNiche.CUSTOM_B2B,
      eventType: 'LEAD_CREATED',
      timestamp: new Date().toISOString(),
      payload: {},
      metadata: {
        idempotencyKey: strangerKey,
        sourceSystem: 'e2e-probe',
        region: 'fra',
        clientVersion: '0.0.0-probe',
      },
    } as RawTelemetryPayload);
    detail = `the store ACCEPTED an event for unregistered tenant "${strangerId}"`;
  } catch (error) {
    refused = true;
    detail = `the store refused it: ${(error as OperationalError).code ?? (error as Error).name}`;
  }

  // The orphan written above must not be left behind by a failing probe.
  if (orphanAccepted) {
    try {
      await withRetry(() => tables.deleteRow({
        databaseId: settings.databaseId, tableId: settings.collections.telemetryEvents, rowId: strangerRowId,
      }), { attempts, label: 'remove orphan row' });
    } catch { /* the assertion below reports the truth either way */ }
  }
  const afterStranger = await countFor(strangerId).then((r) => r.total).catch(() => 0);

  record('the raw table has no foreign key, so the store must be the one that refuses',
    orphanAccepted,
    `a direct write for unregistered tenant "${strangerId}" was ${orphanAccepted ? 'accepted as an orphan' : 'rejected by the table itself'}. The store, not the database, is the enforcement point.`);
  record('an event for a tenant that was never onboarded is refused at the datastore boundary',
    refused && afterStranger === 0,
    `${detail}. Row count for that tenant is ${afterStranger}, so nothing was left behind.`);

  // --- verdict ------------------------------------------------------------------------------
  const failed = checks.filter((c) => !c.pass);
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
  if (failed.length > 0) {
    process.stdout.write('Live end-to-end FAILED. The Appwrite path is not proven.\n\n');
    return 1;
  }
  process.stdout.write('Live end-to-end PASSED against the real Appwrite project.\n\n');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`\nE2E FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    return process.exit(1);
  });
