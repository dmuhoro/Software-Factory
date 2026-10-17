/**
 * Interactive intake panel (Sprint 33, WP-2).
 *
 * The phone-facing surface for a grill session: start one, answer one question at a time, and
 * finish. Credentials live only in component memory — never in localStorage, sessionStorage, a
 * cookie or the URL — exactly as `LoopControlPanel` holds them.
 */
import React, { useCallback, useState } from 'react';
import { MessageCircleQuestion, Play, Send, Flag, RefreshCw, AlertTriangle, CheckCircle2 } from 'lucide-react';

interface Creds { tenantId: string; apiKey: string }
interface Turn { question: string; answer?: string }
interface Session { sessionId: string; status: string; cap: number; turns: Turn[]; taskDocument?: string }

function headers(creds: Creds, contentType = false): Record<string, string> {
  const base: Record<string, string> = { 'x-api-key': creds.apiKey, 'x-tenant-id': creds.tenantId };
  if (contentType) base['content-type'] = 'application/json';
  return base;
}

async function callApi(path: string, creds: Creds, init?: RequestInit): Promise<any> {
  const response = await fetch(path, { ...init, headers: { ...headers(creds, Boolean(init?.body)), ...(init?.headers ?? {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.code || `HTTP ${response.status}`);
  return body;
}

export function GrillIntakePanel() {
  const [creds, setCreds] = useState<Creds>({ tenantId: '', apiKey: '' });
  const [repo, setRepo] = useState('');
  const [goal, setGoal] = useState('');
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [session, setSession] = useState<Session | null>(null);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [draft, setDraft] = useState<{ taskDocument: string; title: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const start = () => run(async () => {
    const body = await callApi('/api/loop/grills', creds, { method: 'POST', body: JSON.stringify({ repo, goal, providerId, model }) });
    setDraft(null);
    setSession({ sessionId: body.sessionId, status: body.status, cap: body.cap, turns: [] });
    setQuestion(body.question ?? '');
    setAnswer('');
  });

  const send = () => run(async () => {
    if (!session) return;
    const body = await callApi(`/api/loop/grills/${session.sessionId}/answers`, creds, { method: 'POST', body: JSON.stringify({ answer }) });
    setAnswer('');
    setQuestion(body.question ?? '');
    const record = await callApi(`/api/loop/grills/${session.sessionId}`, creds);
    setSession({ sessionId: record.session.sessionId, status: record.session.status, cap: record.session.cap, turns: record.session.turns });
  });

  const finish = () => run(async () => {
    if (!session) return;
    const body = await callApi(`/api/loop/grills/${session.sessionId}/finish`, creds, { method: 'POST', body: JSON.stringify({}) });
    setDraft({ taskDocument: body.taskDocument, title: body.title });
    setSession((prev) => (prev ? { ...prev, status: 'drafted', taskDocument: body.taskDocument } : prev));
    setQuestion('');
  });

  return (
    <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 space-y-4">
      <div className="flex items-center gap-2">
        <MessageCircleQuestion className="w-4 h-4 text-indigo-400" />
        <h2 className="text-sm font-semibold text-white">Interactive Intake — Grill Session</h2>
        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
          one question per turn
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="text-xs text-slate-400">
          Tenant id
          <input value={creds.tenantId} onChange={(e) => setCreds({ ...creds, tenantId: e.target.value })} className="mt-1 w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-200" />
        </label>
        <label className="text-xs text-slate-400">
          API key
          <input type="password" value={creds.apiKey} onChange={(e) => setCreds({ ...creds, apiKey: e.target.value })} className="mt-1 w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-200" />
        </label>
        <label className="text-xs text-slate-400">
          Repository (inside the approved workspace)
          <input value={repo} onChange={(e) => setRepo(e.target.value)} className="mt-1 w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-200" />
        </label>
        <label className="text-xs text-slate-400">
          Goal
          <input value={goal} onChange={(e) => setGoal(e.target.value)} className="mt-1 w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200" />
        </label>
        <label className="text-xs text-slate-400">
          Provider id
          <input value={providerId} onChange={(e) => setProviderId(e.target.value)} className="mt-1 w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-200" />
        </label>
        <label className="text-xs text-slate-400">
          Model
          <input value={model} onChange={(e) => setModel(e.target.value)} className="mt-1 w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-200" />
        </label>
      </div>

      <button onClick={start} disabled={busy || !goal.trim()} className="py-2 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium flex items-center gap-2 disabled:opacity-50">
        {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
        Start session
      </button>

      {error && (
        <p className="text-xs text-red-300 bg-red-950/40 border border-red-800/60 rounded-lg p-3 flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-red-400" /> {error}
        </p>
      )}

      {session && (
        <div className="space-y-3 border-t border-slate-800 pt-3">
          <p className="text-[11px] font-mono text-slate-400">
            status: <span className="text-slate-200">{session.status}</span> · asked {session.turns.length} of {session.cap}
          </p>
          {session.turns.map((turn, i) => (
            <div key={i} className="text-xs space-y-1">
              <p className="text-slate-300"><span className="text-indigo-400 font-mono">Q{i + 1}.</span> {turn.question}</p>
              {turn.answer !== undefined && <p className="text-slate-400 pl-5"><span className="text-slate-500 font-mono">A.</span> {turn.answer}</p>}
            </div>
          ))}

          {question && session.status === 'asking' && (
            <div className="bg-slate-950 border border-slate-800 rounded-lg p-3 space-y-2">
              <p className="text-xs text-slate-200"><span className="text-indigo-400 font-mono">Q{session.turns.length + 1}.</span> {question}</p>
              <textarea rows={3} value={answer} onChange={(e) => setAnswer(e.target.value)} className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-xs text-slate-200 resize-none" />
              <button onClick={send} disabled={busy || !answer.trim()} className="py-1.5 px-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs flex items-center gap-1.5 disabled:opacity-50">
                <Send className="w-3 h-3" /> Answer
              </button>
            </div>
          )}

          {session.status !== 'drafted' && (
            <button onClick={finish} disabled={busy} className="py-1.5 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs flex items-center gap-1.5 disabled:opacity-50">
              <Flag className="w-3 h-3 text-emerald-400" /> Finish & draft the task document
            </button>
          )}

          {draft && (
            <p className="text-xs text-emerald-300 bg-emerald-950/40 border border-emerald-800/60 rounded-lg p-3 flex items-center gap-2">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Drafted <span className="font-mono">{draft.title}</span> → {draft.taskDocument}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
