/**
 * WP-5 (as renumbered by operator directive): operator cap & audit controls.
 *
 * Tenant caps were tier-derived in code and quota-derived at registration; nobody could change
 * them at runtime, and every change would have been silent. This exercises the operator handle:
 *
 *  - overrides are tighten-only (a value above the tier/quota base is refused, an empty or
 *    malformed one is refused), and the guarantee does NOT rest on the refusal alone — a bogus
 *    override placed straight into the ledger can only shrink a cap, never grow it;
 *  - a written cap is durable (survives a store reload), attributable (updatedBy/revision), and
 *    takes effect on the real paths: the concurrency cap that admits runs and the allowance the
 *    daily AI-token budget is enforced against;
 *  - the operator route refuses anyone but a platform operator, and a successful change both
 *    persists and writes an audit event to the durable trail.
 *
 * Failing-first: an override that never reached `TenantQueueService.limitFor`/`budgetState`
 * fails the "takes effect on the real paths" arms; a route guard that checked the body instead
 * of the principal fails the tenant-credential 403 arm; removal of the `writeAudit` call fails
 * the audit-trail arm.
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

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-wp5-caps-'));
process.env.NODE_ENV = 'test';
process.env.FACTORY_DATA_DIR = DATA_DIR;
process.env.FACTORY_API_KEY = 'sf-platform-k-test-wp5-do-not-reuse';
delete process.env.ALLOW_INSECURE_LOCAL;
delete process.env.FACTORY_TENANT_SEED_DEMO;
delete process.env.GEMINI_API_KEY;
delete process.env.FACTORY_TENANT_CONCURRENCY;

const { DurableStore } = await import('../src/services/durableStore');
const { OperatorCapService } = await import('../src/services/operatorCapService');
const { TenantQueueService } = await import('../src/services/tenantQueueService');
const { UsageMeteringService } = await import('../src/services/usageMeteringService');
const { TenantService } = await import('../src/services/tenantService');
const { classifyApiError } = await import('../src/utils/apiError');
const { IndustryNiche, TenantStatus, TenantSubscriptionTier } = await import('../src/models/tenant');

DurableStore.resetForTests();

/** A registered tenant with a measurable allowance; tier concurrency base is 2 (professional). */
function register(id: string, niche: Niche, maxDailyAiTokens: number): void {
  TenantService.registerTenant({
    id, name: id, niche, tier: TenantSubscriptionTier.PROFESSIONAL, status: TenantStatus.ACTIVE, apiKeyHash: '',
    quota: { maxRequestsPerMinute: 100_000, maxDailyAiTokens, burstCapacity: 10_000, storageLimitMb: 100 },
    customGuardrails: [], encryptionKeyId: 'test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
}

const CEILING = { concurrency: 2, dailyAiTokens: 1000 };

test.after(async () => {
  OperatorCapService.resetForTests();
  DurableStore.resetForTests();
});

test('WP-5: an override can only tighten, and an empty or malformed one is refused', () => {
  register('wp5-refuse', IndustryNiche.REAL_ESTATE, 1000);

  assert.throws(
    () => OperatorCapService.set({ tenantId: 'wp5-refuse', actor: 'op', ceiling: CEILING, concurrency: 5 }),
    /OPERATOR_CAP_NOT_TIGHTENING/,
    'a concurrency above the tier base must be refused',
  );
  assert.throws(
    () => OperatorCapService.set({ tenantId: 'wp5-refuse', actor: 'op', ceiling: CEILING, dailyAiTokens: 2000 }),
    /OPERATOR_CAP_NOT_TIGHTENING/,
    'a daily allowance above the quota must be refused',
  );
  assert.throws(
    () => OperatorCapService.set({ tenantId: 'wp5-refuse', actor: 'op', ceiling: CEILING }),
    /OPERATOR_CAP_INVALID/,
    'an override that tightens nothing is a mistake, not a request',
  );
  assert.throws(
    () => OperatorCapService.set({ tenantId: 'wp5-refuse', actor: 'op', ceiling: CEILING, concurrency: -1 }),
    /OPERATOR_CAP_INVALID/,
    'a negative cap is refused, not clamped',
  );
  // Fail closed against an unmeasurable base: a daily-token override has no quota to be measured
  // against, so it is refused rather than honoured as a suspicion.
  assert.throws(
    () => OperatorCapService.set({ tenantId: 'wp5-refuse', actor: 'op', ceiling: { concurrency: 2, dailyAiTokens: null }, dailyAiTokens: 100 }),
    /OPERATOR_CAP_NOT_TIGHTENING/,
    'an override against an unmeasurable allowance must be refused, not honoured',
  );
});

test('WP-5: a written cap is durable, attributable, and takes effect on the real paths', () => {
  register('wp5-effective', IndustryNiche.LOGISTICS, 1000);
  assert.equal(TenantQueueService.limitFor('wp5-effective'), 2, 'professional base is 2 concurrent runs');

  const cap = OperatorCapService.set({ tenantId: 'wp5-effective', actor: 'op-9', ceiling: CEILING, concurrency: 1, dailyAiTokens: 300 });
  assert.equal(cap.revision, 1);
  assert.equal(cap.updatedBy, 'op-9');

  assert.equal(TenantQueueService.limitFor('wp5-effective'), 1, 'the cap must bind the concurrency boundary');
  const budget = UsageMeteringService.budgetState('wp5-effective');
  assert.equal(budget.budget, 300, 'the cap must bind the allowance the budget is enforced against');
  assert.equal(budget.exhausted, false);

  // Durability: a store reload must rediscover the override, because it lives in the ledger, not
  // in a module variable.
  DurableStore.resetForTests();
  assert.equal(OperatorCapService.get('wp5-effective')?.dailyAiTokens, 300, 'the cap must survive a reload');

  const second = OperatorCapService.set({ tenantId: 'wp5-effective', actor: 'op-9', ceiling: CEILING, dailyAiTokens: 250 });
  assert.equal(second.revision, 2, 'revision bumps on every successful change');

  assert.equal(OperatorCapService.clear('wp5-effective', 'op-9')?.revision, 2, 'clear returns what it removed');
  assert.equal(OperatorCapService.get('wp5-effective'), undefined, 'after clear the override is gone');
  assert.equal(TenantQueueService.limitFor('wp5-effective'), 2, 'clearing restores the tier base, never above it');
  assert.equal(UsageMeteringService.budgetState('wp5-effective').budget, 1000, 'clearing restores the quota allowance');
});

test('WP-5: even a bogus override in the ledger can never raise a cap', () => {
  register('wp5-rogue', IndustryNiche.REAL_ESTATE, 1000);
  // Simulate a stale or rogue record that bypassed validation entirely.
  DurableStore.upsert('operatorCaps', 'wp5-rogue', {
    tenantId: 'wp5-rogue', concurrency: 999, dailyAiTokens: 999_999, updatedAt: new Date().toISOString(), updatedBy: '??', revision: 1,
  });
  try {
    assert.equal(TenantQueueService.limitFor('wp5-rogue'), 2, 'a hostile concurrency value must clamp to the tier base, never exceed it');
    const budget = UsageMeteringService.budgetState('wp5-rogue');
    assert.equal(budget.budget, 1000, 'a hostile allowance must clamp to the quota, never exceed it');
    assert.equal(budget.exhausted, false, 'the consumed meter is still the source of truth for spend');
  } finally {
    OperatorCapService.resetForTests();
  }
});

test('WP-5: only a platform operator may change caps', async () => {
  register('wp5-denied', IndustryNiche.REAL_ESTATE, 1000);
  const { apiRouter } = await import('../src/api');
  const { resetRateLimiterForTests } = await import('../src/api/middleware/rateLimiter');
  const tenantKey = (await TenantService.provisionCredential('wp5-denied')).apiKey;

  const app: Express = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    resetRateLimiterForTests();
    const response = await fetch(`http://127.0.0.1:${port}/api/operator/tenants/wp5-denied/caps`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': tenantKey, 'x-tenant-id': 'wp5-denied' },
      body: JSON.stringify({ concurrency: 1 }),
    });
    const body = (await response.json()) as { status: string; code: string };
    assert.equal(response.status, 403, `a tenant credential must not change operational caps (got ${response.status})`);
    assert.equal(body.code, 'OPERATOR_ROLE_REQUIRED');
    assert.equal(OperatorCapService.get('wp5-denied'), undefined, 'the refused change must not have been applied');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('WP-5: the operator route writes the cap and an audit event, and DELETE restores the base', async () => {
  register('wp5-http', IndustryNiche.REAL_ESTATE, 1000);
  const { apiRouter } = await import('../src/api');
  const { resetRateLimiterForTests } = await import('../src/api/middleware/rateLimiter');
  const platformKey = process.env.FACTORY_API_KEY as string;

  const app: Express = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const headers = { 'content-type': 'application/json', 'x-api-key': platformKey, 'x-tenant-id': 'wp5-http' };
  try {
    resetRateLimiterForTests();

    const setResponse = await fetch(`http://127.0.0.1:${port}/api/operator/tenants/wp5-http/caps`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ concurrency: 1, dailyAiTokens: 400 }),
    });
    const setBody = (await setResponse.json()) as { status: string; concurrency: number; dailyAiTokens: number; override: { concurrency: number } | null };
    assert.equal(setResponse.status, 200, JSON.stringify(setBody));
    assert.equal(setBody.status, 'success');
    assert.equal(setBody.concurrency, 1);
    assert.equal(setBody.dailyAiTokens, 400);

    const auditKind = 'tenant.cap.change';
    const setAudits = DurableStore.audits('wp5-http');
    assert.ok(
      setAudits.some((event) => event.kind === auditKind && event.action === 'set' && event.actor === 'platform'),
      'a successful cap change must leave a durable, attributable audit event',
    );
    assert.equal(TenantQueueService.limitFor('wp5-http'), 1, 'the live concurrency boundary must honour the route-written cap');

    const deleteResponse = await fetch(`http://127.0.0.1:${port}/api/operator/tenants/wp5-http/caps`, { method: 'DELETE', headers });
    const deleteBody = (await deleteResponse.json()) as { status: string; concurrency: number; dailyAiTokens: number; override: unknown };
    assert.equal(deleteResponse.status, 200, JSON.stringify(deleteBody));
    assert.equal(deleteBody.concurrency, 2, 'deleting the override restores the tier base');
    assert.equal(deleteBody.dailyAiTokens, 1000, 'deleting the override restores the quota allowance');
    assert.equal(deleteBody.override, null);
    assert.ok(
      DurableStore.audits('wp5-http').some((event) => event.kind === auditKind && event.action === 'clear'),
      'the clear must also be audited',
    );

    const getResponse = await fetch(`http://127.0.0.1:${port}/api/operator/tenants/wp5-http/caps`, { headers });
    const getBody = (await getResponse.json()) as { status: string; override: unknown };
    assert.equal(getResponse.status, 200);
    assert.equal(getBody.status, 'success');
    assert.equal(getBody.override, null);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    OperatorCapService.resetForTests();
  }
});

// The refusal arms prove the contract resolves, not just that the texts exist.
test('WP-5: the cap codes classify to publishable domain conditions', () => {
  assert.equal(classifyApiError(new Error('OPERATOR_ROLE_REQUIRED:')).status, 403);
  assert.equal(classifyApiError(new Error('OPERATOR_CAP_INVALID:concurrency=0')).status, 400);
  assert.equal(classifyApiError(new Error('OPERATOR_CAP_NOT_TIGHTENING:concurrency=99,base=2')).status, 409);
});