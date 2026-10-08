/**
 * Operator panel for the unattended loop.
 *
 * Sprint 24. The control plane below is authenticated, so a browser needs a credential to use
 * it. This panel takes that credential from the operator and keeps it in component state only:
 * it is never written to localStorage, sessionStorage, a cookie, or the URL, and it is dropped the
 * moment the panel unmounts. That is the deliberate trade-off -- a convenient but persisted
 * credential for a surface that can start work would be worse than no panel at all.
 *
 * The run stream is read with fetch rather than EventSource, because EventSource cannot send the
 * `x-api-key` header this API requires.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Play, RefreshCw, Sparkles, SquareTerminal, X } from 'lucide-react';

interface RunSummary {
  runId: string;
  status: string;
  repo: string;
  taskDocument: string;
  startedAt: string;
  finishedAt?: string;
  active: boolean;
  units: { total: number; done: number; stuck: number; blocked: number };
  commits: number;
  refusedGates: number;
  hardStop?: string;
  refusal?: string;
}

interface LoopEvent {
  at: string;
  stage: string;
  level: string;
  message: string;
}

interface Credentials {
  tenantId: string;
  apiKey: string;
}

function headers(creds: Credentials, contentType = false): Record<string, string> {
  const out: Record<string, string> = { 'x-api-key': creds.apiKey, 'x-tenant-id': creds.tenantId };
  if (contentType) out['content-type'] = 'application/json';
  return out;
}

async function callApi(path: string, creds: Credentials, init?: RequestInit): Promise<any> {
  const response = await fetch(path, { ...init, headers: headers(creds, Boolean(init?.body)) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.message || `${body?.code || 'REQUEST_FAILED'} (${response.status})`);
  return body;
}

export function LoopControlPanel(): React.ReactElement {
  const [tenantId, setTenantId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [repo, setRepo] = useState('');
  const [taskDocument, setTaskDocument] = useState('');
  const [goal, setGoal] = useState('');
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [watched, setWatched] = useState<string | null>(null);
  const [events, setEvents] = useState<LoopEvent[]>([]);
  const [statusLine, setStatusLine] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const creds: Credentials = { tenantId, apiKey };
  const ready = Boolean(tenantId.trim() && apiKey.trim());

  const refresh = useCallback(async () => {
    if (!ready) return;
    setError('');
    try {
      const body = await callApi('/api/loop/runs', creds);
      setRuns(body.runs ?? []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [ready, tenantId, apiKey]);

  useEffect(() => {
    if (!ready) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [ready, refresh]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const stopWatch = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setWatched(null);
  }, []);

  const watch = useCallback(async (runId: string) => {
    if (!ready) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setWatched(runId);
    setEvents([]);
    setStatusLine('connecting…');
    setError('');
    try {
      const response = await fetch(`/api/loop/runs/${runId}/events`, { headers: headers(creds), signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(`stream refused (${response.status})`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut = buffer.indexOf('\n\n');
        while (cut >= 0) {
          const chunk = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          cut = buffer.indexOf('\n\n');
          const lines = chunk.split('\n');
          const name = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
          const data = lines.find((line) => line.startsWith('data:'))?.slice(5).trim();
          if (!data) continue;
          let parsed: any;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }
          if (name === 'done' || name === 'end') {
            finished = name === 'done' ? String(parsed.status ?? 'finished') : 'stream ended';
            continue;
          }
          setEvents((previous) => [...previous, parsed as LoopEvent]);
        }
        if (finished) {
          setStatusLine(finished);
          break;
        }
      }
      if (!finished) setStatusLine('stream ended');
    } catch (reason) {
      if (!controller.signal.aborted) {
        const message = reason instanceof Error ? reason.message : String(reason);
        setError(message);
        setStatusLine('failed');
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [ready, tenantId, apiKey]);

  const submit = useCallback(async () => {
    if (!ready) return;
    setBusy(true);
    setError('');
    try {
      const body = await callApi('/api/loop/runs', creds, { method: 'POST', body: JSON.stringify({ tenantId, repo, taskDocument }) });
      await refresh();
      await watch(body.runId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [ready, tenantId, apiKey, repo, taskDocument, refresh, watch]);

  const draft = useCallback(async () => {
    if (!ready) return;
    setBusy(true);
    setError('');
    try {
      const body = await callApi('/api/loop/goals', creds, {
        method: 'POST',
        body: JSON.stringify({ tenantId, repo, goal, providerId, model }),
      });
      setTaskDocument(body.taskDocument);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [ready, tenantId, apiKey, repo, goal, providerId, model]);

  const field = 'w-full rounded-lg bg-slate-950/60 border border-slate-700/70 px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/50';
  const label = 'block text-[11px] font-medium uppercase tracking-wide text-slate-400 mb-1';
  const card = 'rounded-xl border border-slate-800 bg-slate-900/60 backdrop-blur-sm p-5 space-y-4';

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-300">
        The credential below is held in memory for this browser tab only. It is never stored or sent anywhere except to this
        service. Closing the tab forgets it.
      </div>

      <div className={card}>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className={label}>Tenant ID</label>
            <input className={field} value={tenantId} placeholder="tenant_..." onChange={(event) => setTenantId(event.target.value)} />
          </div>
          <div>
            <label className={label}>API key (held in memory only)</label>
            <input className={field} type="password" autoComplete="off" value={apiKey} placeholder="paste your tenant API key"
              onChange={(event) => setApiKey(event.target.value)} />
          </div>
          <div className="flex items-end">
            <button onClick={() => void refresh()} disabled={!ready}
              className="w-full flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200">
              <RefreshCw className="w-3.5 h-3.5" /> Refresh runs
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className={card}>
          <h3 className="text-sm font-semibold text-white">Submit a run</h3>
          <div>
            <label className={label}>Target repository (inside the approved workspace)</label>
            <input className={field} value={repo} placeholder="/path/to/repository" onChange={(event) => setRepo(event.target.value)} />
          </div>
          <div>
            <label className={label}>Task document</label>
            <input className={field} value={taskDocument} placeholder="/path/to/task.md" onChange={(event) => setTaskDocument(event.target.value)} />
          </div>
          <button onClick={() => void submit()} disabled={!ready || busy || !repo.trim() || !taskDocument.trim()}
            className="flex items-center gap-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 px-4 py-2 text-xs font-medium text-white">
            <Play className="w-3.5 h-3.5" /> Run unattended
          </button>
        </div>

        <div className={card}>
          <h3 className="text-sm font-semibold text-white">Draft a goal</h3>
          <div>
            <label className={label}>Goal</label>
            <textarea className={field} rows={3} value={goal} placeholder="Add an endpoint that reports liveness" onChange={(event) => setGoal(event.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Provider ID</label>
              <input className={field} value={providerId} placeholder="anthropic" onChange={(event) => setProviderId(event.target.value)} />
            </div>
            <div>
              <label className={label}>Model</label>
              <input className={field} value={model} placeholder="claude-..." onChange={(event) => setModel(event.target.value)} />
            </div>
          </div>
          <button onClick={() => void draft()} disabled={!ready || busy || !goal.trim() || !providerId.trim() || !model.trim()}
            className="flex items-center gap-2 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-40 px-4 py-2 text-xs font-medium text-white">
            <Sparkles className="w-3.5 h-3.5" /> Draft task document
          </button>
          <p className="text-[11px] text-slate-500">The draft is written into the workspace and filled into the field above. The loop refuses any draft its parser rejects.</p>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-xs text-red-300">{error}</div>
      )}

      <div className={card}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">Runs</h3>
          <span className="text-[11px] text-slate-500">{runs.length} recorded</span>
        </div>
        {runs.length === 0 ? (
          <p className="text-xs text-slate-500">No runs yet{ready ? '' : ' — add credentials above'}.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-800">
                  <th className="py-2 pr-3">Run</th><th className="py-2 pr-3">Status</th><th className="py-2 pr-3">Units</th>
                  <th className="py-2 pr-3">Commits</th><th className="py-2 pr-3">Started</th><th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.runId} className="border-b border-slate-800/70">
                    <td className="py-2 pr-3 font-mono text-slate-300">{run.runId}</td>
                    <td className="py-2 pr-3">
                      <span className={`px-2 py-0.5 rounded ${run.status === 'completed' ? 'bg-emerald-500/15 text-emerald-300' : run.active ? 'bg-indigo-500/15 text-indigo-300' : 'bg-amber-500/15 text-amber-300'}`}>
                        {run.status}
                      </span>
                    </td>
                    <td className="py-2 pr-3">{run.units.done}/{run.units.total}{run.units.stuck ? ` (${run.units.stuck} stuck)` : ''}</td>
                    <td className="py-2 pr-3">{run.commits}</td>
                    <td className="py-2 pr-3 text-slate-400">{new Date(run.startedAt).toLocaleTimeString()}</td>
                    <td className="py-2 text-right">
                      <button onClick={() => (watched === run.runId ? stopWatch() : void watch(run.runId))} disabled={!ready}
                        className="inline-flex items-center gap-1 rounded px-2 py-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-40">
                        {watched === run.runId ? <X className="w-3 h-3" /> : <SquareTerminal className="w-3 h-3" />}
                        {watched === run.runId ? 'Stop' : 'Watch'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {watched && (
        <div className={card}>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">Live events — <span className="font-mono text-slate-400">{watched}</span></h3>
            <span className="text-[11px] text-slate-500">{statusLine}</span>
          </div>
          <div className="max-h-80 overflow-y-auto space-y-1 font-mono text-[11px] leading-relaxed">
            {events.length === 0 && <p className="text-slate-500">waiting for events…</p>}
            {events.map((event, index) => (
              <div key={index} className={event.level === 'error' ? 'text-red-300' : event.level === 'warn' ? 'text-amber-300' : 'text-slate-400'}>
                <span className="text-slate-500">{event.at}</span> [{event.stage}] {event.message}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
