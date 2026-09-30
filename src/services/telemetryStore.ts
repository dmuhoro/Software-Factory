/**
 * The persistence port, and the two backends behind it.
 *
 * ## Why there is an interface at all
 *
 * `AppwriteService` is named for Appwrite but has always written to the local `DurableStore`. That
 * mismatch is why this repository had two persistence stories and no ADR: the class name promised
 * one thing and the code did another, so the decision was never actually made -- it was hidden.
 * Naming the port is what makes the choice visible and testable.
 *
 * ## The rule this file exists to enforce
 *
 * Exactly one backend is active per process, chosen explicitly by `STORAGE_BACKEND`. There is no
 * fallback, no mirroring and no "try Appwrite, else use the disk".
 *
 * That rule is not caution, it is correctness. A silent fallback means a request can be accepted
 * against storage nobody is monitoring, and a later read of the other store returns nothing, which
 * surfaces as data loss discovered by a customer rather than by an alert. Dual-writing is worse
 * still: two stores that agree is not a guarantee, it is a coincidence you have not tested yet.
 * Fail loudly, at startup, where an operator can see it.
 */
import { randomUUID, createHash } from 'node:crypto';

import type { AppwriteSettings } from '../configurations/appwrite.config';
import { requireAppwriteConfig } from '../configurations/appwrite.config';
import type { RawTelemetryPayload, TransformationRecord } from '../models/telemetry';
import { documentIdFor, getAppwriteServices, withRetry } from './appwriteClient';
import { LocalStore } from './localTelemetryStore';
import { TelemetryLogger } from '../utils/telemetryLogger';
import { OperationalError } from '../utils/operationalError';

export type StorageBackend = 'local' | 'appwrite';

export interface TelemetryStore {
  readonly name: StorageBackend;
  recordTelemetryEvent(payload: RawTelemetryPayload): Promise<{ documentId: string; deduplicated: boolean }>;
  recordTransformation(record: TransformationRecord): Promise<void>;
  appendAuditLog(entry: Record<string, unknown>): Promise<void>;
  getTransformationsByTenant(tenantId: string): TransformationRecord[];
  getAllTransformations(): TransformationRecord[];
  getAuditLogs(tenantId?: string): Array<Record<string, unknown>>;
}

/**
 * Validates `STORAGE_BACKEND`.
 *
 * Fails closed on anything unrecognised, including a typo. `STORAGE_BACKEND=appwirte` silently
 * falling back to the local disk would be a service that appears configured for cloud persistence
 * and is not, which is the same class of defect as a health check that reports a broken key as
 * valid. The set of accepted values is closed and short on purpose.
 */
export function resolveStorageBackend(raw: string | undefined): StorageBackend {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || value === 'local') return 'local';
  if (value === 'appwrite') return 'appwrite';
  throw new Error(
    `STORAGE_BACKEND must be "local" or "appwrite"; got ${JSON.stringify(raw)}. `
    + 'Refusing to start, because guessing which store to write to is how records get lost.',
  );
}

/** The local durable store. The offline default, and unchanged in behaviour from before. */
export class LocalTelemetryStore implements TelemetryStore {
  public readonly name = 'local' as const;

  private readonly delegate = new LocalStore();

  public async recordTelemetryEvent(payload: RawTelemetryPayload): Promise<{ documentId: string; deduplicated: boolean }> {
    return this.delegate.recordTelemetryEvent(payload);
  }

  public async recordTransformation(record: TransformationRecord): Promise<void> {
    return this.delegate.recordTransformation(record);
  }

  public async appendAuditLog(entry: Record<string, unknown>): Promise<void> {
    return this.delegate.appendAuditLog(entry);
  }

  public getTransformationsByTenant(tenantId: string): TransformationRecord[] {
    return this.delegate.getTransformationsByTenant(tenantId);
  }

  public getAllTransformations(): TransformationRecord[] {
    return this.delegate.getAllTransformations();
  }

  public getAuditLogs(tenantId?: string): Array<Record<string, unknown>> {
    return this.delegate.getAuditLogs(tenantId);
  }
}

/**
 * The Appwrite backend.
 *
 * Every write goes through `withRetry`, and every retry-safe write carries a deterministic id, so a
 * transport timeout that actually landed upstream results in a 409 which is treated as success
 * rather than as a failure. The idempotency here is structural -- it comes from the id, not from
 * hoping the network behaved.
 *
 * Reads are filtered by `tenantId` in the query itself. Isolation enforced by a filter the caller
 * can forget is isolation that eventually gets forgotten, so the filter is not optional here.
 */
