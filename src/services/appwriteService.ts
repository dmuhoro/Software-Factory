/** Durable persistence port for founder mode and future Appwrite replacement. */
import crypto from 'node:crypto';
import { RawTelemetryPayload, TransformationRecord } from '../models/telemetry';
import { DurableStore } from './durableStore';
import { TelemetryLogger } from '../utils/telemetryLogger';

export class AppwriteService {
  public static async recordTelemetryEvent(payload: RawTelemetryPayload): Promise<{ documentId: string }> {
    const idempotencyKey = payload.metadata.idempotencyKey;
    const existing = DurableStore.list('telemetry').find(
      (item) => item.tenantId === payload.tenantId && (item.metadata as Record<string, unknown> | undefined)?.idempotencyKey === idempotencyKey,
    );
    if (existing?.id) return { documentId: String(existing.id) };

    const documentId = DurableStore.id('doc_telem', `${payload.tenantId}:${idempotencyKey}`);
    DurableStore.upsert('telemetry', documentId, { ...payload, id: documentId, persistedAt: new Date().toISOString() } as unknown as Record<string, unknown>);
    TelemetryLogger.info('Persisted telemetry event', { tenantId: payload.tenantId, niche: payload.niche, eventType: payload.eventType, metadata: { documentId } });
    return { documentId };
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
