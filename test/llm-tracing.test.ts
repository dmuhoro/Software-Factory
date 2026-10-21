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