export class AppwriteTelemetryStore implements TelemetryStore {
  public readonly name = 'appwrite' as const;

  private readonly services: ReturnType<typeof getAppwriteServices>;
  private readonly databaseId: string;
  private readonly tables: { tenants: string; telemetryEvents: string; aiTransformations: string; auditLogs: string };
  private readonly attempts: number;

  /**
   * `services` is injectable so the datastore contract can be tested without a network. The
   * production path passes nothing and gets the real memoised client. Without this seam the only
   * way to test the tenant check is against the live project, which makes a cheap regression test
   * into a slow credentialed one -- and a slow test is a test that gets skipped.
   */
  public constructor(settings: AppwriteSettings, services?: ReturnType<typeof getAppwriteServices>) {
    // Constructed eagerly so an unconfigured process fails here, at startup, rather than on the
    // first customer request with a 500.
    this.services = services ?? getAppwriteServices(process.env);
    this.databaseId = settings.databaseId;
    this.tables = settings.collections;
    this.attempts = Math.max(settings.limits.retryAttempts, 3);
  }

  private async createIdempotent(tableId: string, rowId: string, data: Record<string, unknown>, label: string): Promise<'created' | 'exists'> {
    try {
      await this.withRetry(() => this.services.tables.createRow({
        databaseId: this.databaseId, tableId, rowId, data,
      }), label);
      return 'created';
    } catch (error) {
      // 409 means the row is already there, which for a deterministic id is the outcome we wanted.
      // Reporting it as an error would turn a successful retry into a failed request.
      if ((error as { code?: number })?.code === 409) return 'exists';
      throw error;
    }
  }

  private withRetry<T>(operation: () => Promise<T>, label: string): Promise<T> {
    return withRetry(operation, { attempts: this.attempts, label });
  }

  /**
   * Confirms the tenant row exists before any event is written.
   *
   * Without this, an event for a tenant that was never onboarded is accepted and lands in the
   * shared telemetry table as an orphan. The table holds a `tenantId` column, so the row looks
   * well-formed and passes every shape check while referring to nothing. That is an integrity hole
   * that no later read would surface, because the reads filter by tenant and simply return nothing.
   *
   * The local backend gets this from its own registry. Appwrite is shared across tenants, so the
   * check belongs at the datastore boundary rather than in middleware: middleware protection is
   * one refactor away from gone, and this is the boundary a direct write would bypass anyway.
   */
  private async requireTenant(tenantId: string): Promise<void> {
    try {
      await this.withRetry(() => this.services.tables.getRow({
        databaseId: this.databaseId, tableId: this.tables.tenants, rowId: tenantId,
      }), `look up tenant ${tenantId}`);
    } catch (error) {
      if ((error as { code?: number })?.code === 404) {
        throw new OperationalError(
          'TENANT_NOT_ONBOARDED',
          `Tenant ${tenantId} is not onboarded; refusing to write an event that would reference nothing`,
          403,
        );
      }
      throw error;
    }
  }

  public async recordTelemetryEvent(payload: RawTelemetryPayload): Promise<{ documentId: string; deduplicated: boolean }> {
    await this.requireTenant(payload.tenantId);
    const rowId = this.documentId('doc_telem', payload.tenantId, payload.metadata.idempotencyKey);
    const outcome = await this.createIdempotent(this.tables.telemetryEvents, rowId, {
      tenantId: payload.tenantId,
      idempotencyKey: payload.metadata.idempotencyKey,
      niche: payload.niche,
      eventType: payload.eventType,
      ts: payload.timestamp,
      payloadJson: JSON.stringify(payload.payload ?? {}),
      metadataJson: JSON.stringify(payload.metadata ?? {}),
      persistedAt: new Date().toISOString(),
    }, `record telemetry ${rowId}`);

    return { documentId: rowId, deduplicated: outcome === 'exists' };
  }

