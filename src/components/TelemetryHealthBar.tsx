import React from 'react';
import { Cpu, Database, Activity, ShieldCheck, RefreshCw, Server } from 'lucide-react';
import { SystemHealthStats } from '../types';

interface Props {
  health: SystemHealthStats | null;
  onRefresh: () => void;
  loading: boolean;
}

export const TelemetryHealthBar: React.FC<Props> = ({ health, onRefresh, loading }) => {
  if (!health) {
    return (
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 flex items-center justify-between text-xs text-slate-400">
        <span>Connecting to high-throughput Rust Tokio runtime...</span>
        <button onClick={onRefresh} className="text-indigo-400 hover:text-indigo-300">
          Retry Probe
        </button>
      </div>
    );
  }

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 shadow-sm space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Server className="w-4 h-4 text-indigo-400" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
            Rust Tokio Runtime & Memory Health
          </h3>
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[11px] font-mono text-slate-400">
            K8s Pods: <span className="text-indigo-300 font-semibold">{health.hpaReplicas} Replicas</span>
          </span>
          <button
            onClick={onRefresh}
            disabled={loading}
            className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
            title="Poll Health API"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-indigo-400' : ''}`} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {/* Metric 1: Threadpool Saturation */}
        <div className="bg-slate-950 border border-slate-800/80 rounded-lg p-3">
          <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
            <span className="flex items-center gap-1">
              <Cpu className="w-3 h-3 text-indigo-400" />
              Threadpool Saturation
            </span>
            <span className="font-mono text-indigo-300 font-semibold">{health.saturationPercent}%</span>
          </div>
          <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
            <div
              className="bg-indigo-500 h-1.5 rounded-full transition-all duration-500"
              style={{ width: `${health.saturationPercent}%` }}
            ></div>
          </div>
          <div className="flex justify-between text-[10px] text-slate-500 mt-1 font-mono">
            <span>{health.activeTasks}/{health.totalWorkerThreads} Active Workers</span>
            <span>{health.queuedTasks} Queued</span>
          </div>
        </div>

        {/* Metric 2: Memory Footprint */}
        <div className="bg-slate-950 border border-slate-800/80 rounded-lg p-3">
          <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
            <span className="flex items-center gap-1">
              <Database className="w-3 h-3 text-emerald-400" />
              Memory Allocation
            </span>
            <span className="font-mono text-emerald-300 font-semibold">{health.heapUsedMb} MB</span>
          </div>
          <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
            <div
              className="bg-emerald-500 h-1.5 rounded-full transition-all duration-500"
              style={{ width: `${health.memoryPressureScore}%` }}
            ></div>
          </div>
          <div className="flex justify-between text-[10px] text-slate-500 mt-1 font-mono">
            <span>Rust Heap: {health.rustTokioHeapMb} MB</span>
            <span>RSS: {health.rssMb} MB</span>
          </div>
        </div>

        {/* Metric 3: Circuit Breakers */}
        <div className="bg-slate-950 border border-slate-800/80 rounded-lg p-3 flex flex-col justify-between">
          <div className="flex items-center justify-between text-[11px] text-slate-400">
            <span className="flex items-center gap-1">
              <ShieldCheck className="w-3 h-3 text-sky-400" />
              Circuit Breaker
            </span>
            <span className="font-mono px-1.5 py-0.5 rounded text-[10px] bg-emerald-950 text-emerald-300 border border-emerald-800">
              {health.circuitBreakerState}
            </span>
          </div>
          <p className="text-[10px] text-slate-400 mt-1 font-mono">
            Downstream Failures: <span className="text-emerald-400">0 (0.00%)</span>
          </p>
        </div>

        {/* Metric 4: Scheduler Efficiency */}
        <div className="bg-slate-950 border border-slate-800/80 rounded-lg p-3 flex flex-col justify-between">
          <div className="flex items-center justify-between text-[11px] text-slate-400">
            <span className="flex items-center gap-1">
              <Activity className="w-3 h-3 text-amber-400" />
              Work-Stealing
            </span>
            <span className="font-mono text-amber-300 font-semibold">{health.workStealingEfficiency}</span>
          </div>
          <p className="text-[10px] text-slate-400 mt-1 font-mono">
            Zero GC Spikes • Tokio Async
          </p>
        </div>
      </div>
    </div>
  );
};
