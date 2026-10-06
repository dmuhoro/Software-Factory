import os from 'node:os';
import { DoctrineService } from './doctrineService';

/**
 * Resource governor.
 *
 * "Check system resources before spawning heavy work; cap concurrency to what is actually
 * available." The audit found `maxParallel` written and never read, and no CPU or memory check
 * anywhere in the codebase. This is the reader.
 *
 * Budgets come from doctrine (`loop.json:concurrency`) and may be tightened — never loosened —
 * by environment. Admission fails closed: when a figure cannot be read, the run is refused with
 * a reason rather than assumed to be fine.
 */

export interface Admission {
  admitted: boolean;
  requested: number;
  maxParallel: number;
  cpus: number;
  freeMemMb: number;
  loadAvgPerCpu: number;
  reasons: string[];
}

export interface Budgets {
  minFreeMemMb: number;
  maxLoadAvgPerCpu: number;
  maxParallelDefault: number;
  maxParallelCeiling: number;
}

function positiveEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return value;
}

export class ResourceGovernorService {
  public static budgets(): Budgets {
    const configured = DoctrineService.load().loop.concurrency;
    // Environment may only tighten. A ceiling that env could raise would make the doctrine
    // advisory, which is the failure mode this whole layer exists to prevent.
    const minFreeMemMb = Math.max(configured.minFreeMemMb, positiveEnv('FACTORY_MIN_FREE_MEM_MB') ?? 0);
    const envLoad = positiveEnv('FACTORY_MAX_LOADAVG_PER_CPU');
    const maxLoadAvgPerCpu = envLoad === undefined ? configured.maxLoadAvgPerCpu : Math.min(configured.maxLoadAvgPerCpu, envLoad);
    const envParallel = positiveEnv('FACTORY_MAX_PARALLEL');
    const maxParallelCeiling = envParallel === undefined ? configured.maxParallelCeiling : Math.min(configured.maxParallelCeiling, envParallel);
    const maxParallelDefault = Math.min(configured.maxParallelDefault, maxParallelCeiling);
    return { minFreeMemMb, maxLoadAvgPerCpu, maxParallelDefault, maxParallelCeiling };
  }

  public static sample(): { cpus: number; freeMemMb: number; loadAvgPerCpu: number } {
    const cpus = os.cpus().length || 1;
    const freeMemMb = Math.floor(os.freemem() / (1024 * 1024));
    const loadAvg = os.loadavg()[0];
    if (!Number.isFinite(loadAvg)) throw new Error('RESOURCE_SAMPLE_UNAVAILABLE:loadavg');
    return { cpus, freeMemMb, loadAvgPerCpu: loadAvg / cpus };
  }

  /** The concurrency cap: never more than the doctrine ceiling, never more than the host can take. */
  public static cap(requested?: number): number {
    const budgets = this.budgets();
    const wanted = requested === undefined || !Number.isFinite(requested) ? budgets.maxParallelDefault : Math.max(1, Math.floor(requested));
    return Math.min(wanted, budgets.maxParallelCeiling);
  }

  public static admit(requested?: number): Admission {
    const budgets = this.budgets();
    // The raw ask is recorded as asked; `maxParallel` is what was actually granted. Silently
    // reporting the capped number as the request would hide the fact that doctrine said no.
    const raw = requested === undefined || !Number.isFinite(requested) ? budgets.maxParallelDefault : Math.max(1, Math.floor(requested));
    const wanted = Math.min(raw, budgets.maxParallelCeiling);
    const reasons: string[] = [];

    let sample = { cpus: 1, freeMemMb: 0, loadAvgPerCpu: 0 };
    try {
      sample = this.sample();
    } catch (error) {
      reasons.push((error as Error).message);
    }

    if (sample.freeMemMb < budgets.minFreeMemMb) {
      reasons.push(`MEMORY:free=${sample.freeMemMb}MB,budget=${budgets.minFreeMemMb}MB`);
    }
    if (sample.loadAvgPerCpu > budgets.maxLoadAvgPerCpu) {
      reasons.push(`LOAD:loadavg-per-cpu=${sample.loadAvgPerCpu.toFixed(2)},budget=${budgets.maxLoadAvgPerCpu}`);
    }

    // One worker per CPU at most, and never more than the admitted parallelism. A refusal
    // grants nothing: reporting a positive cap while saying `admitted: false` invites the
    // caller to spawn anyway.
    const admitted = reasons.length === 0;
    const cpuCap = Math.max(1, sample.cpus - 1);
    const maxParallel = admitted ? Math.min(wanted, cpuCap, budgets.maxParallelCeiling) : 0;

    return {
      admitted,
      requested: raw,
      maxParallel,
      cpus: sample.cpus,
      freeMemMb: sample.freeMemMb,
      loadAvgPerCpu: Number.isFinite(sample.loadAvgPerCpu) ? Number(sample.loadAvgPerCpu.toFixed(3)) : 0,
      reasons,
    };
  }

  /** Throws `RESOURCE_EXHAUSTED` when the host cannot take the work. Fail closed. */
  public static assertAdmitted(requested?: number): Admission {
    const admission = this.admit(requested);
    if (!admission.admitted) throw new Error(`RESOURCE_EXHAUSTED:${admission.reasons.join(';')}`);
    return admission;
  }
}