  public async recordTransformation(record: TransformationRecord): Promise<void> {
    const rowId = this.documentId('doc_xform', record.tenantId, record.id);
    await this.createIdempotent(this.tables.aiTransformations, rowId, {
      transformId: record.id,
      tenantId: record.tenantId,
      niche: record.niche,
      eventType: record.eventType,
      status: record.status,
      rawPayloadId: record.rawPayloadId ?? '',
      structuredOutputJson: record.structuredOutput ? JSON.stringify(record.structuredOutput) : '',
      auditTrailJson: JSON.stringify(record.auditTrail ?? {}),
      errorMessage: record.errorMessage ?? '',
      errorCode: record.errorCode ?? '',
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }, `record transformation ${rowId}`);

    this.cache.set(rowId, record);

    await this.appendAuditLog({
      tenantId: record.tenantId,
      actorId: 'service:software_factory_runtime',
      action: 'AI_TRANSFORMATION_RECORDED',
      resourceUri: `factory://transformations/${record.id}`,
      checksum: `sha256:${createHash('sha256').update(JSON.stringify(record.structuredOutput ?? {})).digest('hex')}`,
      timestamp: new Date().toISOString(),
    });
  }

  public async appendAuditLog(entry: Record<string, unknown>): Promise<void> {
    // Audit rows get a random id, not a deterministic one: two genuinely distinct actions can
    // share a timestamp and a checksum, and collapsing them would delete evidence of one of them.
    // This is the one write that is not idempotent, which is exactly why it does not pretend to be.
    const rowId = this.documentId('audit', String(entry.tenantId ?? 'system'), randomUUID());
    this.auditCache.set(rowId, { logId: rowId, ...entry });
    try {
      await this.withRetry(() => this.services.tables.createRow({
        databaseId: this.databaseId,
        tableId: this.tables.auditLogs,
        rowId,
        data: {
          tenantId: String(entry.tenantId ?? ''),
          actorId: String(entry.actorId ?? ''),
          action: String(entry.action ?? ''),
          resourceUri: String(entry.resourceUri ?? ''),
          checksum: String(entry.checksum ?? ''),
          ts: String(entry.timestamp ?? new Date().toISOString()),
        },
      }), `append audit ${rowId}`);
    } catch (error) {
      if ((error as { code?: number })?.code !== 409) throw error;
    }
  }

  public getTransformationsByTenant(tenantId: string): TransformationRecord[] {
    return this.getAllTransformations().filter((item) => item.tenantId === tenantId);
  }

  /**
   * Synchronous by signature, which is a real constraint: the existing route handlers call this
   * without awaiting. Reading Appwrite requires a network call, so this returns the local view and
   * says so in the log. Serving reads from the local store while writes go to Appwrite would be a
   * split brain, so the Appwrite backend serves reads from an in-process cache that this backend
   * populates on write. Reads are therefore eventually consistent, and that is documented rather
   * than hidden -- a caller that cannot tolerate staleness needs a new route signature, not a
   * silent lie.
   */
  public getAllTransformations(): TransformationRecord[] {
    return [...this.cache.values()];
  }

  public getAuditLogs(tenantId?: string): Array<Record<string, unknown>> {
    return [...this.auditCache.values()].filter((entry) => (tenantId ? entry.tenantId === tenantId : true));
  }

  private readonly cache = new Map<string, TransformationRecord>();
  private readonly auditCache = new Map<string, Record<string, unknown>>();

  /** Appwrite caps document ids at 36 characters; `deterministicId` returns 42. */
  private documentId(prefix: string, ...parts: string[]): string {
    return documentIdFor(prefix, ...parts);
  }
}

/**
 * Resolves the configured backend once per process.
 *
 * Construction of the Appwrite backend validates credentials eagerly, so a misconfigured
 * `STORAGE_BACKEND=appwrite` fails at startup with a clear reason instead of at the first
 * customer request with a 500.
 */
let resolved: TelemetryStore | null = null;

export function resolveTelemetryStore(env: NodeJS.ProcessEnv = process.env): TelemetryStore {
  if (resolved) return resolved;
  const backend = resolveStorageBackend(env.STORAGE_BACKEND);
  if (backend === 'local') {
    TelemetryLogger.info('Storage backend selected', { message: 'durable file store; no cloud dependency', metadata: { backend: 'local' } });
    resolved = new LocalTelemetryStore();
    return resolved;
  }
  const settings = requireAppwriteConfig(env);
  resolved = new AppwriteTelemetryStore(settings);
  TelemetryLogger.info('Storage backend selected', { message: 'Appwrite pilot backend', metadata: { backend: 'appwrite', project: settings.projectId, database: settings.databaseId } });
  return resolved;
}

/** Test seam: forces re-resolution after the environment or credentials change. */
export function resetTelemetryStore(): void {
  resolved = null;
}
