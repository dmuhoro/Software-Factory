import React from 'react';
import {
  Activity,
  Database,
  RefreshCw,
  Radio,
  Clock,
  CheckCircle2,
  AlertTriangle,
  AlertOctagon,
  HeartPulse,
  ShieldCheck,
} from 'lucide-react';
import { SystemHealthStats, AutoRefreshInterval } from '../types';

interface HealthDashboardProps {
  health: SystemHealthStats | null;
  loading: boolean;
  onRefresh: () => void;
  refreshInterval: AutoRefreshInterval;
  onChangeInterval: (interval: AutoRefreshInterval) => void;
  lastUpdatedTime: string | null;
}

/**
 * The runtime health board.
 *
 * Every value here is produced by the server: `classifyReadiness()` results and
 * `process.memoryUsage()`. It shows exactly what the Node process can measure and
 * nothing else. The previous version rendered a Rust/Tokio threadpool, jemalloc
 * heap, trippable circuit breakers, and HPA pod counts -- none of which this service
 * runs -- and it read fields the API never sent, so it threw and showed nothing.
 * A health board that invents health is worse than one that reports only the truth.
 */
export const HealthDashboard: React.FC<HealthDashboardProps> = ({
  health,
  loading,
  onRefresh,
  refreshInterval,
  onChangeInterval,
  lastUpdatedTime,
}) => {
  const status = health?.status ?? 'degraded';
  const statusBadge =
    status === 'healthy'
      ? 'bg-emerald-950/70 text-emerald-400 border-emerald-800/60'
      : status === 'unhealthy'
      ? 'bg-rose-950/70 text-rose-400 border-rose-800/60'
      : 'bg-amber-950/70 text-amber-400 border-amber-800/60';
  const StatusIcon = status === 'healthy' ? CheckCircle2 : status === 'unhealthy' ? AlertOctagon : AlertTriangle;

  const pressure = health?.memoryPressureScore ?? 0;
  const pressureBadge =
    pressure > 85
      ? 'bg-rose-950/80 text-rose-400 border-rose-800'
      : pressure > 65
      ? 'bg-amber-950/80 text-amber-400 border-amber-800'
      : 'bg-emerald-950/80 text-emerald-400 border-emerald-800';

  const fmtUptime = (seconds: number): string => {
    if (!seconds || seconds < 0) return '0s';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${s}s`;
    return `${s}s`;
  };

  const checkState = (state: string): string =>
    state === 'pass'
      ? 'bg-emerald-950 text-emerald-300 border-emerald-800'
      : state === 'warn'
      ? 'bg-amber-950 text-amber-300 border-amber-800'
      : 'bg-rose-950 text-rose-300 border-rose-800';

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-5 shadow-md space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
            <HeartPulse className="w-4 h-4 text-indigo-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-white tracking-tight">Runtime Health & Readiness</h2>
              <span className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono border ${statusBadge}`}>
                <StatusIcon className="w-3 h-3" />
                {status.toUpperCase()}
              </span>
            </div>
            <p className="text-[11px] text-slate-400">
              Live readiness checks and process memory. Reported by the Node process itself.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 bg-slate-950 p-1 rounded-lg border border-slate-800 text-xs">
            <span className="text-[11px] font-mono text-slate-400 px-2 flex items-center gap-1">
              <Radio className={`w-3 h-3 ${refreshInterval !== 'manual' ? 'text-indigo-400 animate-pulse' : 'text-slate-500'}`} />
              Auto-Refresh:
            </span>
            {(['manual', '5s', '30s'] as AutoRefreshInterval[]).map((option) => (
              <button
                key={option}
                onClick={() => onChangeInterval(option)}
                className={`px-2.5 py-1 rounded text-[11px] font-mono font-medium transition ${
                  refreshInterval === option ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                {option}
              </button>
            ))}
          </div>

          <button
            onClick={onRefresh}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 hover:text-white text-xs font-mono transition"
            title="Poll the health endpoint immediately"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-indigo-400' : ''}`} />
            <span>Poll Now</span>
          </button>
        </div>
      </div>

      {!health ? (
        <div className="text-xs text-slate-400 font-mono py-2">Connecting to /api/factory/health…</div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Memory - the one real resource signal this process exposes */}
            <div className="bg-slate-950 border border-slate-800/90 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Database className="w-4 h-4 text-emerald-400" />
                  <span className="text-xs font-medium text-slate-200">Process Memory</span>
                </div>
                <span className={`px-2 py-0.5 rounded text-[10px] font-mono border ${pressureBadge}`}>
                  {pressure}% heap
                </span>
              </div>
              <div className="w-full bg-slate-800/80 rounded-full h-2 overflow-hidden">
                <div className="h-2 rounded-full bg-emerald-500 transition-all duration-500" style={{ width: `${Math.min(100, Math.max(2, pressure))}%` }} />
              </div>
              <div className="flex justify-between text-[11px] text-slate-400 font-mono">
                <span>V8 heap: {health.heapUsedMb} / {health.heapTotalMb} MB</span>
                <span>RSS: {health.rssMb} MB</span>
              </div>
            </div>

            {/* Provenance + uptime: which build, how long it has served */}
            <div className="bg-slate-950 border border-slate-800/90 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-indigo-400" />
                  <span className="text-xs font-medium text-slate-200">Build & Uptime</span>
                </div>
                <ShieldCheck className="w-4 h-4 text-slate-500" />
              </div>
              <div className="flex justify-between text-[11px] text-slate-400 font-mono">
                <span>Package:</span>
                <span className="text-slate-200">{health.name}</span>
              </div>
              <div className="flex justify-between text-[11px] text-slate-400 font-mono">
                <span>Version:</span>
                <span className="text-indigo-300 font-semibold">v{health.version}</span>
              </div>
              <div className="flex justify-between text-[11px] text-slate-400 font-mono">
                <span>Uptime:</span>
                <span className="text-slate-200">{fmtUptime(health.uptimeSeconds)}</span>
              </div>
            </div>
          </div>

          {/* Readiness checks - exactly the checks the server classified */}
          <div className="space-y-2">
            <span className="text-[11px] font-mono text-slate-400 uppercase tracking-wider">Readiness checks</span>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {health.checkDetails.map((check) => (
                <div key={check.name} className={`p-3 rounded-lg border font-mono text-[11px] space-y-1 ${checkState(check.state)}`}>
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">{check.name}</span>
                    <span className="uppercase">{check.state}</span>
                  </div>
                  <p className="text-slate-400 leading-snug break-words">{check.detail}</p>
                </div>
              ))}
            </div>
          </div>

          {health.recovery && (
            <div className="p-3 rounded-lg border border-amber-800/60 bg-amber-950/40 font-mono text-[11px] text-amber-300 flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>
                Ledger recovered at {health.recovery.occurredAt}; restoredFromBackup={String(health.recovery.restoredFromBackup)};
                recordsLost={health.recovery.recordsLost}
              </span>
            </div>
          )}
        </>
      )}

      <div className="flex flex-wrap items-center justify-between text-[11px] font-mono text-slate-400 pt-2 border-t border-slate-800/60 gap-2">
        <span>
          Endpoint: <strong className="text-slate-300">/api/factory/health</strong>
        </span>
        <div className="flex items-center gap-2 text-slate-400">
          <Clock className="w-3 h-3 text-slate-400" />
          <span>Last polled: {lastUpdatedTime || 'just now'}</span>
          {refreshInterval !== 'manual' && <span className="text-indigo-400">({refreshInterval} interval active)</span>}
        </div>
      </div>
    </div>
  );
};
