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

export interface HealthCheckDetail {
  name: string;
  state: 'pass' | 'warn' | 'fail';
  detail: string;
}

/**
 * The runtime health a Node process can actually measure.
 *
 * This shape is deliberately narrow. A previous version carried `rustTokioHeapMb`,
 * `totalWorkerThreads`, `circuitBreakers`, `hpaReplicas` and `saturationPercent` --
 * fields the Node server never sends. The dashboard read them anyway, threw on
 * `systemHealth.threadpool`, swallowed the exception, and rendered nothing while
 * looking like a health board. Every field below maps to a value the server really
 * produces, so the display cannot claim a runtime this service does not run.
 */
export interface SystemHealthStats {
  status: 'healthy' | 'degraded' | 'unhealthy';
  name: string;
  version: string;
  heapUsedMb: number;
  heapTotalMb: number;
  rssMb: number;
  memoryPressureScore: number;
  uptimeSeconds: number;
  checks: Record<string, string>;
  checkDetails: HealthCheckDetail[];
  recovery: { occurredAt: string; restoredFromBackup: boolean; recordsLost: number } | null;
  lastUpdated: string;
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
