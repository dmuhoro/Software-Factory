import { Router, Request, Response } from 'express';
import { AppwriteService } from '../../services/appwriteService';
import { DurableStore, LEDGER_VERSION } from '../../services/durableStore';
import { resolveRuntimeConfig } from '../../configurations/runtimeConfig';
import { classifyReadiness } from '../../services/healthService';
import { NICHE_REGISTRY } from '../../configurations/factory.config';
import { APP_NAME, APP_VERSION } from '../../configurations/buildInfo';

const router = Router();
const startedAt = Date.now();

/**
 * Liveness and readiness probe.
 *
 * Reports the REAL state of the runtime. A previous version returned a hardcoded
 * `durableStore: 'healthy'` without ever touching the store, so an operator and an
 * orchestrator both saw green while the ledger was corrupt and unwritable.
 * `status` is derived, never asserted.
 */
router.get('/health', (_req: Request, res: Response) => {
  const readiness = classifyReadiness();
  const memory = process.memoryUsage();
  const heapTotalMb = Math.max(1, Math.round(memory.heapTotal / 1024 / 1024));
  const heapUsedMb = Math.round(memory.heapUsed / 1024 / 1024);
  const config = resolveRuntimeConfig();
  res.status(readiness.status === 'unhealthy' ? 503 : 200).json({
    status: readiness.status,
    // Honest runtime identity. This process is Node; it is not the Rust/Tokio engine.
    runtime: 'software-factory-node',
    engine: 'modular-monolith',
    // The deployed artifact's own name and version, read from package.json at runtime.
    // Without this a live URL gave no way to tell which build was actually serving.
    name: APP_NAME,
    version: APP_VERSION,
    ledgerVersion: LEDGER_VERSION,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    checks: readiness.checks,
    recovery: DurableStore.lastRecovery() ?? null,
    systemHealth: {
      memory: { heapUsedMb, heapTotalMb, rssMb: Math.round(memory.rss / 1024 / 1024), memoryPressureScore: Math.round((heapUsedMb / heapTotalMb) * 100) },
      process: { pid: process.pid, node: process.version },
    },
  });
});

/** True when the ledger is readable and writable right now. Used by the health check. */
router.get('/ready', (_req: Request, res: Response) => {
  const readiness = classifyReadiness();
  res.status(readiness.status === 'unhealthy' ? 503 : 200).json({ status: readiness.status, checks: readiness.checks });
});

router.get('/metrics', async (_req: Request, res: Response) => {
  const records = await AppwriteService.getAllTransformations();
  const durations = records.map((record) => record.auditTrail.durationMs).sort((a, b) => a - b);
  const successes = records.filter((record) => record.status === 'COMPLETED').length;
  const p = (quantile: number) => (durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * quantile))] : 0);
  const stats = DurableStore.stats();
  res.json({
    status: 'success',
    metrics: {
      totalTransformations: records.length,
      successfulTransformations: successes,
      failedTransformations: records.length - successes,
      averageLatencyMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
      latencyMs: { p50: p(0.5), p95: p(0.95), p99: p(0.99) },
      activeTenantsCount: new Set(records.map((record) => record.tenantId)).size,
      auditEntries: stats.audits,
      ledgerRecords: stats.collections,
      ledgerDegraded: stats.degraded,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      // Quotas are declared per subscription tier in factory.config.ts. This list was a
      // hardcoded array that included 'custom_b2b' while that niche had no working adapter,
      // so the metrics endpoint advertised a capability the pipeline could not deliver. It is
      // now derived from the registry, which is the single place that knows which niches are
      // actually served -- and a hand-maintained list beside a registry is exactly the pair
      // that drifts.
      supportedNiches: Object.values(NICHE_REGISTRY)
        .filter((niche) => niche.operational)
        .map((niche) => niche.niche),
    },
  });
});

export default router;
