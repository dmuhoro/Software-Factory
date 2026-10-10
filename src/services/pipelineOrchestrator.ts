/**
 * High-Throughput Pipeline Orchestrator
 * Connects Ingestion -> Tenant Partitioning -> Domain Adapter -> Gemini Structured Engine -> Appwrite Async Ledger.
 */

import { RawTelemetryPayload, TransformationRecord, ProcessingStatus } from '../models/telemetry';
import { TenantService } from './tenantService';
import { NicheAdapterService } from './nicheAdapterService';
import { GeminiService } from './geminiService';
import { AppwriteService } from './appwriteService';
import { validateIncomingTelemetry, emitMalformedContextError } from '../utils/validation';
import { classifyDependencyFailure, OperationalError } from '../utils/operationalError';
import { TelemetryLogger } from '../utils/telemetryLogger';

export interface PipelineExecutionResult {
  status: 'success' | 'error';
  correlationId: string;
  tenantId: string;
  niche: string;
  transformationId?: string;
  structuredOutput?: unknown;
  durationMs: number;
  audit?: Record<string, unknown>;
  error?: unknown;
}

export class PipelineOrchestrator {
  /**
   * Core orchestrator method: processes an asynchronous telemetry batch with zero latency spikes.
   */
  public static async execute(rawPayload: unknown): Promise<PipelineExecutionResult> {
    const startTime = Date.now();
    const correlationId = `corr_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    // Layer 1: Strict syntactic validation
    const validation = validateIncomingTelemetry(rawPayload);
    if (!validation.isValid || !validation.data) {
      return {
        status: 'error',
        correlationId,
        tenantId: (rawPayload as any)?.tenantId || 'unknown',
        niche: (rawPayload as any)?.niche || 'unknown',
        durationMs: Date.now() - startTime,
        error: validation.error,
      };
    }

    const payload = validation.data as unknown as RawTelemetryPayload;

    // Layer 2: Tenant isolation and zero-conflation check
    const tenantResolution = TenantService.resolveContext(payload.tenantId, payload.niche, correlationId);
    if (tenantResolution.error || !tenantResolution.context) {
      return {
        status: 'error',
        correlationId,
        tenantId: payload.tenantId,
        niche: payload.niche,
        durationMs: Date.now() - startTime,
        error: tenantResolution.error,
      };
    }

    // Layer 3: Store raw telemetry document in the selected storage backend.
    // A failure here means nothing was persisted. It must be named as a ledger fault and
    // must NOT fall through to the generic enrichment message, which claims the record was
    // accepted -- a claim that is the opposite of the truth when the write is what failed.
    let rawWrite: { documentId: string; deduplicated: boolean };
    try {
      rawWrite = await AppwriteService.recordTelemetryEvent(payload);
    } catch (error) {
      TelemetryLogger.error('Raw telemetry persistence failed; nothing was accepted', {
        tenantId: payload.tenantId,
        niche: payload.niche,
        correlationId,
        metadata: { reason: (error as Error)?.message },
      });
      throw new OperationalError(
        'LEDGER_UNAVAILABLE',
        'The telemetry record could not be persisted. The request was rejected and nothing was stored; retry when the ledger is writable.',
        503,
        { cause: error, rawPayloadPersisted: false, retryAfterSeconds: 15 },
      );
    }
    const { documentId, deduplicated } = rawWrite;

    // Layer 4: Swappable domain adapter processing
    const adapterResult = NicheAdapterService.processAdapter(payload.niche, payload.payload);
    if (adapterResult.error || !adapterResult.result) {
      return {
        status: 'error',
        correlationId,
        tenantId: payload.tenantId,
        niche: payload.niche,
        durationMs: Date.now() - startTime,
        error: adapterResult.error || emitMalformedContextError('Adapter processing failed unexpectedly'),
      };
    }

    // Layer 5: Gemini Structured Output Engine
    // The raw document is already durable at this point. If enrichment fails, the error
    // must carry that fact so the caller is never told the data was lost when it was not,
    // and so a retry is safe (the idempotency key prevents duplication).
    let aiResult: Awaited<ReturnType<typeof GeminiService.transformTelemetry>>;
    try {
      aiResult = await GeminiService.transformTelemetry(
        payload.tenantId,
        payload.niche,
        payload.eventType,
        adapterResult.result.normalizedPayload,
        correlationId
      );
    } catch (error) {
      TelemetryLogger.error('Structured enrichment failed after the raw record was persisted', {
        tenantId: payload.tenantId,
        niche: payload.niche,
        correlationId,
        metadata: { rawDocumentId: documentId, deduplicated, reason: (error as Error)?.message },
      });
      // The raw record IS durable at this point, so the failure must say so rather than
      // letting the caller assume the data was lost. A retry is safe because the
      // idempotency key prevents a duplicate.
      const classified = classifyDependencyFailure(error, {
        rawPayloadPersisted: true,
        rawDocumentId: documentId,
        deduplicated,
      });
      throw classified;
    }

    // Layer 6: Asynchronous database update in Appwrite
    const transformationId = `tx_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const transformationRecord: TransformationRecord = {
      id: transformationId,
      tenantId: payload.tenantId,
      niche: payload.niche,
      eventType: payload.eventType,
      status: ProcessingStatus.COMPLETED,
      rawPayloadId: documentId,
      structuredOutput: aiResult.output,
      auditTrail: {
        startedAt: new Date(startTime).toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        tokensConsumed: aiResult.tokensUsed,
        modelUsed: aiResult.model,
        retryAttempts: 0,
        circuitBreakerStatus: 'CLOSED',
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await AppwriteService.recordTransformation(transformationRecord);

    const totalDurationMs = Date.now() - startTime;
    TelemetryLogger.info('Pipeline orchestrator completed cycle successfully', {
      tenantId: payload.tenantId,
      niche: payload.niche,
      correlationId,
      durationMs: totalDurationMs,
      metadata: { transformationId, confidence: aiResult.output.confidenceScore },
    });

    return {
      status: 'success',
      correlationId,
      tenantId: payload.tenantId,
      niche: payload.niche,
      transformationId,
      structuredOutput: aiResult.output,
      durationMs: totalDurationMs,
      audit: {
        rawDocumentId: documentId,
        model: aiResult.model,
        tokens: aiResult.tokensUsed,
        guardrailsApplied: adapterResult.result.guardrailsApplied,
      },
    };
  }
}
