/**
 * Global Shared Types for Software Factory Dashboard & Telemetry
 */

import { IndustryNiche } from './models/tenant';

export interface TelemetryExecutionLog {
  id: string;
  timestamp: string;
  status: 'success' | 'error';
  correlationId: string;
  tenantId: string;
  niche: IndustryNiche;
  eventType: string;
  durationMs: number;
  tokensConsumed?: number;
  confidenceScore?: number;
  structuredOutput?: any;
  error?: any;
  payloadSnapshot: any;
}

export type AutoRefreshInterval = 'manual' | '5s' | '30s';

export interface SystemHealthStats {
  heapUsedMb: number;
  heapTotalMb: number;
  rssMb: number;
  rustTokioHeapMb: number;
  memoryPressureScore: number;
  totalWorkerThreads: number;
  activeTasks: number;
  queuedTasks: number;
  saturationPercent: number;
  workStealingEfficiency: string;
  circuitBreakerState: 'CLOSED' | 'HALF_OPEN' | 'OPEN';
  circuitBreakers?: {
    geminiEngine: 'CLOSED' | 'HALF_OPEN' | 'OPEN';
    appwriteLedger: 'CLOSED' | 'HALF_OPEN' | 'OPEN';
    downstreamGateways: 'CLOSED' | 'HALF_OPEN' | 'OPEN';
  };
  hpaReplicas: number;
  uptimeSeconds?: number;
  lastUpdated?: string;
}

export interface RustTimeSeriesMetric {
  time: string;
  throughputRpm: number;
  latencyP50: number;
  latencyP95: number;
  latencyP99: number;
  tokenRateK: number;
}

export interface TenantConfigFlags {
  tenantId: string;
  fairHousingGuardrails: boolean;
  hipaaStrictRedaction: boolean;
  coldchainTempAlerting: boolean;
  autoDbSync: boolean;
  auditLedgerMirroring: boolean;
  isActive: boolean;
}
