/**
 * Compatibility facade over the selected storage backend.
 *
 * ## Why this file still exists
 *
 * Four call sites -- two route handlers, the pipeline orchestrator, and a regression test -- call
 * `AppwriteService` with a static API. This module keeps that exact surface and forwards to
 * whichever backend `STORAGE_BACKEND` selected. Nothing at the call sites changed, which is the
 * point: backend selection is a deployment concern, and it should not ripple into route handlers.
 *
 * The class is named `AppwriteService` even though it may be backed by the local store, because
 * renaming it would touch every call site for no behavioural gain. The confusion it once caused has
 * been fixed at the source -- the implementation that was misleadingly named now lives in
 * `localTelemetryStore.ts` under its true name, and this file is unambiguously a facade.
 *
 * ## Static methods and a mutable process-wide backend
 *
 * The static API forces a process-wide singleton, resolved on first use. That is a real
 * limitation rather than a convenience: a test cannot hold two backends at once, and a process
 * cannot switch backends at runtime. Neither is wanted here -- a process should use one store, and
 * switching mid-flight is precisely the split-brain this design exists to prevent. `resetTelemetryStore`
 * exists for tests and is not part of the production surface.
 */
import type { RawTelemetryPayload, TransformationRecord } from '../models/telemetry';
import { resolveTelemetryStore } from './telemetryStore';

export class AppwriteService {
  public static async recordTelemetryEvent(payload: RawTelemetryPayload): Promise<{ documentId: string; deduplicated: boolean }> {
    return resolveTelemetryStore().recordTelemetryEvent(payload);
  }

  public static async recordTransformation(record: TransformationRecord): Promise<void> {
    return resolveTelemetryStore().recordTransformation(record);
  }

  public static async appendAuditLog(entry: Record<string, unknown>): Promise<void> {
    return resolveTelemetryStore().appendAuditLog(entry);
  }

  public static async getTransformationsByTenant(tenantId: string, limit?: number): Promise<TransformationRecord[]> {
    return resolveTelemetryStore().getTransformationsByTenant(tenantId, limit);
  }

  public static async getAllTransformations(limit?: number): Promise<TransformationRecord[]> {
    return resolveTelemetryStore().getAllTransformations(limit);
  }

  public static async getAuditLogs(tenantId?: string, limit?: number): Promise<Array<Record<string, unknown>>> {
    return resolveTelemetryStore().getAuditLogs(tenantId, limit);
  }

  /** Which backend is actually serving this process, for the startup banner and for operators. */
  public static activeBackend(): string {
    return resolveTelemetryStore().name;
  }
}
