import React, { useMemo, useState } from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from 'recharts';
import { Flame, Clock, Filter, AlertTriangle } from 'lucide-react';

export interface LatencyHeatmapSlice {
  minuteLabel: string;
  under20ms: number;
  between20and50ms: number;
  between50and100ms: number;
  between100and250ms: number;
  over250ms: number;
  tailP99: number;
  totalRequests: number;
}

interface LatencyHeatmapProps {
  // Optional custom data or auto-generated based on current telemetry
  customSlices?: LatencyHeatmapSlice[];
}

export const LatencyHeatmap: React.FC<LatencyHeatmapProps> = ({ customSlices }) => {
  const [selectedTier, setSelectedTier] = useState<string>('all');

  // Generate 15-minute rolling data slices
  const heatmapData = useMemo<LatencyHeatmapSlice[]>(() => {
    if (customSlices && customSlices.length > 0) {
      return customSlices;
    }

    const slices: LatencyHeatmapSlice[] = [];
    const now = new Date();

    for (let i = 14; i >= 0; i--) {
      const timePoint = new Date(now.getTime() - i * 60 * 1000);
      const minutesStr = timePoint.getMinutes().toString().padStart(2, '0');
      const hoursStr = timePoint.getHours().toString().padStart(2, '0');
      const minuteLabel = `${hoursStr}:${minutesStr}`;

      // Simulate realistic microsecond/millisecond Tokio work-stealing distributions with occasional p99 spikes
      const isSpike = i === 4 || i === 9;
      const baseReqs = 420 + Math.floor(Math.sin(i) * 60);
      const under20 = Math.floor(baseReqs * 0.72);
      const b20_50 = Math.floor(baseReqs * 0.18);
      const b50_100 = Math.floor(baseReqs * 0.07);
      const b100_250 = isSpike ? 24 : Math.floor(baseReqs * 0.025);
      const over250 = isSpike ? 8 : Math.floor(baseReqs * 0.005);
      const tailP99 = isSpike ? 284 : 48 + Math.floor(Math.random() * 18);

      slices.push({
        minuteLabel,
        under20ms: under20,
        between20and50ms: b20_50,
        between50and100ms: b50_100,
        between100and250ms: b100_250,
        over250ms: over250,
        tailP99,
        totalRequests: under20 + b20_50 + b50_100 + b100_250 + over250,
      });
    }

    return slices;
  }, [customSlices]);

  // Overall metrics across the 15-minute window
  const summary = useMemo(() => {
    let totalReqs = 0;
    let totalOver100 = 0;
    let maxTail = 0;

    heatmapData.forEach((s) => {
      totalReqs += s.totalRequests;
      totalOver100 += s.between100and250ms + s.over250ms;
      if (s.tailP99 > maxTail) maxTail = s.tailP99;
    });

    const tailRate = totalReqs > 0 ? ((totalOver100 / totalReqs) * 100).toFixed(2) : '0.00';

    return { totalReqs, totalOver100, maxTail, tailRate };
  }, [heatmapData]);

  return (
    <div className="bg-slate-950 border border-slate-800 rounded-xl p-5 space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-rose-500/10 border border-rose-500/20 flex items-center justify-center">
            <Flame className="w-4 h-4 text-rose-400" />
          </div>
          <div>
            <h4 className="text-xs font-semibold text-white uppercase tracking-wider flex items-center gap-2">
              <span>Latency Distribution Heatmap (Last 15 Minutes)</span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-rose-950/80 text-rose-400 border border-rose-800">
                Tail SLA: &lt;100ms
              </span>
            </h4>
            <p className="text-[11px] text-slate-400">
              High-resolution bucketed histogram visualizing p95/p99 tail latency variance across Tokio worker stages
            </p>
          </div>
        </div>

        {/* Aggregate KPI Badges */}
        <div className="flex items-center gap-2 text-[11px] font-mono">
          <div className="bg-slate-900 px-2.5 py-1 rounded border border-slate-800">
            <span className="text-slate-400">15m Volume: </span>
            <span className="text-indigo-300 font-semibold">{summary.totalReqs.toLocaleString()}</span>
          </div>
          <div className="bg-slate-900 px-2.5 py-1 rounded border border-slate-800">
            <span className="text-slate-400">Tail &gt;100ms: </span>
            <span className="text-amber-400 font-semibold">{summary.tailRate}%</span>
          </div>
          <div className="bg-slate-900 px-2.5 py-1 rounded border border-slate-800">
            <span className="text-slate-400">Peak Tail: </span>
            <span className="text-rose-400 font-semibold">{summary.maxTail}ms</span>
          </div>
        </div>
      </div>

      {/* Interactive Recharts Stacked Latency Distribution Histogram */}
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={heatmapData}
            margin={{ top: 10, right: 10, left: -10, bottom: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
            <XAxis dataKey="minuteLabel" stroke="#64748b" tick={{ fontSize: 10 }} />
            <YAxis stroke="#64748b" tick={{ fontSize: 10 }} />
            <Tooltip
              contentStyle={{
                backgroundColor: '#090d16',
                borderColor: '#334155',
                borderRadius: '8px',
                fontSize: '11px',
                fontFamily: 'monospace',
              }}
              formatter={(value: any, name: string) => [`${value} requests`, name]}
            />
            <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
            <Bar dataKey="under20ms" name="< 20ms (Optimal)" stackId="a" fill="#10b981" />
            <Bar dataKey="between20and50ms" name="20-50ms (Nominal)" stackId="a" fill="#06b6d4" />
            <Bar dataKey="between50and100ms" name="50-100ms (Inference)" stackId="a" fill="#6366f1" />
            <Bar dataKey="between100and250ms" name="100-250ms (Queue Spill)" stackId="a" fill="#f59e0b" />
            <Bar dataKey="over250ms" name="> 250ms (Tail Anomaly)" stackId="a" fill="#ef4444" />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Discrete 15-Minute Heatmap Matrix Grid */}
      <div className="pt-2 border-t border-slate-800/70 space-y-2">
        <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
          <span className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-slate-500" />
            Granular Latency Bucket Heatmap Matrix (Columns: T-14m &rarr; Now)
          </span>
          <div className="flex items-center gap-2 text-[10px]">
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded bg-emerald-500/20 border border-emerald-500/40"></span>
              &lt;20ms
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded bg-cyan-500/30 border border-cyan-500/50"></span>
              20-50ms
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded bg-amber-500/40 border border-amber-500/60"></span>
              100-250ms
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded bg-rose-500/60 border border-rose-500/80"></span>
              &gt;250ms
            </span>
          </div>
        </div>

        {/* Matrix Grid */}
        <div className="overflow-x-auto pb-1">
          <div className="min-w-[640px] space-y-1 text-[10px] font-mono">
            {/* Row 1: Over 250ms */}
            <div className="flex items-center gap-1">
              <span className="w-20 text-slate-400 text-right pr-2 shrink-0">&gt;250ms:</span>
              <div className="grid grid-cols-15 gap-1 flex-1">
                {heatmapData.map((slice, idx) => {
                  const hasTail = slice.over250ms > 0;
                  return (
                    <div
                      key={idx}
                      title={`${slice.minuteLabel}: ${slice.over250ms} requests >250ms (p99: ${slice.tailP99}ms)`}
                      className={`h-5 rounded text-center leading-5 transition font-semibold ${
                        hasTail
                          ? 'bg-rose-600 text-white shadow-sm shadow-rose-950'
                          : 'bg-slate-900/60 text-slate-600 border border-slate-800/40'
                      }`}
                    >
                      {slice.over250ms > 0 ? slice.over250ms : '0'}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Row 2: 100-250ms */}
            <div className="flex items-center gap-1">
              <span className="w-20 text-slate-400 text-right pr-2 shrink-0">100-250ms:</span>
              <div className="grid grid-cols-15 gap-1 flex-1">
                {heatmapData.map((slice, idx) => (
                  <div
                    key={idx}
                    title={`${slice.minuteLabel}: ${slice.between100and250ms} requests`}
                    className={`h-5 rounded text-center leading-5 transition ${
                      slice.between100and250ms > 15
                        ? 'bg-amber-600 text-white font-semibold'
                        : slice.between100and250ms > 0
                        ? 'bg-amber-900/50 text-amber-300 border border-amber-800/50'
                        : 'bg-slate-900/60 text-slate-600 border border-slate-800/40'
                    }`}
                  >
                    {slice.between100and250ms}
                  </div>
                ))}
              </div>
            </div>

            {/* Row 3: 50-100ms */}
            <div className="flex items-center gap-1">
              <span className="w-20 text-slate-400 text-right pr-2 shrink-0">50-100ms:</span>
              <div className="grid grid-cols-15 gap-1 flex-1">
                {heatmapData.map((slice, idx) => (
                  <div
                    key={idx}
                    title={`${slice.minuteLabel}: ${slice.between50and100ms} requests`}
                    className="h-5 rounded text-center leading-5 bg-indigo-950/60 text-indigo-300 border border-indigo-900/50"
                  >
                    {slice.between50and100ms}
                  </div>
                ))}
              </div>
            </div>

            {/* Row 4: <50ms */}
            <div className="flex items-center gap-1">
              <span className="w-20 text-slate-400 text-right pr-2 shrink-0">&lt;50ms:</span>
              <div className="grid grid-cols-15 gap-1 flex-1">
                {heatmapData.map((slice, idx) => (
                  <div
                    key={idx}
                    title={`${slice.minuteLabel}: ${slice.under20ms + slice.between20and50ms} requests`}
                    className="h-5 rounded text-center leading-5 bg-emerald-950/50 text-emerald-300 border border-emerald-900/50 font-semibold"
                  >
                    {slice.under20ms + slice.between20and50ms}
                  </div>
                ))}
              </div>
            </div>

            {/* Time Axis Labels */}
            <div className="flex items-center gap-1 pt-1">
              <span className="w-20 shrink-0"></span>
              <div className="grid grid-cols-15 gap-1 flex-1 text-[9px] text-slate-500 text-center">
                {heatmapData.map((slice, idx) => (
                  <div key={idx} className="truncate">
                    {slice.minuteLabel}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
