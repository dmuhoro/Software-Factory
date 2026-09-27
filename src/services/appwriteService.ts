/** Durable persistence port for founder mode and future Appwrite replacement. */
import crypto from 'node:crypto';
import { RawTelemetryPayload, TransformationRecord } from '../models/telemetry';
import { DurableStore } from './durableStore';
import { TelemetryLogger } from '../utils/telemetryLogger';

export class AppwriteService {
  /**
   * Persists a telemetry event under the ADR-001 composite key [tenant_id, idempotency_key].
   *
   * The document id is derived deterministically from that pair, so a replayed event
   * resolves to the same id and is reported as a duplicate. This replaces a previous
   * implementation that scanned the entire telemetry collection on every ingest, which
   * was both O(n) per write and racy between concurrent replays.
   */
  public static async recordTelemetryEvent(payload: RawTelemetryPayload): Promise<{ documentId: string; deduplicated: boolean }> {
    const idempotencyKey = payload.metadata.idempotencyKey;
    const documentId = DurableStore.deterministicId('doc_telem', payload.tenantId, idempotencyKey);
    if (DurableStore.exists('telemetry', documentId)) return { documentId, deduplicated: true };
    DurableStore.upsert('telemetry', documentId, { ...payload, id: documentId, persistedAt: new Date().toISOString() } as unknown as Record<string, unknown>);
    TelemetryLogger.info('Persisted telemetry event', { tenantId: payload.tenantId, niche: payload.niche, eventType: payload.eventType, metadata: { documentId } });
    return { documentId, deduplicated: false };
  }

  public static async recordTransformation(record: TransformationRecord): Promise<void> {
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

  public static async appendAuditLog(entry: Record<string, unknown>): Promise<void> {
    DurableStore.appendAudit({ ...entry, logId: DurableStore.id('audit', JSON.stringify(entry)) });
  }

  public static getTransformationsByTenant(tenantId: string): TransformationRecord[] {
    return DurableStore.list('transformations').filter((item) => item.tenantId === tenantId) as unknown as TransformationRecord[];
  }

  public static getAllTransformations(): TransformationRecord[] {
    return DurableStore.list('transformations') as unknown as TransformationRecord[];
  }

  public static getAuditLogs(tenantId?: string): Array<Record<string, unknown>> {
    return DurableStore.audits(tenantId);
  }
}
