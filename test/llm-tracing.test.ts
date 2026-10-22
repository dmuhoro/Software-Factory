/**
 * LLM call tracing tests (Layer 6 Observability).
 *
 * Proves:
 *  - LT-1  a model call is recorded with provider, model, latency, tokens, status
 *  - LT-2  failed calls are recorded with errorCode
 *  - LT-3  traces are queryable by tenant, run, provider, model, status
 *  - LT-4  metrics aggregate: totals, percentiles, by-model/provider/tenant
 *  - LT-5  the same inputs always yield the same trace record (deterministic)
 *  - LT-6  token estimates are honest (ceil of chars/4)
 *  - LT-7  traces feed /factory/metrics llm section
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DurableStore } from '../src/services/durableStore';
import { LLMTracingService } from '../src/services/llmTracingService';

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-llm-trace-'));
process.env.FACTORY_DATA_DIR = path.join(state, 'data');
process.env.NODE_ENV = 'test';
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });

DurableStore.resetForTests();
LLMTracingService.resetForTests();

const TENANT = 'llm-trace-tenant';

test('LT-1: a model call is recorded with provider, model, latency, tokens, status', () => {
  const trace = LLMTracingService.record({
    tenantId: TENANT,
    providerId: 'stub-provider',
    model: 'stub-code',
    latencyMs: 1250,
    inputChars: 400,
    outputChars: 200,
    status: 'success',
  });
  assert.equal(trace.tenantId, TENANT);
  assert.equal(trace.providerId, 'stub-provider');
  assert.equal(trace.model, 'stub-code');
  assert.equal(trace.latencyMs, 1250);
  assert.equal(trace.inputChars, 400);
  assert.equal(trace.outputChars, 200);
  assert.equal(trace.inputTokens, 100);  // ceil(400/4)
  assert.equal(trace.outputTokens, 50);  // ceil(200/4)
  assert.equal(trace.totalTokens, 150);
  assert.equal(trace.status, 'success');
  assert.ok(trace.id.length > 0);
  assert.ok(trace.timestamp.length > 0);
});

test('LT-2: failed calls are recorded with errorCode', () => {
  const trace = LLMTracingService.record({
    tenantId: TENANT,
    providerId: 'stub-provider',
    model: 'stub-code',
    latencyMs: 5000,
    inputChars: 100,
    outputChars: 0,
    status: 'failure',
    errorCode: 'MODEL_PROVIDER_REQUEST_TIMEOUT',
  });
  assert.equal(trace.status, 'failure');
  assert.equal(trace.errorCode, 'MODEL_PROVIDER_REQUEST_TIMEOUT');
  assert.equal(trace.outputTokens, 1);  // ceil(0/4) = max(1, 0) = 1
});

test('LT-3: traces are queryable by tenant, run, provider, model, status', () => {
  LLMTracingService.resetForTests();
  LLMTracingService.record({ tenantId: TENANT, providerId: 'p1', model: 'm1', latencyMs: 100, inputChars: 100, outputChars: 50, status: 'success' });
  LLMTracingService.record({ tenantId: TENANT, providerId: 'p2', model: 'm2', latencyMs: 200, inputChars: 100, outputChars: 50, status: 'failure', errorCode: 'ERR' });
  LLMTracingService.record({ tenantId: 'other-tenant', providerId: 'p1', model: 'm1', latencyMs: 100, inputChars: 100, outputChars: 50, status: 'success' });

  const byTenant = LLMTracingService.query({ tenantId: TENANT });
  assert.equal(byTenant.length, 2, 'tenant filter');

  const byStatus = LLMTracingService.query({ status: 'failure' });
  assert.equal(byStatus.length, 1, 'status filter');
  assert.equal(byStatus[0].errorCode, 'ERR');

  const byProvider = LLMTracingService.query({ providerId: 'p1' });
  assert.equal(byProvider.length, 2, 'provider filter (includes other-tenant)');

  const byModel = LLMTracingService.query({ model: 'm1' });
  assert.equal(byModel.length, 2, 'model filter');

  // Newest first.
  assert.ok(byTenant[0].timestamp >= byTenant[1].timestamp, 'newest first');
});

test('LT-4: metrics aggregate totals, percentiles, by-model/provider/tenant', () => {
  LLMTracingService.resetForTests();
  LLMTracingService.record({ tenantId: TENANT, providerId: 'p1', model: 'm1', latencyMs: 100, inputChars: 400, outputChars: 200, status: 'success' });
  LLMTracingService.record({ tenantId: TENANT, providerId: 'p1', model: 'm1', latencyMs: 200, inputChars: 400, outputChars: 200, status: 'success' });
  LLMTracingService.record({ tenantId: TENANT, providerId: 'p2', model: 'm2', latencyMs: 300, inputChars: 400, outputChars: 200, status: 'failure' });

  const traces = LLMTracingService.query({ tenantId: TENANT });
  const metrics = LLMTracingService.metrics(traces);
  assert.equal(metrics.totalCalls, 3);
  assert.equal(metrics.successfulCalls, 2);
  assert.equal(metrics.failedCalls, 1);
  assert.equal(metrics.totalTokens, 450);  // 3 * 150
  assert.equal(metrics.avgLatencyMs, 200);  // (100+200+300)/3
  assert.equal(metrics.p50LatencyMs, 200);
  assert.equal(metrics.p95LatencyMs, 300);
  assert.equal(metrics.callsByModel.length, 2);
  assert.equal(metrics.callsByProvider.length, 2);
  assert.equal(metrics.callsByTenant.length, 1);
  assert.equal(metrics.callsByTenant[0].tenantId, TENANT);
  assert.equal(metrics.callsByTenant[0].calls, 3);
});

test('LT-5: the same inputs always yield the same trace record (deterministic)', () => {
  LLMTracingService.resetForTests();
  // Note: trace id includes a counter, so it's not strictly identical across calls,
  // but all deterministic fields are the same.
  const first = LLMTracingService.record({ tenantId: TENANT, providerId: 'p1', model: 'm1', latencyMs: 100, inputChars: 400, outputChars: 200, status: 'success' });
  const second = LLMTracingService.record({ tenantId: TENANT, providerId: 'p1', model: 'm1', latencyMs: 100, inputChars: 400, outputChars: 200, status: 'success' });
  assert.equal(first.tenantId, second.tenantId);
  assert.equal(first.providerId, second.providerId);
  assert.equal(first.model, second.model);
  assert.equal(first.latencyMs, second.latencyMs);
  assert.equal(first.inputTokens, second.inputTokens);
  assert.equal(first.outputTokens, second.outputTokens);
  assert.equal(first.totalTokens, second.totalTokens);
  assert.equal(first.status, second.status);
  assert.notEqual(first.id, second.id, 'counter makes ids unique');
});

test('LT-6: token estimates are honest (ceil of chars/4)', () => {
  LLMTracingService.resetForTests();
  const t = LLMTracingService.record({ tenantId: TENANT, providerId: 'p1', model: 'm1', latencyMs: 10, inputChars: 5, outputChars: 0, status: 'success' });
  assert.equal(t.inputTokens, 2);  // ceil(5/4) = 2
  assert.equal(t.outputTokens, 1);  // max(1, ceil(0/4)) = 1
});

test('LT-7: traces feed /factory/metrics llm section (integration shape)', async () => {
  LLMTracingService.resetForTests();
  // Verifies the metrics query path works without crashing.
  LLMTracingService.record({ tenantId: TENANT, providerId: 'p1', model: 'm1', latencyMs: 100, inputChars: 400, outputChars: 200, status: 'success' });
  const traces = LLMTracingService.query({ limit: 10_000 });
  const metrics = LLMTracingService.metrics(traces);
  assert.ok(metrics.totalCalls >= 1);
  assert.ok(typeof metrics.avgLatencyMs === 'number');
  assert.ok(Array.isArray(metrics.callsByModel));
  assert.ok(Array.isArray(metrics.callsByProvider));
  assert.ok(Array.isArray(metrics.callsByTenant));
});

test('LT-8: a declared price yields a cost, and no declared price yields an unknown cost', () => {
  LLMTracingService.resetForTests();
  const priced = LLMTracingService.record({
    tenantId: TENANT, providerId: 'p1', model: 'm1', latencyMs: 10, inputChars: 400, outputChars: 200, status: 'success',
    inputCostPerMillionTokens: 3, outputCostPerMillionTokens: 15,
  });
  // 100 input tokens at $3/M = 0.0003; 50 output tokens at $15/M = 0.00075.
  assert.equal(priced.costBasis, 'declared-pricing');
  assert.ok(Math.abs((priced.costUsd ?? 0) - 0.00105) < 1e-9, `unexpected cost ${priced.costUsd}`);

  const unpriced = LLMTracingService.record({
    tenantId: TENANT, providerId: 'p2', model: 'm2', latencyMs: 10, inputChars: 400, outputChars: 200, status: 'success',
  });
  assert.equal(unpriced.costBasis, 'unknown');
  assert.equal(unpriced.costUsd, undefined, 'an unpriced call has no cost, not a zero cost');
});

test('LT-9: provider-reported tokens are used when the provider reports them', () => {
  LLMTracingService.resetForTests();
  const reported = LLMTracingService.record({
    tenantId: TENANT, providerId: 'p1', model: 'm1', latencyMs: 10, inputChars: 400, outputChars: 200, status: 'success',
    reportedInputTokens: 1234, reportedOutputTokens: 567,
  });
  assert.equal(reported.tokensSource, 'provider-reported');
  assert.equal(reported.inputTokens, 1234);
  assert.equal(reported.outputTokens, 567);
  assert.equal(reported.totalTokens, 1801);

  const estimated = LLMTracingService.record({
    tenantId: TENANT, providerId: 'p1', model: 'm1', latencyMs: 10, inputChars: 400, outputChars: 200, status: 'success',
  });
  assert.equal(estimated.tokensSource, 'estimated');
});

test('LT-10: a trace names the door the call left through', () => {
  LLMTracingService.resetForTests();
  const guarded = LLMTracingService.record({ tenantId: TENANT, providerId: 'p1', model: 'm1', latencyMs: 10, inputChars: 10, outputChars: 10, status: 'success' });
  assert.equal(guarded.door, 'egress-guard');
  const sdk = LLMTracingService.record({ tenantId: TENANT, providerId: 'p2', model: 'm2', latencyMs: 10, inputChars: 10, outputChars: 10, status: 'success', door: 'model-egress' });
  assert.equal(sdk.door, 'model-egress');

  const metrics = LLMTracingService.metrics(LLMTracingService.query({ tenantId: TENANT }));
  assert.equal(metrics.callsByDoor.length, 2);
});

test('LT-11: metrics count an unknown cost separately instead of counting it as free', () => {
  LLMTracingService.resetForTests();
  LLMTracingService.record({ tenantId: TENANT, providerId: 'p1', model: 'm1', latencyMs: 10, inputChars: 400, outputChars: 200, status: 'success', inputCostPerMillionTokens: 3, outputCostPerMillionTokens: 15 });
  LLMTracingService.record({ tenantId: TENANT, providerId: 'p2', model: 'm2', latencyMs: 10, inputChars: 400, outputChars: 200, status: 'success' });

  const metrics = LLMTracingService.metrics(LLMTracingService.query({ tenantId: TENANT }));
  assert.equal(metrics.totalCalls, 2);
  assert.equal(metrics.unknownCostCalls, 1);
  assert.ok(metrics.totalCostUsd > 0, 'the priced call contributes its cost');
  assert.ok(metrics.totalCostUsd < 0.01, 'and only that call');
});

test('LT-12: a live call through the guarded door is traced with its run, door, latency and cost', async () => {
  LLMTracingService.resetForTests();
  const http = await import('node:http');
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const { FrontierModelService } = await import('../src/services/frontierModelService');
    FrontierModelService.register({
      tenantId: TENANT, id: 'traced', kind: 'local', baseUrl: `http://127.0.0.1:${port}/v1`, modelIds: ['stub-code'],
      inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8,
    });
    await FrontierModelService.request(TENANT, { providerId: 'traced', model: 'stub-code', system: 'system', task: 'task', runId: 'run-42' });

    const traces = LLMTracingService.query({ tenantId: TENANT, runId: 'run-42' });
    assert.equal(traces.length, 1, 'the call through the door was not traced');
    const trace = traces[0];
    assert.equal(trace.door, 'egress-guard');
    assert.equal(trace.status, 'success');
    assert.ok(trace.latencyMs >= 0);
    assert.ok(trace.inputTokens > 0);
    assert.equal(trace.costBasis, 'declared-pricing');
    assert.ok((trace.costUsd ?? 0) > 0, 'a declared price yields a real cost');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('LT-13: the deterministic Gemini path makes no model call, so it records no trace', async () => {
  LLMTracingService.resetForTests();
  const { GeminiService } = await import('../src/services/geminiService');
  const { IndustryNiche } = await import('../src/models/tenant');
  const result = await GeminiService.transformTelemetry(TENANT, IndustryNiche.REAL_ESTATE, 'listing.created', { listingId: 'L-1' }, 'corr-1');
  assert.equal(result.tokensUsed, 0, 'the deterministic path reports no tokens because no call was made');
  const traces = LLMTracingService.query({ tenantId: TENANT });
  assert.deepEqual(traces, [], 'a path that made no model call must not leave a trace');
});

test('LT-14: the Gemini service traces its live calls through the SDK door', () => {
  // The Gemini path leaves through the sanctioned SDK door (ADR-011), which is a different door
  // from the guarded one. A trace that does not name the door cannot prove which egress path a
  // call took, so the wiring is asserted here rather than assumed.
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'geminiService.ts'), 'utf8');
  assert.match(source, /LLMTracingService\.record\(/, 'the Gemini service records no trace');
  assert.match(source, /door: 'model-egress'/, 'the Gemini trace does not name the SDK door');
});
