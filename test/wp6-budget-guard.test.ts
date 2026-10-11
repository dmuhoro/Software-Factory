/**
 * WP-6 (as renumbered by operator directive): the daily AI-token budget is enforced at the
 * spend boundary, not measured-and-ignored.
 *
 * WP-10 part 1 built the meter and explicitly deferred enforcement. This puts the enforcement
 * on trial against the real pipeline:
 *
 *  - a tenant under its allowance runs a cycle and is metered for what the enrichment reported;
 *  - a tenant that has spent its daily allowance is refused BEFORE the model is called, with a
 *    429 that a client can obey (Retry-After reaches the next UTC day), and the refused cycle
 *    records no metered spend and writes no transformation record;
 *  - the state reader fails closed: a principal with no measurable allowance is reported as
 *    exhausted (`reason: 'unknown'`/`'unset'`), never as "unlimited".
 *
 * Failing-first: deleting the `budgetState` guard in `PipelineOrchestrator.execute` makes the
 * spent tenant's cycle reach the enrichment stub, so the "never called" assertion fails; a
 * `budgetState` that reports `exhausted: false` for a spent tenant fails the retaliation arm.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import type { Express } from 'express';
import type { IndustryNiche as Niche } from '../src/models/tenant';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-wp6-budget-'));
process.env.NODE_ENV = 'test';
process.env.FACTORY_DATA_DIR = DATA_DIR;
delete process.env.ALLOW_INSECURE_LOCAL;
delete process.env.FACTORY_TENANT_SEED_DEMO;
delete process.env.GEMINI_API_KEY;

const { DurableStore } = await import('../src/services/durableStore');
const { UsageMeteringService } = await import('../src/services/usageMeteringService');
const { GeminiService } = await import('../src/services/geminiService');
const { PipelineOrchestrator } = await import('../src/services/pipelineOrchestrator');
const { AppwriteService } = await import('../src/services/appwriteService');
const { TenantService } = await import('../src/services/tenantService');
const { classifyApiError } = await import('../src/utils/apiError');
const { IndustryNiche, TenantStatus, TenantSubscriptionTier } = await import('../src/models/tenant');

DurableStore.resetForTests();

/** A tenant with a real, whole, positive daily allowance. */
function register(id: string, niche: Niche, maxDailyAiTokens: number): void {
  TenantService.registerTenant({
    id, name: id, niche, tier: TenantSubscriptionTier.PROFESSIONAL, status: TenantStatus.ACTIVE, apiKeyHash: '',
    quota: { maxRequestsPerMinute: 100_000, maxDailyAiTokens, burstCapacity: 10_000, storageLimitMb: 100 },
    customGuardrails: [], encryptionKeyId: 'test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
}

const PAYLOAD = (tenantId: string) => ({
  tenantId, niche: 'real_estate', eventType: 'PROPERTY_VALUATION_REQUEST',
  metadata: { idempotencyKey: `idem_${tenantId}` }, payload: { propertyId: 'p', valuation: 100 },
});

type TransformResult = Awaited<ReturnType<typeof GeminiService['transformTelemetry']>>;
const ENRICHED_OUTPUT: TransformResult = {
  output: {
    status: 'success', confidenceScore: 0.9,
    nicheSpecificResult: { propertyId: 'p' }, recommendedActions: [], anomaliesDetected: [],
    complianceVerified: true,
  },
  tokensUsed: 77, durationMs: 5, model: 'stub-model', attempts: 1, circuitBreakerState: 'CLOSED',
};

test('WP-6: a tenant under its allowance runs a cycle and is metered for what it spent', async () => {
  register('wp6-fresh', IndustryNiche.REAL_ESTATE, 1000);
  const originalTransform = GeminiService.transformTelemetry;
  let called = false;
  GeminiService.transformTelemetry = async () => { called = true; return ENRICHED_OUTPUT; };
  try {
    const result = await PipelineOrchestrator.execute(PAYLOAD('wp6-fresh'));
    assert.equal(result.status, 'success');
    assert.equal(called, true, 'a tenant with allowance remaining must be allowed to spend');
    assert.equal(UsageMeteringService.daily('wp6-fresh').tokens, 77, 'the spent tokens must be metered');
    assert.equal(UsageMeteringService.budgetState('wp6-fresh').exhausted, false, '77 of 1000 leaves allowance remaining');
  } finally {
    GeminiService.transformTelemetry = originalTransform;
  }
});

test('WP-6: once the allowance is spent, a cycle is refused BEFORE the model is called', async () => {
  register('wp6-spent', IndustryNiche.REAL_ESTATE, 100);
  UsageMeteringService.record({ tenantId: 'wp6-spent', source: 'ai-transform', tokens: 100 });

  const originalTransform = GeminiService.transformTelemetry;
  let enrichmentCalled = false;
  GeminiService.transformTelemetry = async () => { enrichmentCalled = true; return ENRICHED_OUTPUT; };

  let recordedTransformation: unknown;
  const originalTransformRecord = AppwriteService.recordTransformation;
  AppwriteService.recordTransformation = async (record) => { recordedTransformation = record; };

  try {
    let thrown: unknown;
    try {
      await PipelineOrchestrator.execute(PAYLOAD('wp6-spent'));
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown, 'a tenant at its allowance must be refused, not run');
    const classified = classifyApiError(thrown);
    assert.equal(classified.code, 'AI_BUDGET_EXCEEDED');
    assert.equal(classified.status, 429, 'an exhausted allowance is a client-retryable 429, not a server fault');
    assert.ok(classified.retryAfterSeconds && classified.retryAfterSeconds >= 1 && classified.retryAfterSeconds <= 86400,
      'the retry window must reach the next UTC day');

    assert.equal(enrichmentCalled, false, 'the model must never be called once the allowance is spent');
    assert.equal(recordedTransformation, undefined, 'a refused cycle must not write a transformation record');
    assert.equal(UsageMeteringService.daily('wp6-spent').tokens, 100, 'a refused cycle must not add metered spend');
    assert.equal(UsageMeteringService.budgetState('wp6-spent').reason, 'spent');
  } finally {
    GeminiService.transformTelemetry = originalTransform;
    AppwriteService.recordTransformation = originalTransformRecord;
  }
});

test('WP-6: a tenant at exactly the allowance is spent too', async () => {
  register('wp6-exact', IndustryNiche.LOGISTICS, 50);
  UsageMeteringService.record({ tenantId: 'wp6-exact', source: 'ai-transform', tokens: 50 });
  assert.equal(UsageMeteringService.budgetState('wp6-exact').exhausted, true, 'consumed == allowance is exhausted');
  assert.equal(UsageMeteringService.budgetState('wp6-exact').reason, 'spent');
});

test('WP-6: a principal with no measurable allowance fails closed as unknown, never unlimited', () => {
  assert.equal(TenantService.getTenant('wp6-ghost'), undefined, 'the arm only means something for a tenant the registry does not know');
  const ghost = UsageMeteringService.budgetState('wp6-ghost');
  assert.equal(ghost.exhausted, true);
  assert.equal(ghost.reason, 'unknown');
  assert.equal(ghost.budget, null);
});

test('WP-6: the live ingest route answers a spent tenant with 429 and Retry-After', async () => {
  register('wp6-http', IndustryNiche.REAL_ESTATE, 100);
  UsageMeteringService.record({ tenantId: 'wp6-http', source: 'ai-transform', tokens: 100 });

  const { apiRouter } = await import('../src/api');
  const { resetRateLimiterForTests } = await import('../src/api/middleware/rateLimiter');
  const key = (await TenantService.provisionCredential('wp6-http')).apiKey;

  const app: Express = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    resetRateLimiterForTests();
    const originalTransform = GeminiService.transformTelemetry;
    let enrichmentCalled = false;
    GeminiService.transformTelemetry = async () => { enrichmentCalled = true; return ENRICHED_OUTPUT; };
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/telemetry/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'x-tenant-id': 'wp6-http' },
        body: JSON.stringify(PAYLOAD('wp6-http')),
      });
      const body = (await response.json()) as { status: string; code: string };
      assert.equal(response.status, 429, `a spent tenant must be refused at the wire with 429 (got ${response.status}: ${JSON.stringify(body)})`);
      assert.equal(body.code, 'AI_BUDGET_EXCEEDED');
      assert.ok(response.headers.get('retry-after'), 'the route must set a Retry-After the client can obey');
      assert.equal(enrichmentCalled, false, 'the enforcement must also hold on the live ingest path');
    } finally {
      GeminiService.transformTelemetry = originalTransform;
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});