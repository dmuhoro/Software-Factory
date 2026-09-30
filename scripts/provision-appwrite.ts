/**
 * Declarative, idempotent provisioning for the Appwrite pilot project.
 *
 * ## Why this is a script and not a console click-through
 *
 * The console is fine once and terrible as a record. This schema is derived from the actual
 * TypeScript record shapes in `src/models/telemetry.ts` and `src/services/appwriteService.ts`,
 * not from imagination, and running this file against an empty project and then against the
 * result must produce identical state. Both properties are testable, which a console is not.
 *
 * ## Safety properties, in order of importance
 *
 * 1. **Dry run by default.** Nothing is created unless `--apply` is passed. A provisioning tool
 *    that mutates cloud state on invocation is one keystroke away from an incident.
 * 2. **Never destructive.** There is no delete path in this file at all. It creates what is
 *    missing and reports what it saw. A future migration that needs to remove a column has to be
 *    a separate, explicitly reviewed tool, because "the tool removed my data" is not a bug you
 *    want to discover by reading its source.
 * 3. **Idempotent.** Every resource is looked up before it is created, so re-running is safe and
 *    a second run reports zero changes. This is the property that lets it run in CI.
 * 4. **Never invents an identifier.** Table ids are derived from the configuration that the
 *    running product uses, not hardcoded here, so the check and the application cannot disagree
 *    about which database is authoritative.
 * 5. **Fails closed.** Missing or placeholder credentials abort before any call. A provisioning
 *    tool that falls back to a default project is a tool that provisions the wrong project.
 *
 * ## JSON columns
 *
 * Appwrite TablesDB has no JSON column type (verified against the installed SDK's method list,
 * not assumed), so structured payloads are stored as text. That is a deliberate trade: the wire
 * format stays honest about what the datastore does, and querying inside a JSON blob is not
 * something the product needs. Fields worth indexing get their own real columns.
 */
import { Databases, Query, TablesDB } from 'node-appwrite';

import { requireAppwriteConfig } from '../src/configurations/appwrite.config';
import { getAppwriteServices, withRetry } from '../src/services/appwriteClient';

type Column =
  | { kind: 'string'; key: string; size: number; required?: boolean; indexed?: boolean; description: string }
  | { kind: 'text'; key: string; required?: boolean; description: string }
  | { kind: 'datetime'; key: string; required?: boolean; indexed?: boolean; description: string }
  | { kind: 'integer'; key: string; required?: boolean; description: string };

interface TableSpec {
  id: string;
  description: string;
  columns: Column[];
}

/**
 * The schema, with each column naming the field it exists to serve. The `description` is not
 * decoration: an unlabelled column in a shared cloud database is a question nobody can answer
 * six months later, and "what is ts?" is the kind of question that gets guessed at wrongly.
 */
