import path from 'node:path';
import { DurableStore } from './durableStore';
import { resolveRuntimeConfig } from '../configurations/runtimeConfig';
import { errorsOf } from '../configurations/runtimeConfig';

export type ReadinessStatus = 'healthy' | 'degraded' | 'unhealthy';
export type CheckState = 'pass' | 'warn' | 'fail';
export interface ReadinessCheck { name: string; state: CheckState; detail: string; }
export interface ReadinessReport { status: ReadinessStatus; checks: ReadinessCheck[]; }

function collect(report: ReadinessReport) {
  const status: ReadinessStatus = report.checks.some((check) => check.state === 'fail') ? 'unhealthy'
    : report.checks.some((check) => check.state === 'warn') ? 'degraded'
      : 'healthy';
  return {
    status,
    checks: Object.fromEntries(report.checks.map((check) => [check.name, check.state === 'fail' ? 'unhealthy' : check.state === 'warn' ? 'degraded' : 'healthy'])),
    details: report.checks,
  };
}

/**
 * Probes the durable ledger through the store's own API, by writing and reading a
 * throwaway record.
 *
 * The previous health endpoint returned a hardcoded 'healthy' string without touching
 * the store, so a corrupt ledger was reported as healthy. It is also important that
 * this probe goes through `DurableStore` rather than reading the file directly: the
 * store owns recovery, so a direct read would report "unreadable" for a ledger that
 * the store is about to recover successfully.
 */
function probeLedger(): ReadinessCheck {
  try {
    // Touching the store forces the load/recovery path to run.
    const stats = DurableStore.stats();
    const probeId = DurableStore.deterministicId('healthcheck', String(process.pid), String(Date.now()));
    DurableStore.upsert('qualitySnapshots', probeId, {
      id: probeId, tenantId: '__healthcheck__', productName: 'ledger write probe', score: 0,
      baselineScore: 0, improvementPercent: 0,
      dimensions: { verification: 0, security: 0, evidence: 0, operability: 0, productDiscipline: 0 },
      evidenceKinds: [], recordedAt: new Date().toISOString(),
    });
    if (!DurableStore.exists('qualitySnapshots', probeId)) {
      return { name: 'durableStore', state: 'fail', detail: 'write probe did not persist' };
    }
    if (DurableStore.isDegraded()) {
      const recovery = DurableStore.lastRecovery();
      return { name: 'durableStore', state: 'warn', detail: `recovered from an unreadable ledger at ${recovery?.occurredAt}; restoredFromBackup=${recovery?.restoredFromBackup} recordsLost=${recovery?.recordsLost}` };
    }
    if (DurableStore.hasContendedWriter()) {
      return { name: 'durableStore', state: 'warn', detail: 'another process holds the writer lock; this adapter is single-writer' };
    }
    return { name: 'durableStore', state: 'pass', detail: `readable and writable at ${path.basename(DurableStore.dataFile())}; ${Object.values(stats.collections).reduce((a, b) => a + b, 0)} records` };
  } catch (error) {
    return { name: 'durableStore', state: 'fail', detail: `ledger unusable: ${(error as Error).message}` };
  }
}

function checkConfiguration(): ReadinessCheck {
  const errors = errorsOf(resolveRuntimeConfig());
  // A production process with configuration errors would not have started, so
  // reaching here with errors means the mode changed under us.
  if (errors.length > 0) return { name: 'configuration', state: 'fail', detail: errors.map((issue) => `${issue.variable}: ${issue.message}`).join('; ') };
  const warnings = resolveRuntimeConfig().issues.filter((issue) => issue.severity === 'warning');
  if (warnings.length > 0) return { name: 'configuration', state: 'warn', detail: warnings.map((issue) => issue.variable).join(', ') };
  return { name: 'configuration', state: 'pass', detail: 'no configuration issues' };
}

function checkRuntime(): ReadinessCheck {
  const heapUsedMb = process.memoryUsage().heapUsed / 1024 / 1024;
  const heapTotalMb = Math.max(1, process.memoryUsage().heapTotal / 1024 / 1024);
  const pressure = heapUsedMb / heapTotalMb;
  if (pressure > 0.95) return { name: 'runtime', state: 'warn', detail: `heap pressure ${Math.round(pressure * 100)}%` };
  return { name: 'runtime', state: 'pass', detail: `heap ${Math.round(heapUsedMb)}MB / ${Math.round(heapTotalMb)}MB` };
}

/**
 * Classifies overall readiness. `unhealthy` is reserved for conditions that make the
 * process unable to serve correct work; `degraded` means it can serve but an operator
 * must know. The distinction is load-bearing: a degraded ledger that has lost records
 * must not be silently green, but it also must not take a working service out of a
 * load balancer when the service is still answering correctly.
 */
export function classifyReadiness(): { status: ReadinessStatus; checks: Record<string, string>; details: ReadinessCheck[] } {
  const report: ReadinessReport = {
    status: 'healthy',
    checks: [probeLedger(), checkConfiguration(), checkRuntime()],
  };
  return collect(report);
}
