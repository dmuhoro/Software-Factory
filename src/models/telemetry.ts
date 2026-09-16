/**
 * Telemetry and Transformation Models
 * Standardized payload structures for multi-niche asynchronous streams.
 */

import { IndustryNiche } from './tenant';

export enum ProcessingStatus {
  RECEIVED = 'RECEIVED',
  VALIDATING = 'VALIDATING',
  ROUTED_TO_ADAPTER = 'ROUTED_TO_ADAPTER',
  AI_PROCESSING = 'AI_PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  DLQ_ROUTED = 'DLQ_ROUTED',
}

export interface TelemetryMetadata {
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

export interface TransformationAuditTrail {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  tokensConsumed?: number;
  modelUsed?: string;
  retryAttempts: number;
  circuitBreakerStatus: 'CLOSED' | 'HALF_OPEN' | 'OPEN';
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
