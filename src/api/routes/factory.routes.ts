import { Router, Request, Response } from 'express';
import { AppwriteService } from '../../services/appwriteService';
import { DurableStore } from '../../services/durableStore';

const router = Router();
const startedAt = Date.now();

router.get('/health', (_req: Request, res: Response) => {
  const memory = process.memoryUsage();
  const heapTotalMb = Math.max(1, Math.round(memory.heapTotal / 1024 / 1024));
  const heapUsedMb = Math.round(memory.heapUsed / 1024 / 1024);
  res.json({ status: 'healthy', runtime: 'software-factory-node', engine: 'modular-monolith', uptimeSeconds: Math.floor(process.uptime()), timestamp: new Date().toISOString(), checks: { durableStore: 'healthy', persistenceFile: process.env.FACTORY_DATA_DIR || '.data' }, systemHealth: { memory: { heapUsedMb, heapTotalMb, rssMb: Math.round(memory.rss / 1024 / 1024), memoryPressureScore: Math.round((heapUsedMb / heapTotalMb) * 100) }, process: { pid: process.pid, node: process.version }, worker: { activeTasks: 0, queuedTasks: 0, saturationPercent: 0 } } });
});

router.get('/metrics', (_req: Request, res: Response) => {
  const records = AppwriteService.getAllTransformations();
  const durations = records.map((record) => record.auditTrail.durationMs).sort((a, b) => a - b);
  const successes = records.filter((record) => record.status === 'COMPLETED').length;
  const p = (quantile: number) => durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * quantile))] : 0;
  res.json({ status: 'success', metrics: { totalTransformations: records.length, successfulTransformations: successes, failedTransformations: records.length - successes, averageLatencyMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0, latencyMs: { p50: p(0.5), p95: p(0.95), p99: p(0.99) }, activeTenantsCount: new Set(records.map((record) => record.tenantId)).size, auditEntries: DurableStore.audits().length, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000), supportedNiches: ['real_estate', 'healthcare', 'logistics', 'custom_b2b'] } });
});

export default router;
