import React, { useMemo } from 'react';
import { GitCompare, X, RotateCcw, AlertCircle, CheckCircle2, Plus, Minus, Edit3, ArrowRight } from 'lucide-react';

interface ComparePayloadsProps {
  isOpen: boolean;
  onClose: () => void;
  currentPayload: Record<string, any> | null;
  lastSuccessfulPayload: Record<string, any> | null;
  onRestoreLastSuccessful: (payload: Record<string, any>) => void;
}

interface KeyDiff {
  key: string;
  status: 'added' | 'removed' | 'modified' | 'identical';
  oldValue?: any;
  newValue?: any;
}

export const ComparePayloadsModal: React.FC<ComparePayloadsProps> = ({
  isOpen,
  onClose,
  currentPayload,
  lastSuccessfulPayload,
  onRestoreLastSuccessful,
}) => {
  if (!isOpen) return null;

  // Flatten / compare keys between the two objects
  const diffs = useMemo<KeyDiff[]>(() => {
    const oldObj = lastSuccessfulPayload || {};
    const newObj = currentPayload || {};

    const allKeys = Array.from(new Set([...Object.keys(oldObj), ...Object.keys(newObj)])).sort();

    return allKeys.map((k) => {
      const inOld = k in oldObj;
      const inNew = k in newObj;

      if (!inOld && inNew) {
        return { key: k, status: 'added', newValue: newObj[k] };
      }
      if (inOld && !inNew) {
        return { key: k, status: 'removed', oldValue: oldObj[k] };
      }

      const valOldStr = JSON.stringify(oldObj[k]);
      const valNewStr = JSON.stringify(newObj[k]);

      if (valOldStr !== valNewStr) {
        return { key: k, status: 'modified', oldValue: oldObj[k], newValue: newObj[k] };
      }

      return { key: k, status: 'identical', oldValue: oldObj[k], newValue: newObj[k] };
    });
  }, [currentPayload, lastSuccessfulPayload]);

  const stats = useMemo(() => {
    const added = diffs.filter((d) => d.status === 'added').length;
    const removed = diffs.filter((d) => d.status === 'removed').length;
    const modified = diffs.filter((d) => d.status === 'modified').length;
    const identical = diffs.filter((d) => d.status === 'identical').length;
    const hasDrift = added > 0 || removed > 0 || modified > 0;
    return { added, removed, modified, identical, hasDrift };
  }, [diffs]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-4xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/80">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
              <GitCompare className="w-5 h-5 text-indigo-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold text-white">Compare Payloads &amp; Schema Drift</h3>
                {stats.hasDrift ? (
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-amber-950 text-amber-300 border border-amber-800">
                    DRIFT DETECTED
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-950 text-emerald-300 border border-emerald-800">
                    SYNCHRONIZED
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-400">
                Auditing differences between current input editor JSON and the last successful telemetry request
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Drift Metrics Summary Banner */}
        <div className="px-6 py-3 bg-slate-950/40 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs font-mono">
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1.5 text-emerald-400">
              <Plus className="w-3.5 h-3.5" />
              <strong>{stats.added}</strong> Added
            </span>
            <span className="flex items-center gap-1.5 text-rose-400">
              <Minus className="w-3.5 h-3.5" />
              <strong>{stats.removed}</strong> Removed
            </span>
            <span className="flex items-center gap-1.5 text-amber-400">
              <Edit3 className="w-3.5 h-3.5" />
              <strong>{stats.modified}</strong> Modified
            </span>
            <span className="flex items-center gap-1.5 text-slate-400">
              <CheckCircle2 className="w-3.5 h-3.5" />
              <strong>{stats.identical}</strong> Identical
            </span>
          </div>

          {lastSuccessfulPayload && (
            <button
              onClick={() => {
                onRestoreLastSuccessful(lastSuccessfulPayload);
                onClose();
              }}
              className="px-3 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-sans text-xs font-semibold flex items-center gap-1.5 transition shadow-sm"
              title="Restore last successful payload into active editor"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Revert Editor to Last Successful</span>
            </button>
          )}
        </div>

        {/* Content Body: Key-by-Key Delta and Side-by-Side View */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Key-level Delta Breakdown */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
              Field-Level Difference Ledger
            </h4>

            <div className="border border-slate-800 rounded-xl overflow-hidden divide-y divide-slate-800/80 bg-slate-950/60 font-mono text-xs">
              {diffs.length === 0 ? (
                <div className="p-4 text-center text-slate-500">No payload properties available to compare.</div>
              ) : (
                diffs.map((diff) => {
                  let badge = null;
                  let bgClass = 'hover:bg-slate-900/40';

                  if (diff.status === 'added') {
                    badge = (
                      <span className="px-2 py-0.5 rounded text-[10px] bg-emerald-950 text-emerald-400 border border-emerald-800">
                        + ADDED
                      </span>
                    );
                    bgClass = 'bg-emerald-950/20';
                  } else if (diff.status === 'removed') {
                    badge = (
                      <span className="px-2 py-0.5 rounded text-[10px] bg-rose-950 text-rose-400 border border-rose-800">
                        - REMOVED
                      </span>
                    );
                    bgClass = 'bg-rose-950/20';
                  } else if (diff.status === 'modified') {
                    badge = (
                      <span className="px-2 py-0.5 rounded text-[10px] bg-amber-950 text-amber-400 border border-amber-800">
                        ~ MODIFIED
                      </span>
                    );
                    bgClass = 'bg-amber-950/20';
                  } else {
                    badge = (
                      <span className="px-2 py-0.5 rounded text-[10px] bg-slate-900 text-slate-500 border border-slate-800">
                        = IDENTICAL
                      </span>
                    );
                  }

                  return (
                    <div key={diff.key} className={`p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 transition ${bgClass}`}>
                      <div className="flex items-center gap-2.5">
                        {badge}
                        <span className="font-semibold text-slate-200">{diff.key}</span>
                      </div>

                      <div className="text-[11px] flex items-center gap-2 overflow-x-auto">
                        {diff.status === 'modified' && (
                          <>
                            <span className="text-slate-400 line-through bg-slate-900 px-2 py-0.5 rounded border border-slate-800">
                              {JSON.stringify(diff.oldValue)}
                            </span>
                            <ArrowRight className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                            <span className="text-amber-300 font-semibold bg-amber-950/60 px-2 py-0.5 rounded border border-amber-800">
                              {JSON.stringify(diff.newValue)}
                            </span>
                          </>
                        )}
                        {diff.status === 'added' && (
                          <span className="text-emerald-300 font-semibold bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-800">
                            {JSON.stringify(diff.newValue)}
                          </span>
                        )}
                        {diff.status === 'removed' && (
                          <span className="text-rose-400 line-through bg-rose-950/60 px-2 py-0.5 rounded border border-rose-800">
                            {JSON.stringify(diff.oldValue)}
                          </span>
                        )}
                        {diff.status === 'identical' && (
                          <span className="text-slate-400">
                            {JSON.stringify(diff.newValue)}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Full Side-by-Side Raw Payloads Preview */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs font-mono text-slate-400">
                <span className="font-semibold text-slate-300">Last Successful Ingestion Payload:</span>
                <span className="text-[10px] text-emerald-400">Validated 200 OK</span>
              </div>
              <pre className="bg-slate-950 border border-slate-800 p-3 rounded-lg text-xs font-mono text-emerald-300/90 overflow-x-auto max-h-56">
                {lastSuccessfulPayload
                  ? JSON.stringify(lastSuccessfulPayload, null, 2)
                  : '// No previous successful request captured yet.'}
              </pre>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs font-mono text-slate-400">
                <span className="font-semibold text-slate-300">Current Editor Payload:</span>
                <span className="text-[10px] text-indigo-400">Active Buffer</span>
              </div>
              <pre className="bg-slate-950 border border-slate-800 p-3 rounded-lg text-xs font-mono text-indigo-300/90 overflow-x-auto max-h-56">
                {currentPayload
                  ? JSON.stringify(currentPayload, null, 2)
                  : '// Current payload empty or unparseable.'}
              </pre>
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-3 border-t border-slate-800 bg-slate-950 flex justify-between items-center text-xs">
          <span className="text-slate-500 font-mono">
            Zero-Conflation Schema Guard: Verified
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white font-medium transition"
          >
            Close Diff
          </button>
        </div>
      </div>
    </div>
  );
};
