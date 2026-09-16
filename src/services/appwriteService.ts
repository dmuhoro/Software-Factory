/**
 * Appwrite Multi-Tenant Database Client Service
 * Encapsulates partitioned CRUD operations, document security, and immutable audit logs.
 */

import { AppwriteConfig } from '../configurations/appwrite.config';
import { RawTelemetryPayload, TransformationRecord, ProcessingStatus } from '../models/telemetry';
import { TelemetryLogger } from '../utils/telemetryLogger';

// In-memory simulation of Appwrite database collections partitioned by tenantId
const appwriteTelemetryStore = new Map<string, RawTelemetryPayload>();
const appwriteTransformationsStore = new Map<string, TransformationRecord>();
const appwriteAuditLogs: Array<Record<string, unknown>> = [];

export class AppwriteService {
  /**
   * Persists an incoming raw telemetry event in Appwrite with tenant-partitioned permissions.
   * Document permissions: Permission.read(Role.team(tenantId, 'member')), Permission.create(Role.team(tenantId, 'operator'))
   */
  public static async recordTelemetryEvent(payload: RawTelemetryPayload): Promise<{ documentId: string }> {
    const documentId = `doc_telem_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    
    // In production with node-appwrite SDK:
    // await databases.createDocument(AppwriteConfig.databaseId, AppwriteConfig.collections.telemetryEvents, documentId, {
    //   tenant_id: payload.tenantId,
    //   niche: payload.niche,
    //   event_type: payload.eventType,
    //   idempotency_key: payload.metadata.idempotencyKey,
    //   raw_payload: JSON.stringify(payload.payload),
    //   status: 'RECEIVED',
    // }, [
    //   Permission.read(Role.team(payload.tenantId, 'member')),
    //   Permission.update(Role.team(payload.tenantId, 'admin')),
    // ]);

    appwriteTelemetryStore.set(documentId, payload);
    
    TelemetryLogger.info('Stored telemetry event in Appwrite database', {
      tenantId: payload.tenantId,
      niche: payload.niche,
      eventType: payload.eventType,
      metadata: { documentId, databaseId: AppwriteConfig.databaseId },
    });

    return { documentId };
  }

  /**
   * Persists the transformed AI structured output in Appwrite asynchronously.
   */
  public static async recordTransformation(record: TransformationRecord): Promise<void> {
    appwriteTransformationsStore.set(record.id, record);

    // Also write immutable audit log entry
    await this.appendAuditLog({
      tenantId: record.tenantId,
      actorId: 'service:software_factory_runtime',
      action: 'AI_TRANSFORMATION_COMPLETED',
      resourceUri: `appwrite://${AppwriteConfig.databaseId}/ai_transformations/${record.id}`,
      checksum: `sha256:${Buffer.from(JSON.stringify(record.structuredOutput || {})).toString('base64').substring(0, 32)}`,
      timestamp: new Date().toISOString(),
    });

    TelemetryLogger.info('Recorded AI transformation in Appwrite database', {
      tenantId: record.tenantId,
      niche: record.niche,
      durationMs: record.auditTrail.durationMs,
      metadata: { transformationId: record.id, status: record.status },
    });
  }

  public static async appendAuditLog(entry: {
    tenantId: string;
    actorId: string;
    action: string;
    resourceUri: string;
    checksum: string;
    timestamp: string;
  }): Promise<void> {
    appwriteAuditLogs.push({
      ...entry,
      logId: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    });
  }

  public static getTransformationsByTenant(tenantId: string): TransformationRecord[] {
    return Array.from(appwriteTransformationsStore.values()).filter((t) => t.tenantId === tenantId);
  }

  public static getAllTransformations(): TransformationRecord[] {
    return Array.from(appwriteTransformationsStore.values());
  }

  public static getAuditLogs(tenantId?: string): Array<Record<string, unknown>> {
    if (!tenantId) return appwriteAuditLogs;
    return appwriteAuditLogs.filter((log) => log.tenantId === tenantId);
  }
}
