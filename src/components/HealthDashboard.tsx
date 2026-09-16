import React, { useState } from 'react';
import {
  Cpu,
  Database,
  Activity,
  ShieldCheck,
  RefreshCw,
  Server,
  Zap,
  CheckCircle2,
  AlertOctagon,
  Clock,
  Layers,
  Radio,
  RotateCcw,
  ShieldAlert,
  AlertTriangle,
} from 'lucide-react';
import { SystemHealthStats, AutoRefreshInterval } from '../types';

interface HealthDashboardProps {
  health: SystemHealthStats | null;
  loading: boolean;
  onRefresh: () => void;
  refreshInterval: AutoRefreshInterval;
  onChangeInterval: (interval: AutoRefreshInterval) => void;
  lastUpdatedTime: string | null;
  onResetCircuitBreaker?: (service: 'geminiEngine' | 'appwriteLedger' | 'downstreamGateways' | 'all') => void;
  onTripCircuitBreaker?: (service: 'geminiEngine' | 'appwriteLedger' | 'downstreamGateways') => void;
}

export const HealthDashboard: React.FC<HealthDashboardProps> = ({
  health,
  loading,
  onRefresh,
  refreshInterval,
  onChangeInterval,
  lastUpdatedTime,
  onResetCircuitBreaker,
  onTripCircuitBreaker,
}) => {
  const [resettingService, setResettingService] = useState<string | null>(null);
  // Determine saturation status
  const saturation = health?.saturationPercent ?? 24;
  const saturationColor =
    saturation > 80
      ? 'text-red-400 bg-red-500'
      : saturation > 50
      ? 'text-amber-400 bg-amber-500'
      : 'text-indigo-400 bg-indigo-500';

  // Determine memory pressure status
  const memoryPressure = health?.memoryPressureScore ?? 35;
  const memoryStatusText =
    memoryPressure > 85 ? 'Critical' : memoryPressure > 65 ? 'Elevated' : 'Optimal';
  const memoryStatusBadge =
    memoryPressure > 85
      ? 'bg-red-950/80 text-red-400 border-red-800'
      : memoryPressure > 65
      ? 'bg-amber-950/80 text-amber-400 border-amber-800'
      : 'bg-emerald-950/80 text-emerald-400 border-emerald-800';

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-5 shadow-md space-y-4">
      {/* Header with Title and Auto-Refresh Interval Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
            <Activity className="w-4 h-4 text-indigo-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-white tracking-tight">
                Rust Tokio Health & Runtime Telemetry
              </h2>
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono bg-emerald-950/70 text-emerald-400 border border-emerald-800/60">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                ACTIVE
              </span>
            </div>
            <p className="text-[11px] text-slate-400">
              Low-latency worker threadpool, jemalloc heap allocation, and multi-service circuit breakers
            </p>
          </div>
        </div>

        {/* Polling Frequency Controller */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 bg-slate-950 p-1 rounded-lg border border-slate-800 text-xs">
            <span className="text-[11px] font-mono text-slate-400 px-2 flex items-center gap-1">
              <Radio className={`w-3 h-3 ${refreshInterval !== 'manual' ? 'text-indigo-400 animate-pulse' : 'text-slate-500'}`} />
              Auto-Refresh:
            </span>
            <button
              onClick={() => onChangeInterval('manual')}
              className={`px-2.5 py-1 rounded text-[11px] font-mono font-medium transition ${
                refreshInterval === 'manual'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              Manual
            </button>
            <button
              onClick={() => onChangeInterval('5s')}
              className={`px-2.5 py-1 rounded text-[11px] font-mono font-medium transition ${
                refreshInterval === '5s'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              5s
            </button>
            <button
              onClick={() => onChangeInterval('30s')}
              className={`px-2.5 py-1 rounded text-[11px] font-mono font-medium transition ${
                refreshInterval === '30s'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              30s
            </button>
          </div>

          <button
            onClick={onRefresh}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 hover:text-white text-xs font-mono transition"
            title="Poll Health API immediately"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-indigo-400' : ''}`} />
            <span>Poll Now</span>
          </button>
        </div>
      </div>

      {/* Main Health Metrics Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Metric 1: Rust Tokio Threadpool Saturation */}
        <div className="bg-slate-950 border border-slate-800/90 rounded-xl p-4 flex flex-col justify-between space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Cpu className="w-4 h-4 text-indigo-400" />
              <span className="text-xs font-medium text-slate-200">Threadpool Saturation</span>
            </div>
            <span className="font-mono text-sm font-semibold text-indigo-300">
              {health?.saturationPercent ?? 0}%
            </span>
          </div>

          {/* Progress Bar */}
          <div className="space-y-1.5">
            <div className="w-full bg-slate-800/80 rounded-full h-2 overflow-hidden">
              <div
                className={`h-2 rounded-full transition-all duration-500 ${saturationColor.split(' ')[1]}`}
                style={{ width: `${Math.min(100, Math.max(5, health?.saturationPercent ?? 20))}%` }}
              ></div>
            </div>
            <div className="flex justify-between text-[11px] text-slate-400 font-mono">
              <span>{health?.activeTasks ?? 0} / {health?.totalWorkerThreads ?? 32} Active Workers</span>
              <span className="text-slate-400">{health?.queuedTasks ?? 0} Queued</span>
            </div>
          </div>

          {/* Worker threads miniature dot visualization */}
          <div className="pt-2 border-t border-slate-800/60">
            <div className="flex items-center justify-between text-[10px] text-slate-400 mb-1.5 font-mono">
              <span>Tokio Work-Stealing Workers (32)</span>
              <span className="text-emerald-400">Eff: {health?.workStealingEfficiency ?? '99.4%'}</span>
            </div>
            <div
              className="gap-1"
              style={{ display: 'grid', gridTemplateColumns: 'repeat(16, minmax(0, 1fr))' }}
            >
              {Array.from({ length: 32 }).map((_, idx) => {
                const activeWorkers = health?.activeTasks ?? 8;
                const isActive = idx < activeWorkers;
                return (
                  <span
                    key={idx}
                    title={`Worker #${idx}: ${isActive ? 'BUSY' : 'IDLE'}`}
                    className={`h-2 rounded-sm transition-colors ${
                      isActive ? 'bg-indigo-500 shadow-sm shadow-indigo-500/50' : 'bg-slate-800'
                    }`}
                  ></span>
                );
              })}
            </div>
          </div>
        </div>

        {/* Metric 2: Memory Usage & Pressure */}
        <div className="bg-slate-950 border border-slate-800/90 rounded-xl p-4 flex flex-col justify-between space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Database className="w-4 h-4 text-emerald-400" />
              <span className="text-xs font-medium text-slate-200">Memory Allocation & RSS</span>
            </div>
            <span className={`px-2 py-0.5 rounded text-[10px] font-mono border ${memoryStatusBadge}`}>
              {memoryStatusText}
            </span>
          </div>

          {/* Heap Progress Bar */}
          <div className="space-y-1.5">
            <div className="w-full bg-slate-800/80 rounded-full h-2 overflow-hidden">
              <div
                className="h-2 rounded-full bg-emerald-500 transition-all duration-500"
                style={{ width: `${Math.min(100, Math.max(5, health?.memoryPressureScore ?? 35))}%` }}
              ></div>
            </div>
            <div className="flex justify-between text-[11px] text-slate-400 font-mono">
              <span>V8 Heap: {health?.heapUsedMb ?? 0} MB / {health?.heapTotalMb ?? 0} MB</span>
              <span>RSS: {health?.rssMb ?? 0} MB</span>
            </div>
          </div>

          {/* Native Rust Heap Stats */}
          <div className="pt-2 border-t border-slate-800/60 flex items-center justify-between text-[11px] font-mono">
            <span className="text-slate-400">Rust Tokio Heap:</span>
            <span className="text-emerald-300 font-semibold">{health?.rustTokioHeapMb ?? 38} MB (jemalloc)</span>
          </div>
        </div>

        {/* Metric 3: Dedicated Circuit Breakers Status & Manual Reset Block */}
        <div className="bg-slate-950 border border-slate-800/90 rounded-xl p-4 flex flex-col justify-between space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-sky-400" />
              <span className="text-xs font-medium text-slate-200">Downstream Circuit Breakers</span>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => {
                  if (onResetCircuitBreaker) {
                    setResettingService('all');
                    onResetCircuitBreaker('all');
                    setTimeout(() => setResettingService(null), 1000);
                  }
                }}
                className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-900 hover:bg-slate-800 text-indigo-300 border border-slate-700 flex items-center gap-1 transition"
                title="Reset all downstream circuit breakers to CLOSED"
              >
                <RotateCcw className={`w-3 h-3 ${resettingService === 'all' ? 'animate-spin text-indigo-400' : ''}`} />
                <span>Reset All</span>
              </button>
            </div>
          </div>

          {/* Interactive Breakers Status List with Manual Reset */}
          <div className="space-y-2 text-xs">
            {/* 1. Gemini AI Engine Breaker */}
            {(() => {
              const geminiState = health?.circuitBreakers?.geminiEngine ?? health?.circuitBreakerState ?? 'CLOSED';
              const isTripped = geminiState === 'OPEN';
              const isHalfOpen = geminiState === 'HALF_OPEN';
              return (
                <div
                  className={`flex items-center justify-between p-2 rounded border font-mono text-[11px] transition ${
                    isTripped
                      ? 'bg-rose-950/40 border-rose-800/70 shadow-sm shadow-rose-950'
                      : isHalfOpen
                      ? 'bg-amber-950/40 border-amber-800/60'
                      : 'bg-slate-900/60 border-slate-800/60'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`w-2 h-2 rounded-full ${
                        isTripped
                          ? 'bg-rose-500 animate-ping'
                          : isHalfOpen
                          ? 'bg-amber-400 animate-pulse'
                          : 'bg-emerald-400 animate-pulse'
                      }`}
                    ></span>
                    <div>
                      <span className="text-slate-200 font-medium block leading-none">Gemini AI Engine</span>
                      <span className="text-[9px] text-slate-400">REST API &bull; 1.5 Pro</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-semibold border ${
                        isTripped
                          ? 'bg-rose-950 text-rose-300 border-rose-800'
                          : isHalfOpen
                          ? 'bg-amber-950 text-amber-300 border-amber-800'
                          : 'bg-emerald-950 text-emerald-300 border-emerald-800'
                      }`}
                    >
                      {geminiState}
                    </span>

                    <button
                      onClick={() => {
                        if (isTripped || isHalfOpen) {
                          setResettingService('geminiEngine');
                          onResetCircuitBreaker?.('geminiEngine');
                          setTimeout(() => setResettingService(null), 800);
                        } else {
                          // Allow tripping for resilience simulation testing
                          onTripCircuitBreaker?.('geminiEngine');
                        }
                      }}
                      className={`px-2 py-0.5 rounded text-[10px] font-mono transition flex items-center gap-1 border ${
                        isTripped
                          ? 'bg-rose-600 hover:bg-rose-500 text-white border-rose-500 shadow-sm'
                          : 'bg-slate-900 hover:bg-slate-800 text-slate-300 border-slate-700'
                      }`}
                      title={isTripped ? 'Manually reset tripped circuit to CLOSED' : 'Simulate downstream failure to trip circuit'}
                    >
                      <RotateCcw className={`w-2.5 h-2.5 ${resettingService === 'geminiEngine' ? 'animate-spin' : ''}`} />
                      <span>{isTripped ? 'Reset' : 'Trip Test'}</span>
                    </button>
                  </div>
                </div>
              );
            })()}

            {/* 2. Appwrite DB Ledger Breaker */}
            {(() => {
              const appwriteState = health?.circuitBreakers?.appwriteLedger ?? 'CLOSED';
              const isTripped = appwriteState === 'OPEN';
              const isHalfOpen = appwriteState === 'HALF_OPEN';
              return (
                <div
                  className={`flex items-center justify-between p-2 rounded border font-mono text-[11px] transition ${
                    isTripped
                      ? 'bg-rose-950/40 border-rose-800/70 shadow-sm shadow-rose-950'
                      : isHalfOpen
                      ? 'bg-amber-950/40 border-amber-800/60'
                      : 'bg-slate-900/60 border-slate-800/60'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`w-2 h-2 rounded-full ${
                        isTripped
                          ? 'bg-rose-500 animate-ping'
                          : isHalfOpen
                          ? 'bg-amber-400 animate-pulse'
                          : 'bg-emerald-400 animate-pulse'
                      }`}
                    ></span>
                    <div>
                      <span className="text-slate-200 font-medium block leading-none">Appwrite DB Ledger</span>
                      <span className="text-[9px] text-slate-400">Sync &bull; Partitions</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-semibold border ${
                        isTripped
                          ? 'bg-rose-950 text-rose-300 border-rose-800'
                          : isHalfOpen
                          ? 'bg-amber-950 text-amber-300 border-amber-800'
                          : 'bg-emerald-950 text-emerald-300 border-emerald-800'
                      }`}
                    >
                      {appwriteState}
                    </span>

                    <button
                      onClick={() => {
                        if (isTripped || isHalfOpen) {
                          setResettingService('appwriteLedger');
                          onResetCircuitBreaker?.('appwriteLedger');
                          setTimeout(() => setResettingService(null), 800);
                        } else {
                          onTripCircuitBreaker?.('appwriteLedger');
                        }
                      }}
                      className={`px-2 py-0.5 rounded text-[10px] font-mono transition flex items-center gap-1 border ${
                        isTripped
                          ? 'bg-rose-600 hover:bg-rose-500 text-white border-rose-500 shadow-sm'
                          : 'bg-slate-900 hover:bg-slate-800 text-slate-300 border-slate-700'
                      }`}
                      title={isTripped ? 'Manually reset tripped circuit to CLOSED' : 'Simulate downstream failure to trip circuit'}
                    >
                      <RotateCcw className={`w-2.5 h-2.5 ${resettingService === 'appwriteLedger' ? 'animate-spin' : ''}`} />
                      <span>{isTripped ? 'Reset' : 'Trip Test'}</span>
                    </button>
                  </div>
                </div>
              );
            })()}

            {/* 3. Downstream Ingest Gateway */}
            {(() => {
              const downstreamState = health?.circuitBreakers?.downstreamGateways ?? 'CLOSED';
              const isTripped = downstreamState === 'OPEN';
              const isHalfOpen = downstreamState === 'HALF_OPEN';
              return (
                <div
                  className={`flex items-center justify-between p-2 rounded border font-mono text-[11px] transition ${
                    isTripped
                      ? 'bg-rose-950/40 border-rose-800/70 shadow-sm shadow-rose-950'
                      : isHalfOpen
                      ? 'bg-amber-950/40 border-amber-800/60'
                      : 'bg-slate-900/60 border-slate-800/60'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`w-2 h-2 rounded-full ${
                        isTripped
                          ? 'bg-rose-500 animate-ping'
                          : isHalfOpen
                          ? 'bg-amber-400 animate-pulse'
                          : 'bg-emerald-400 animate-pulse'
                      }`}
                    ></span>
                    <div>
                      <span className="text-slate-200 font-medium block leading-none">Downstream Gateways</span>
                      <span className="text-[9px] text-slate-400">Webhooks &bull; Kafka</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-semibold border ${
                        isTripped
                          ? 'bg-rose-950 text-rose-300 border-rose-800'
                          : isHalfOpen
                          ? 'bg-amber-950 text-amber-300 border-amber-800'
                          : 'bg-emerald-950 text-emerald-300 border-emerald-800'
                      }`}
                    >
                      {downstreamState}
                    </span>

                    <button
                      onClick={() => {
                        if (isTripped || isHalfOpen) {
                          setResettingService('downstreamGateways');
                          onResetCircuitBreaker?.('downstreamGateways');
                          setTimeout(() => setResettingService(null), 800);
                        } else {
                          onTripCircuitBreaker?.('downstreamGateways');
                        }
                      }}
                      className={`px-2 py-0.5 rounded text-[10px] font-mono transition flex items-center gap-1 border ${
                        isTripped
                          ? 'bg-rose-600 hover:bg-rose-500 text-white border-rose-500 shadow-sm'
                          : 'bg-slate-900 hover:bg-slate-800 text-slate-300 border-slate-700'
                      }`}
                      title={isTripped ? 'Manually reset tripped circuit to CLOSED' : 'Simulate downstream failure to trip circuit'}
                    >
                      <RotateCcw className={`w-2.5 h-2.5 ${resettingService === 'downstreamGateways' ? 'animate-spin' : ''}`} />
                      <span>{isTripped ? 'Reset' : 'Trip Test'}</span>
                    </button>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      </div>

      {/* Footer Diagnostic Bar */}
      <div className="flex flex-wrap items-center justify-between text-[11px] font-mono text-slate-400 pt-2 border-t border-slate-800/60 gap-2">
        <div className="flex items-center gap-4">
          <span>K8s Zone: <strong className="text-slate-300">europe-west2-a</strong></span>
          <span>Pod Scale: <strong className="text-indigo-300">{health?.hpaReplicas ?? 5} Replicas (HPA)</strong></span>
          <span>Target CPU: <strong className="text-slate-300">70%</strong></span>
        </div>
        <div className="flex items-center gap-2 text-slate-400">
          <Clock className="w-3 h-3 text-slate-400" />
          <span>Last Polled: {lastUpdatedTime || 'Just now'}</span>
          {refreshInterval !== 'manual' && (
            <span className="text-indigo-400">({refreshInterval} interval active)</span>
          )}
        </div>
      </div>
    </div>
  );
};
