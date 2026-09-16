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

    // Layer 3: Store raw telemetry document in Appwrite
    const { documentId } = await AppwriteService.recordTelemetryEvent(payload);

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
    const aiResult = await GeminiService.transformTelemetry(
      payload.tenantId,
      payload.niche,
      payload.eventType,
      adapterResult.result.normalizedPayload,
      correlationId
    );

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