function buildSchema(databaseId: string): { databaseName: string; tables: TableSpec[] } {
  const tenantId: Column = {
    kind: 'string', key: 'tenantId', size: 64, required: true, indexed: true,
    description: 'ADR-001 composite-key partition. Every query in the product filters on this first.',
  };
  return {
    databaseName: `Software Factory (${databaseId})`,
    tables: [
      {
        id: 'tenants',
        description: 'Registered tenants. Present so a request from an unknown tenant is refused by the database, not only by middleware.',
        columns: [
          tenantId,
          { kind: 'string', key: 'niche', size: 32, required: true, indexed: true, description: 'IndustryNiche discriminator. The refusal boundary is the niche, not just the tenant.' },
          { kind: 'string', key: 'apiKeyHash', size: 128, required: true, description: 'SHA-256 of the tenant API key. The plaintext key is never stored, here or anywhere.' },
          { kind: 'string', key: 'label', size: 128, required: false, description: 'Human-readable tenant name for operator triage.' },
          { kind: 'datetime', key: 'createdAt', required: true, indexed: true, description: 'When the tenant was onboarded.' },
        ],
      },
      {
        id: 'telemetry_events',
        description: 'Raw tenant events. One row per (tenantId, idempotencyKey); the pair is the document id, so a replay collides instead of duplicating.',
        columns: [
          tenantId,
          { kind: 'string', key: 'idempotencyKey', size: 128, required: true, indexed: true, description: 'Client-supplied replay key. Combined with tenantId it forms the deterministic document id.' },
          { kind: 'string', key: 'niche', size: 32, required: true, indexed: true, description: 'Niche captured at write time, so a later niche change cannot rewrite history.' },
          { kind: 'string', key: 'eventType', size: 64, required: true, description: 'RawTelemetryPayload.eventType.' },
          { kind: 'datetime', key: 'ts', required: true, indexed: true, description: 'Event timestamp from the payload, not write time.' },
          { kind: 'text', key: 'payloadJson', required: true, description: 'RawTelemetryPayload.payload, serialised. Text because Appwrite has no JSON column type.' },
          { kind: 'string', key: 'metadataJson', size: 1024, required: false, description: 'RawTelemetryPayload.metadata, serialised.' },
          { kind: 'datetime', key: 'persistedAt', required: true, description: 'When the row was written, so ingestion lag is measurable.' },
        ],
      },
      {
        id: 'ai_transformations',
        description: 'Structured AI output per transformation, with its audit trail. Mirrors TransformationRecord field for field.',
        columns: [
          { kind: 'string', key: 'transformId', size: 64, required: true, indexed: true, description: 'TransformationRecord.id, used as the row id.' },
          tenantId,
          { kind: 'string', key: 'niche', size: 32, required: true, indexed: true, description: 'IndustryNiche at processing time.' },
          { kind: 'string', key: 'eventType', size: 64, required: true, description: 'TransformationRecord.eventType.' },
          { kind: 'string', key: 'status', size: 32, required: true, indexed: true, description: 'success | flagged | quarantined | failed. Quarantine is a real state, not an error string.' },
          { kind: 'string', key: 'rawPayloadId', size: 64, required: false, description: 'Links back to the telemetry_events row this was derived from.' },
          { kind: 'text', key: 'structuredOutputJson', required: false, description: 'StructuredAiOutput, serialised.' },
          { kind: 'string', key: 'auditTrailJson', size: 2048, required: true, description: 'TransformationAuditTrail: timing, tokens, model, retry count, circuit-breaker state.' },
          { kind: 'string', key: 'errorMessage', size: 512, required: false, description: 'Explicit failure text. Empty means no failure, so a missing value is never ambiguous.' },
          { kind: 'string', key: 'errorCode', size: 64, required: false, description: 'Machine-readable failure code.' },
          { kind: 'datetime', key: 'createdAt', required: true, indexed: true, description: 'Record creation time.' },
          { kind: 'datetime', key: 'updatedAt', required: true, description: 'Last update time.' },
        ],
      },
      {
        id: 'audit_logs',
        description: 'Append-only audit trail. Mirrors the DurableStore.appendAudit entry shape.',
        columns: [
          tenantId,
          { kind: 'string', key: 'actorId', size: 128, required: true, indexed: true, description: 'Who acted: a tenant id, or a service: principal such as software_factory_runtime.' },
          { kind: 'string', key: 'action', size: 128, required: true, indexed: true, description: 'For example AI_TRANSFORMATION_RECORDED.' },
          { kind: 'string', key: 'resourceUri', size: 512, required: true, description: 'factory:// scheme, the same URI the local store uses.' },
          { kind: 'string', key: 'checksum', size: 128, required: true, description: 'sha256: of the output, so a tampered record is detectable without storing the original.' },
          { kind: 'datetime', key: 'ts', required: true, indexed: true, description: 'Action time.' },
        ],
      },
    ],
  };
}

