/**
 * Telemetry and Transformation Models
 * Standardized payload structures for multi-niche asynchronous streams.
 */

import { IndustryNiche } from './tenant';

export enum ProcessingStatus {
  COMPLETED = 'COMPLETED',
}

interface TelemetryMetadata {
  sourceSystem: string;
  region: string;
  clientVersion: string;
  ipHash?: string;
  idempotencyKey: string;
}

export interface RawTelemetryPayload {
  tenantId: string;
  niche: IndustryNiche;
  eventType: string;
  timestamp: string;
  payload: Record<string, unknown>;
  metadata: TelemetryMetadata;
}

interface TransformationAuditTrail {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  tokensConsumed?: number;
  modelUsed?: string;
  retryAttempts: number;
  /**
   * The enrichment circuit breaker's state at the moment the record was written, read from
   * the live breaker rather than asserted. `UNKNOWN` is the honest value for a legacy row
   * written before this column existed: the state is not knowable, so it is not guessed.
   */
  circuitBreakerStatus: 'CLOSED' | 'HALF_OPEN' | 'OPEN' | 'UNKNOWN';
}

export interface StructuredAiOutput<T = Record<string, unknown>> {
  status: 'success' | 'flagged' | 'quarantined';
  confidenceScore: number;
  nicheSpecificResult: T;
  recommendedActions: string[];
  anomaliesDetected: string[];
  complianceVerified: boolean;
}

export interface TransformationRecord {
  id: string; // Document ID
  tenantId: string; // Partition key
  niche: IndustryNiche;
  eventType: string;
  status: ProcessingStatus;
  rawPayloadId: string;
  structuredOutput?: StructuredAiOutput;
  auditTrail: TransformationAuditTrail;
  errorMessage?: string;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
}
