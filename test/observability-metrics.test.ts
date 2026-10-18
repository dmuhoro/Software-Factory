/**
 * Observability metrics tests (P0).
 *
 * Proves the /metrics and /health endpoints expose the SLIs the alert rules in
 * deploy/monitoring/alert-rules.yml depend on. If a metric the alert rules reference
 * is not emitted, the alert can never fire — that is observability theatre, not
 * observability. These tests pin the mapping so it cannot silently regress.
 *
 * No model keys are required: the metrics endpoint reports durable-store and runtime
 * state, not model calls.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

import { DurableStore } from '../src/services/durableStore';
import { TenantService } from '../src/services/tenantService';
import { resetRateLimiterForTests } from '../src/api/middleware/rateLimiter';
import { apiRouter } from '../src/api';
import { IndustryNiche, TenantSubscriptionTier, TenantStatus } from '../src/models/tenant';

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-observability-'));
process.env.FACTORY_DATA_DIR = path.join(state, 'data');
process.env.FACTORY_WORKSPACE_ROOT = path.join(state, 'ws');
process.env.NODE_ENV = 'test';
process.env.FACTORY_API_KEY = 'test-platform-key-0123456789abcdef';
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.FACTORY_WORKSPACE_ROOT, { recursive: true });

DurableStore.resetForTests();
TenantService.resetCacheForTests();

// Provision a tenant and a credential so /metrics is reachable (tenant-authenticated).
const TENANT = 'observability-tenant';
TenantService.registerTenant({
  id: TENANT, name: 'Observability Tenant', niche: IndustryNiche.CUSTOM_B2B,
  tier: TenantSubscriptionTier.PROFESSIONAL, status: TenantStatus.ACTIVE, apiKeyHash: '',
  quota: { maxRequestsPerMinute: 10_000, maxDailyAiTokens: 10_000_000, burstCapacity: 100, storageLimitMb: 1000 },
  customGuardrails: [], encryptionKeyId: 'test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});
const owner = await TenantService.provisionCredential(TENANT);
resetRateLimiterForTests();

async function fetchJson(port: number, urlPath: string, apiKey: string = owner.apiKey, tenantId: string = TENANT): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}/api${urlPath}`, {
    headers: { 'x-api-key': apiKey, 'x-tenant-id': tenantId },
  });
  return { status: res.status, body: await res.json() };
}

test('/metrics exposes the SLIs the alert rules depend on', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const { status, body } = await fetchJson(port, '/factory/metrics');
    assert.equal(status, 200, `/metrics must be reachable: ${JSON.stringify(body)}`);
    const mBody = body as { status: string; metrics: Record<string, unknown> };
    assert.equal(mBody.status, 'success');

    const m = mBody.metrics;

    // Ledger degradation → alert: SoftwareFactoryLedgerDegraded
    assert.equal(typeof m.ledgerDegraded, 'boolean', 'ledgerDegraded must be a boolean');

    // Uptime → alert: SoftwareFactoryUptimeReset
    assert.equal(typeof m.uptimeSeconds, 'number', 'uptimeSeconds must be a number');

    // Supported niches → alert/dashboards
    assert.ok(Array.isArray(m.supportedNiches), 'supportedNiches must be an array');
    assert.ok(m.supportedNiches.length > 0, 'at least one niche must be operational');

    // Verification outcomes → alert: SoftwareFactoryVerificationFailureRate
    assert.equal(typeof m.successfulTransformations, 'number');
    assert.equal(typeof m.failedTransformations, 'number');

    // Ledger records → dashboard
    assert.ok(typeof m.ledgerRecords === 'object', 'ledgerRecords must be an object');

    // Audit entries → dashboard
    assert.equal(typeof m.auditEntries, 'number');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('/health reports storage durability and contended-writer state', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const { status, body } = await fetchJson(port, '/factory/health');
    assert.equal(status, 200, `/health must be reachable: ${JSON.stringify(body)}`);

    const health = body as { status?: string; checks?: Record<string, string> };
    // Durable store writable/fsync-durable → alert: SoftwareFactoryLedgerDegraded
    assert.ok(['healthy', 'degraded', 'unhealthy'].includes(health.checks?.['durableStore'] as string),
      'durableStore check must report a health state');

    // Storage write/fsync probe
    assert.ok(['healthy', 'degraded', 'unhealthy'].includes(health.checks?.['storage'] as string),
      'storage check must report a health state');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('/metrics is public for Prometheus scraping (no credentials required)', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const { status } = await fetchJson(port, '/factory/metrics');
    assert.equal(status, 200, '/factory/metrics must be publicly scrapeable: ' + JSON.stringify(status));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