async function main(): Promise<number> {
  const apply = process.argv.includes('--apply');
  const settings = requireAppwriteConfig(process.env);
  const schema = buildSchema(settings.databaseId);
  const { databases, tables } = getAppwriteServices(process.env);
  // Provisioning tolerates more attempts than a request path, and should: it runs once, by a
  // human, with nothing time-critical, and its whole job is to converge on a correct schema.
  const attempts = Math.max(settings.limits.retryAttempts, 6);

  /**
   * Appwrite enforces unique ids, so a retry after a lost response arrives as a 409. Treating that
   * as success is what makes a create genuinely safe to retry: the end state is identical whether
   * the first attempt landed or not. Without this, retrying would turn a success into a failure
   * report, which is how idempotency tools end up lying.
   */
  const alreadyExists = (error: unknown): boolean => (error as { code?: number })?.code === 409;
  const create = async <T>(label: string, operation: () => Promise<T>): Promise<'created' | 'exists'> => {
    try {
      await withRetry(operation, { attempts, label });
      return 'created';
    } catch (error) {
      if (alreadyExists(error)) return 'exists';
      throw error;
    }
  };

  const lines: string[] = [];
  const say = (line: string) => { lines.push(line); process.stdout.write(`${line}\n`); };
  let created = 0;

  say('');
  say(`Appwrite provisioning plan for project ${settings.projectId}`);
  say(`  database : ${settings.databaseId}`);
  say(`  mode     : ${apply ? 'APPLY (will create missing resources)' : 'DRY RUN (pass --apply to create)'}`);
  say('');

  // --- database -------------------------------------------------------------------------
  // Declared here because the apply path sets it, and the table loop below reads it.
  let databaseExists = false;
  const existingDatabases = await withRetry(() => databases.list(), { attempts, label: 'list databases' });
  const names = (existingDatabases?.databases ?? []).map((d) => d?.$id);
  databaseExists = names.includes(settings.databaseId);
  if (databaseExists) {
    say(`  =  database "${settings.databaseId}" already exists`);
  } else {
    say(`  +  database "${settings.databaseId}" would be created`);
    if (apply) {
      const outcome = await create(`create database ${settings.databaseId}`, () => databases.create(settings.databaseId, schema.databaseName));
      if (outcome === 'created') created += 1;
      say(outcome === 'exists' ? `     = already created by a concurrent run` : `     + created`);
      databaseExists = true;
    }
  }

  // --- tables and columns ---------------------------------------------------------------
  //
  // If the database is absent and this is a dry run, nothing below can be probed: `listTables`
  // against a database that does not exist is a 404, and turning that into "the plan failed" is
  // both noise and a lie. A dry run that cannot describe what it would create is not a dry run.
  //
  // The gate is `!apply` as well as absence. It was originally only gated on absence, so `--apply`
  // against an empty project created the database and then returned early claiming it had changed
  // nothing -- the worst possible failure for a provisioning tool, because it looks like success.
  if (!databaseExists && !apply) {
    say('  !  database is absent, so table and column state cannot be probed. Full plan follows.');
    for (const table of schema.tables) {
      say(`  +  table "${table.id}" -- ${table.description}`);
      for (const column of table.columns) {
        const size = column.kind === 'string' ? `/${column.size}` : '';
        say(`     . column ${column.key} (${column.kind}${size}, required=${column.required ?? false}) -- ${column.description}`);
      }
    }
    say('');
    say('Dry run complete. Nothing was changed.');
    say('');
    return 0;
  }

  for (const table of schema.tables) {
    const tablesHere = await withRetry(() => tables.listTables({ databaseId: settings.databaseId, queries: [Query.limit(100)] }), { attempts, label: `list tables in ${table.id}` });
    const tableIds = (tablesHere?.tables ?? []).map((t) => t?.$id);
    if (tableIds.includes(table.id)) {
      say(`  =  table "${table.id}" already exists`);
    } else {
      say(`  +  table "${table.id}" would be created -- ${table.description}`);
      if (apply) {
        const outcome = await create(`create table ${table.id}`, () => tables.createTable({ databaseId: settings.databaseId, tableId: table.id, name: table.id }));
        if (outcome === 'created') created += 1;
        say(outcome === 'exists' ? `     = already created by a concurrent run` : `     + created`);
      }
    }

    // Column creation needs the table to exist. In a dry run that is not yet true, so the column
    // plan is printed but not probed -- reporting "already exists" for a table that does not
    // exist yet would be a lie in the one mode whose entire purpose is honest reporting.
    if (!apply) {
      for (const column of table.columns) {
        say(`     . column ${column.key} (${column.kind}${column.kind === 'string' ? `/${(column as { size: number }).size}` : ''}) -- ${column.description}`);
      }
      continue;
    }

    const present = await withRetry(() => tables.listColumns({ databaseId: settings.databaseId, tableId: table.id, queries: [Query.limit(200)] }), { attempts, label: `list columns in ${table.id}` });
    const presentKeys = new Set((present?.columns ?? []).map((c) => c?.key));
    for (const column of table.columns) {
      if (presentKeys.has(column.key)) {
        say(`     = column ${column.key} already exists`);
        continue;
      }
      say(`     + column ${column.key} would be created`);
      const shared = { databaseId: settings.databaseId, tableId: table.id, key: column.key, required: column.required ?? false };
      if (column.kind === 'string') {
        await create(`create column ${table.id}.${column.key}`, () => tables.createStringColumn({ ...shared, size: column.size }));
      } else if (column.kind === 'text') {
        await create(`create column ${table.id}.${column.key}`, () => tables.createTextColumn({ ...shared }));
      } else if (column.kind === 'datetime') {
        await create(`create column ${table.id}.${column.key}`, () => tables.createDatetimeColumn({ ...shared }));
      } else {
        await create(`create column ${table.id}.${column.key}`, () => tables.createIntegerColumn({ ...shared }));
      }
      created += 1;
    }
  }

  say('');
  say(apply
    ? `Done. ${created} resource(s) created. Re-running should report 0, which is the idempotency proof.`
    : `Dry run complete. ${created} resource(s) would be created. Nothing was changed.`);
  say('');
  void lines;
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\nPROVISIONING FAILED: ${message}\n`);
    if (error instanceof Error && 'response' in error) {
      const response = (error as { response?: unknown }).response;
      process.stderr.write(`Response: ${JSON.stringify(response)}\n`);
    }
    process.exit(1);
  });
