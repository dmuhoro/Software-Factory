import fs from 'node:fs';
import path from 'node:path';
import { DurableStore } from './durableStore';
import { resolveRuntimeConfig } from '../configurations/runtimeConfig';
import { errorsOf } from '../configurations/runtimeConfig';

export type ReadinessStatus = 'healthy' | 'degraded' | 'unhealthy';
export type CheckState = 'pass' | 'warn' | 'fail';
export interface ReadinessCheck { name: string; state: CheckState; detail: string; }
export interface ReadinessReport { status: ReadinessStatus; checks: ReadinessCheck[]; }

/**
 * Free-space floor below which the data directory is unfit to serve.
 *
 * The ledger is a whole-file JSON rewrite: every write serialises the entire document and
 * replaces the file. A filesystem with only a sliver of free space can accept a small probe
 * write and still fail the next real rewrite mid-serialisation — which truncates the ledger.
 * 64 MiB is far more than a healthy ledger needs and far less than a typical volume, so it
 * refuses only when the volume is genuinely near exhaustion. The write/fsync probe below is
 * the authoritative durability test; this floor is the early warning that precedes it.
 */
export const MIN_FREE_BYTES = 64 * 1024 * 1024;

function mebibytes(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

/** Pure decision for the disk-space arm, so the threshold boundary is unit-testable. */
export function evaluateFreeSpace(freeBytes: number): ReadinessCheck {
  if (!Number.isFinite(freeBytes) || freeBytes < 0) {
    return { name: 'storage', state: 'warn', detail: 'free space could not be computed' };
  }
  if (freeBytes < MIN_FREE_BYTES) {
    return { name: 'storage', state: 'fail', detail: `${mebibytes(freeBytes)}MiB free at the data directory; below the ${mebibytes(MIN_FREE_BYTES)}MiB floor below which the whole-file ledger rewrite can fail mid-write` };
  }
  return { name: 'storage', state: 'pass', detail: `${mebibytes(freeBytes)}MiB free` };
}

/**
 * Probes the data directory the ledger is written to: that it exists, that it accepts a write
 * and *flushes it* (`fsync`), and that it has room for the next whole-file rewrite.
 *
 * The ledger probe above proves the store's own write path. This proves the ground it stands
 * on: a directory that accepts a buffered write but cannot `fsync` it reports success and can
 * still lose the record on power loss — the store would call that a healthy write. The write
 * is a fixed, bounded payload, and the probe file is always removed, so the probe never grows
 * the ledger or leaves litter an operator has to clean.
 */
function checkStorage(): ReadinessCheck {
  const dir = path.dirname(DurableStore.dataFile());
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    return { name: 'storage', state: 'fail', detail: `data directory ${dir} is not creatable: ${(error as Error).message}` };
  }

  const probeFile = path.join(dir, `.health-${process.pid}-${Date.now()}.tmp`);
  const payload = Buffer.from(`healthcheck ${new Date().toISOString()} ${'x'.repeat(16)}\n`);
  try {
    const fd = fs.openSync(probeFile, 'w', 0o600);
    try {
      fs.writeSync(fd, payload);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const readBack = fs.readFileSync(probeFile);
    if (!readBack.equals(payload)) {
      return { name: 'storage', state: 'fail', detail: `the data directory ${dir} returned different bytes than were written; storage is not trustworthy` };
    }
  } catch (error) {
    return { name: 'storage', state: 'fail', detail: `data directory ${dir} is not writable or not fsync-durable: ${(error as Error).message}` };
  } finally {
    try { fs.unlinkSync(probeFile); } catch { /* removed or never created */ }
  }

  try {
    const stat = fs.statfsSync(dir);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    const space = evaluateFreeSpace(freeBytes);
    if (space.state !== 'pass') return space;
    return { name: 'storage', state: 'pass', detail: `writable and fsync-durable at ${dir}; ${mebibytes(freeBytes)}MiB free` };
  } catch (error) {
    // The write/fsync probe above already proved durability; a platform that cannot report
    // free space is a warning to the operator, not grounds to take a working service down.
    return { name: 'storage', state: 'warn', detail: `writable and fsync-durable, but free space could not be measured at ${dir}: ${(error as Error).message}` };
  }
}

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
      // A `fail`, not a `warn`. This adapter writes the whole ledger file on every change,
      // so two live writers means one silently overwrites the other's records. That is
      // data loss, not a degraded condition, and a process that cannot guarantee its own
      // writes must not accept traffic. Startup treats `unhealthy` as fatal.
      return { name: 'durableStore', state: 'fail', detail: 'another process holds the writer lock; this adapter is single-writer and will not serve alongside it' };
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
    checks: [probeLedger(), checkStorage(), checkConfiguration(), checkRuntime()],
  };
  return collect(report);
}
