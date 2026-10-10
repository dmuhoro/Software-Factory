/**
 * WP-10: usage is metered from what was actually consumed, and the meter is exact.
 *
 * The service declares an AI-token budget per tier (`maxDailyAiTokens`) that nothing ever read.
 * A budget with no meter is unenforceable. This puts the meter on trial:
 *
 *  - it records only observed usage: the deterministic fallback (no API key) reports 0 tokens,
 *    never the old fabricated 420 or 512;
 *  - it is exact and idempotent: the day total equals the sum of recorded events, and a retried
 *    call with the same correlation id is not counted twice;
 *  - it refuses an invalid figure rather than rounding or coercing it;
 *  - the real orchestrator records what the enrichment reported, not a constant;
 *  - the route answers for the authenticated caller only.
 *
 * Failing-first: restoring `tokensUsed: 420` fails the honesty arm; removing the orchestrator's
 * `UsageMeteringService.record` call fails the wiring arm; a meter that ignores the correlation
 * id fails the idempotency arm.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import type { Express } from 'express';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-wp10-'));
process.env.NODE_ENV = 'test';
process.env.FACTORY_DATA_DIR = DATA_DIR;
delete process.env.ALLOW_INSECURE_LOCAL;
delete process.env.FACTORY_TENANT_SEED_DEMO;
delete process.env.GEMINI_API_KEY;

const { UsageMeteringService } = await import('../src/services/usageMeteringService');
const { GeminiService } = await import('../src/services/geminiService');
const { PipelineOrchestrator } = await import('../src/services/pipelineOrchestrator');
const { AppwriteService } = await import('../src/services/appwriteService');
const { TenantService } = await import('../src/services/tenantService');
const { DurableStore } = await import('../src/services/durableStore');
const { IndustryNiche, TenantStatus, TenantSubscriptionTier } = await import('../src/models/tenant');

const TENANT = 'tenant_wp10_usage';
const OTHER = 'tenant_wp10_other';

type Niche = (typeof IndustryNiche)[keyof typeof IndustryNiche];
function register(id: string, niche: Niche): void {
  TenantService.registerTenant({
    id, name: id, niche, tier: TenantSubscriptionTier.PROFESSIONAL, status: TenantStatus.ACTIVE, apiKeyHash: '',
    quota: { maxRequestsPerMinute: 100_000, maxDailyAiTokens: 1000, burstCapacity: 10_000, storageLimitMb: 100 },
    customGuardrails: [], encryptionKeyId: 'test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
}
register(TENANT, IndustryNiche.REAL_ESTATE);
register(OTHER, IndustryNiche.LOGISTICS);

test('WP-10: the day total equals the sum of recorded events for that tenant', () => {
  UsageMeteringService.record({ tenantId: TENANT, source: 'ai-transform', tokens: 10 });
  UsageMeteringService.record({ tenantId: TENANT, source: 'ai-transform', tokens: 25 });
  UsageMeteringService.record({ tenantId: OTHER, source: 'ai-transform', tokens: 900 });
  assert.equal(UsageMeteringService.daily(TENANT).tokens, 35, 'the meter must sum exactly the tenant\'s own events');
  assert.equal(UsageMeteringService.daily(TENANT).events, 2);
  assert.equal(UsageMeteringService.daily(OTHER).tokens, 900, 'another tenant\'s usage must not leak into this total');
});

test('WP-10: a retried call with the same correlation id is metered once', () => {
  const before = UsageMeteringService.daily(TENANT).tokens;
  UsageMeteringService.record({ tenantId: TENANT, source: 'ai-transform', tokens: 40, correlationId: 'corr_wp10_1' });
  UsageMeteringService.record({ tenantId: TENANT, source: 'ai-transform', tokens: 40, correlationId: 'corr_wp10_1' });
  assert.equal(UsageMeteringService.daily(TENANT).tokens, before + 40, 'the same correlation id must not double-count');
});

test('WP-10: an invalid token figure is refused, not rounded or coerced', () => {
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '5' as unknown as number, undefined as unknown as number]) {
    assert.throws(() => UsageMeteringService.record({ tenantId: TENANT, source: 'ai-transform', tokens: bad }), /USAGE_TOKENS_INVALID/, `tokens=${String(bad)} must be refused`);
  }
});

test('WP-10: the deterministic fallback reports zero tokens, not a fabricated constant', async () => {
  const result = await GeminiService.transformTelemetry(TENANT, IndustryNiche.REAL_ESTATE, 'PROPERTY_VALUATION_REQUEST', { propertyId: 'p' }, 'corr_fallback');
  assert.equal(result.tokensUsed, 0, 'no API call means no tokens; the old code reported 420');
});

test('WP-10: geminiService no longer contains a fabricated token constant', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'geminiService.ts'), 'utf8');
  assert.ok(!/tokensUsed:\s*420/.test(source), 'the fabricated 420 fallback must be gone');
  assert.ok(!/\|\|\s*512/.test(source), 'the fabricated 512 default must be gone');
});

test('WP-10: the orchestrator meters what the enrichment reported', async () => {
  DurableStore.resetForTests();
  UsageMeteringService.record({ tenantId: TENANT, source: 'ai-transform', tokens: 5, correlationId: 'seed_wp10' });
  const baseline = UsageMeteringService.daily(TENANT).tokens;

  const originalEvent = AppwriteService.recordTelemetryEvent;
  const originalTransformRecord = AppwriteService.recordTransformation;
  const originalTransform = GeminiService.transformTelemetry;
  AppwriteService.recordTelemetryEvent = async () => ({ documentId: 'doc_wp10', deduplicated: false });
  AppwriteService.recordTransformation = async () => undefined;
  GeminiService.transformTelemetry = async () => ({
    output: { status: 'success', confidenceScore: 0.9, nicheSpecificResult: { propertyId: 'p' }, recommendedActions: [], anomaliesDetected: [], complianceVerified: true },
    tokensUsed: 77, durationMs: 5, model: 'stub-model', attempts: 1, circuitBreakerState: 'CLOSED',
  });

  try {
    const result = await PipelineOrchestrator.execute({
      tenantId: TENANT, niche: 'real_estate', eventType: 'PROPERTY_VALUATION_REQUEST',
      metadata: { idempotencyKey: 'idem_wp10_1' }, payload: { propertyId: 'p', valuation: 100 },
    });
    assert.equal(result.status, 'success');
    assert.equal(UsageMeteringService.daily(TENANT).tokens, baseline + 77, 'the enrichment\'s real token count must be metered, not a constant');
    const latest = UsageMeteringService.list(TENANT)[0];
    assert.equal(latest.source, 'ai-transform');
    assert.equal(latest.model, 'stub-model');
  } finally {
    AppwriteService.recordTelemetryEvent = originalEvent;
    AppwriteService.recordTransformation = originalTransformRecord;
    GeminiService.transformTelemetry = originalTransform;
  }
});

test('WP-10: GET /api/usage answers for the caller only', async () => {
  const { apiRouter } = await import('../src/api');
  const { resetRateLimiterForTests } = await import('../src/api/middleware/rateLimiter');
  const TENANT_KEY = (await TenantService.provisionCredential(TENANT)).apiKey;

  const app: Express = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    resetRateLimiterForTests();
    const response = await fetch(`http://127.0.0.1:${port}/api/usage`, { headers: { 'x-api-key': TENANT_KEY, 'x-tenant-id': TENANT } });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { tenantId: string; today: { tokens: number } };
    assert.equal(body.tenantId, TENANT);
    assert.equal(body.today.tokens, UsageMeteringService.daily(TENANT).tokens, 'the route must report the caller\'s metered total');
    assert.ok(body.today.tokens < 900, 'the caller must never see another tenant\'s usage');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
