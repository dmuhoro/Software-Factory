import React from 'react';
import { History, CheckCircle2, AlertTriangle, Download, ArrowRight, FileText } from 'lucide-react';
import { TelemetryExecutionLog } from '../types';

interface Props {
  logs: TelemetryExecutionLog[];
  selectedId: string | null;
  onSelectLog: (log: TelemetryExecutionLog) => void;
  onExportLedger: () => void;
  onExportTenantReport?: () => void;
  onClearLogs: () => void;
}

export const RecentExecutionsSidebar: React.FC<Props> = ({
  logs,
  selectedId,
  onSelectLog,
  onExportLedger,
  onExportTenantReport,
  onClearLogs,
}) => {
  return (
    <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 flex flex-col h-full space-y-3">
      <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
        <div className="flex items-center gap-2">
          <History className="w-4 h-4 text-indigo-400" />
          <h3 className="text-xs font-semibold text-white uppercase tracking-wider">
            API Execution Logs ({logs.length})
          </h3>
        </div>
        <div className="flex items-center gap-1.5">
          {onExportTenantReport && (
            <button
              onClick={onExportTenantReport}
              className="px-2 py-1 rounded bg-indigo-950/80 hover:bg-indigo-900 text-indigo-300 text-[11px] font-mono border border-indigo-800/80 flex items-center gap-1 transition"
              title="Generate and download a PDF-style structured summary report for the current tenant"
            >
              <FileText className="w-3 h-3 text-indigo-400" />
              <span>PDF Report</span>
            </button>
          )}
          <button
            onClick={onExportLedger}
            disabled={logs.length === 0}
            className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] font-mono border border-slate-700 flex items-center gap-1 transition disabled:opacity-40"
            title="Export full execution ledger to JSON file"
          >
            <Download className="w-3 h-3 text-indigo-400" />
            <span>Export</span>
          </button>
          <button
            onClick={onClearLogs}
            disabled={logs.length === 0}
            className="text-[11px] text-slate-500 hover:text-slate-400 px-1 disabled:opacity-30"
            title="Clear history"
          >
            Clear
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto space-y-2 max-h-[460px] pr-1">
        {logs.length === 0 ? (
          <div className="text-center py-10 px-4 text-slate-500 text-xs">
            <p>No recent executions recorded.</p>
            <p className="text-[11px] text-slate-600 mt-1">
              Dispatch a telemetry stream to view live audit ledger events.
            </p>
          </div>
        ) : (
          logs.map((log) => {
            const isSelected = selectedId === log.id;
            const isSuccess = log.status === 'success';
            return (
              <button
                key={log.id}
                onClick={() => onSelectLog(log)}
                className={`w-full text-left p-2.5 rounded-lg border text-xs transition-all relative overflow-hidden group ${
                  isSelected
                    ? 'bg-slate-800/90 border-indigo-500/80 shadow-sm'
                    : 'bg-slate-950/60 border-slate-800/80 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-1.5">
                    {isSuccess ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    ) : (
                      <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                    )}
                    <span className="font-mono text-[11px] text-slate-200 truncate max-w-[130px]">
                      {log.eventType}
                    </span>
                  </div>
                  <span
                    className={`font-mono text-[10px] px-1.5 py-0.2 rounded ${
                      isSuccess
                        ? 'bg-emerald-950 text-emerald-300'
                        : 'bg-red-950 text-red-300'
                    }`}
                  >
                    {log.durationMs}ms
                  </span>
                </div>

                <div className="flex items-center justify-between text-[10px] text-slate-500 font-mono">
                  <span className="truncate max-w-[140px] text-slate-400">{log.tenantId}</span>
                  <span>{log.timestamp.split('T')[1]?.slice(0, 8)}</span>
                </div>

                <div className="hidden group-hover:flex absolute right-2 top-1/2 -translate-y-1/2 items-center text-indigo-400 bg-slate-900/90 px-1.5 py-1 rounded border border-slate-700 text-[10px]">
                  Inspect <ArrowRight className="w-2.5 h-2.5 ml-0.5" />
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
};
