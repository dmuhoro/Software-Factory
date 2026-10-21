/**
 * LLM call tracing (Layer 6 Observability).
 *
 * Opik-style tracing for model calls through SF's single egress door (ADR-011).
 * Every model request is recorded: provider, model, tenant, latency, token
 * estimates, success/failure. Traces feed L6 metrics: token cost per run,
 * latency percentiles, success/failure rates.
 *
 * Read-only observability: traces are written to SF's own durable ledger,
 * never to a target tree. The same trace input always yields the same record.
 *
 * Token estimation (no tokenizer dependency): ~4 chars per token for input,
 * output chars / 4 for output. Honest about being an estimate.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { DurableStore } from './durableStore';

export interface LLMTrace {
  id: string;
  tenantId: string;
  runId?: string;
  providerId: string;
  model: string;
  timestamp: string;
  latencyMs: number;
  inputChars: number;
  outputChars: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  status: 'success' | 'failure';
  errorCode?: string;
}

export interface TraceQuery {
  tenantId?: string;
  runId?: string;
  providerId?: string;
  model?: string;
  status?: 'success' | 'failure';
  since?: string;   // ISO timestamp
  until?: string;   // ISO timestamp
  limit?: number;
}

export interface TraceMetrics {
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalLatencyMs: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  callsByModel: Array<{ model: string; calls: number; tokens: number }>;
  callsByProvider: Array<{ providerId: string; calls: number; tokens: number }>;
  callsByTenant: Array<{ tenantId: string; calls: number; tokens: number }>;
}

/** Rough token estimate: ~4 chars per token. No tokenizer dependency. */
function estimateTokens(chars: number): number {
  return Math.max(1, Math.ceil(chars / 4));
}

function stableId(tenantId: string, providerId: string, model: string, timestamp: string, index: number): string {
  return createHash('sha256').update(`${tenantId}:${providerId}:${model}:${timestamp}:${index}`).digest('hex').slice(0, 16);
}

/** The tracing service: record and query LLM call traces. */
export class LLMTracingService {
  private static counter = 0;

  /**
   * Record one model call trace. Called by FrontierModelService.request()
   * after each model invocation. Pure given the same inputs.
   */
  public static record(input: {
    tenantId: string;
    runId?: string;
    providerId: string;
    model: string;
    latencyMs: number;
    inputChars: number;
    outputChars: number;
    status: 'success' | 'failure';
    errorCode?: string;
  }): LLMTrace {
    LLMTracingService.counter += 1;
    const inputTokens = estimateTokens(input.inputChars);
    const outputTokens = estimateTokens(input.outputChars);
    const timestamp = new Date().toISOString();
    const trace: LLMTrace = {
      id: `trace-${stableId(input.tenantId, input.providerId, input.model, timestamp, LLMTracingService.counter)}`,
      tenantId: input.tenantId,
      runId: input.runId,
      providerId: input.providerId,
      model: input.model,
      timestamp,
      latencyMs: input.latencyMs,
      inputChars: input.inputChars,
      outputChars: input.outputChars,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      status: input.status,
      errorCode: input.errorCode,
    };
    DurableStore.upsert('llmTraces', trace.id, trace as unknown as Record<string, unknown>);
    return trace;
  }

  /** Query traces with optional filters. Returns newest first. */
  public static query(query: TraceQuery = {}): LLMTrace[] {
    let traces = DurableStore.list('llmTraces') as unknown as LLMTrace[];

    if (query.tenantId) traces = traces.filter((t) => t.tenantId === query.tenantId);
    if (query.runId) traces = traces.filter((t) => t.runId === query.runId);
    if (query.providerId) traces = traces.filter((t) => t.providerId === query.providerId);
    if (query.model) traces = traces.filter((t) => t.model === query.model);
    if (query.status) traces = traces.filter((t) => t.status === query.status);
    if (query.since) traces = traces.filter((t) => t.timestamp >= query.since!);
    if (query.until) traces = traces.filter((t) => t.timestamp <= query.until!);

    traces.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    if (query.limit) traces = traces.slice(0, query.limit);
    return traces;
  }

  /** Aggregate metrics for a set of traces. */
  public static metrics(traces: LLMTrace[]): TraceMetrics {
    const totalCalls = traces.length;
    const successfulCalls = traces.filter((t) => t.status === 'success').length;
    const failedCalls = traces.filter((t) => t.status === 'failure').length;
    const totalInputTokens = traces.reduce((a, t) => a + t.inputTokens, 0);
    const totalOutputTokens = traces.reduce((a, t) => a + t.outputTokens, 0);
    const totalTokens = traces.reduce((a, t) => a + t.totalTokens, 0);
    const totalLatencyMs = traces.reduce((a, t) => a + t.latencyMs, 0);
    const avgLatencyMs = totalCalls > 0 ? totalLatencyMs / totalCalls : 0;

    const latencies = [...traces.map((t) => t.latencyMs)].sort((a, b) => a - b);
    const p = (quantile: number) => {
      if (latencies.length === 0) return 0;
      const idx = Math.min(latencies.length - 1, Math.floor(latencies.length * quantile));
      return latencies[idx];
    };

    const byModel = new Map<string, { calls: number; tokens: number }>();
    const byProvider = new Map<string, { calls: number; tokens: number }>();
    const byTenant = new Map<string, { calls: number; tokens: number }>();
    for (const t of traces) {
      const m = byModel.get(t.model) ?? { calls: 0, tokens: 0 };
      m.calls += 1; m.tokens += t.totalTokens; byModel.set(t.model, m);
      const p = byProvider.get(t.providerId) ?? { calls: 0, tokens: 0 };
      p.calls += 1; p.tokens += t.totalTokens; byProvider.set(t.providerId, p);
      const te = byTenant.get(t.tenantId) ?? { calls: 0, tokens: 0 };
      te.calls += 1; te.tokens += t.totalTokens; byTenant.set(t.tenantId, te);
    }

    return {
      totalCalls,
      successfulCalls,
      failedCalls,
      totalInputTokens,
      totalOutputTokens,
      totalTokens,
      totalLatencyMs,
      avgLatencyMs,
      p50LatencyMs: p(0.5),
      p95LatencyMs: p(0.95),
      p99LatencyMs: p(0.99),
      callsByModel: [...byModel.entries()].map(([model, v]) => ({ model, ...v })),
      callsByProvider: [...byProvider.entries()].map(([providerId, v]) => ({ providerId, ...v })),
      callsByTenant: [...byTenant.entries()].map(([tenantId, v]) => ({ tenantId, ...v })),
    };
  }

  /** Test seam: reset the trace counter and store. Clears disk so traces don't persist across tests. */
  public static resetForTests(): void {
    LLMTracingService.counter = 0;
    DurableStore.resetForTests();
    const dataFile = DurableStore.dataFile();
    try { fs.rmSync(dataFile, { force: true }); } catch { /* ignore */ }
  }
}

export const llmTracingService = LLMTracingService;
