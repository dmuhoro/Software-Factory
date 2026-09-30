/**
 * The local durable store: the offline default backend.
 *
 * Formerly this file was `appwriteService.ts`, a class named for Appwrite that had never spoken
 * to Appwrite. The rename is the point. A class whose name promised a cloud integration while its
 * code wrote to a local file is why this repository carried two persistence stories and no ADR:
 * the decision was not avoided, it was camouflaged. Naming the backend after what it does makes
 * the choice explicit, reviewable, and impossible to misread in a log line.
 */
import crypto from 'node:crypto';
import { RawTelemetryPayload, TransformationRecord } from '../models/telemetry';
import { DurableStore } from './durableStore';
import { TelemetryLogger } from '../utils/telemetryLogger';

/** Shared read bounds, so both adapters cap a page identically. */
export const DEFAULT_READ_LIMIT = 100;
export const MAX_READ_LIMIT = 500;

export function boundedLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_READ_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_READ_LIMIT);
}

/** Newest first by `createdAt`, falling back to the end of the list when it is absent. */
function bounded<T extends { createdAt?: string; timestamp?: string }>(rows: T[], limit?: number): T[] {
  const size = boundedLimit(limit);
  const ordered = [...rows].sort((a, b) => String(b.createdAt ?? b.timestamp ?? '').localeCompare(String(a.createdAt ?? a.timestamp ?? '')));
  return ordered.slice(0, size);
}

export class LocalStore {
  /**
   * Persists a telemetry event under the ADR-001 composite key [tenant_id, idempotency_key].
   *
   * The document id is derived deterministically from that pair, so a replayed event
   * resolves to the same id and is reported as a duplicate. This replaces a previous
   * implementation that scanned the entire telemetry collection on every ingest, which
   * was both O(n) per write and racy between concurrent replays.
   */
  public async recordTelemetryEvent(payload: RawTelemetryPayload): Promise<{ documentId: string; deduplicated: boolean }> {
    const idempotencyKey = payload.metadata.idempotencyKey;
    const documentId = DurableStore.deterministicId('doc_telem', payload.tenantId, idempotencyKey);
    if (DurableStore.exists('telemetry', documentId)) return { documentId, deduplicated: true };
    DurableStore.upsert('telemetry', documentId, { ...payload, id: documentId, persistedAt: new Date().toISOString() } as unknown as Record<string, unknown>);
    TelemetryLogger.info('Persisted telemetry event', { tenantId: payload.tenantId, niche: payload.niche, eventType: payload.eventType, metadata: { documentId } });
    return { documentId, deduplicated: false };
  }

  public async recordTransformation(record: TransformationRecord): Promise<void> {
    DurableStore.upsert('transformations', record.id, record as unknown as Record<string, unknown>);
    await this.appendAuditLog({
      tenantId: record.tenantId,
      actorId: 'service:software_factory_runtime',
      action: 'AI_TRANSFORMATION_RECORDED',
      resourceUri: `factory://transformations/${record.id}`,
      checksum: `sha256:${crypto.createHash('sha256').update(JSON.stringify(record.structuredOutput || {})).digest('hex')}`,
      timestamp: new Date().toISOString(),
    });
    TelemetryLogger.info('Recorded durable transformation', { tenantId: record.tenantId, niche: record.niche, durationMs: record.auditTrail.durationMs, metadata: { transformationId: record.id, status: record.status } });
  }

  public async appendAuditLog(entry: Record<string, unknown>): Promise<void> {
    DurableStore.appendAudit({ ...entry, logId: DurableStore.id('audit', JSON.stringify(entry)) });
  }

  /**
   * Newest first, and bounded. The local store is a full in-memory list, so a limit here is a slice
   * rather than a datastore `limit` query -- but the ordering and the cap still match the Appwrite
   * adapter, so a caller cannot see a different shape of answer depending on the backend.
   */
  public getTransformationsByTenant(tenantId: string, limit?: number): TransformationRecord[] {
    const rows = (DurableStore.list('transformations') as unknown as TransformationRecord[])
      .filter((item) => item.tenantId === tenantId);
    return bounded(rows, limit);
  }

  public getAllTransformations(limit?: number): TransformationRecord[] {
    return bounded(DurableStore.list('transformations') as unknown as TransformationRecord[], limit);
  }

  public getAuditLogs(tenantId?: string, limit?: number): Array<Record<string, unknown>> {
    return bounded(DurableStore.audits(tenantId) as Array<Record<string, unknown>>, limit);
  }
}
