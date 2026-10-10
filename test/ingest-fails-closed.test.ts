/**
 * WP-3: the ingest path fails closed when the ledger refuses the write.
 *
 * Every persistence test in this repo proved the happy path: a write lands, a replay is
 * deduplicated, the ledger survives a restart. None proved the failure path -- that when the
 * raw write throws, the caller is refused and is NOT told the record was stored.
 *
 * That gap matters because a raw-write failure used to fall through
 * `classifyDependencyFailure`'s default branch, which answers "the telemetry record was
 * accepted but structured enrichment failed" while setting `rawPayloadPersisted: false`.
 * The message asserted acceptance the flag denied. A caller reading the message would not
 * retry a record that was, in fact, lost.
 *
 * This test drives the real router with a real provisioned tenant and injects a failing
 * store. It asserts the response is a non-2xx `LEDGER_UNAVAILABLE` that makes no claim of
 * acceptance, and that a healthy ledger is not reported as this error.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import type { Express } from 'express';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-ingest-fail-'));
process.env.NODE_ENV = 'test';
process.env.FACTORY_DATA_DIR = DATA_DIR;
process.env.FACTORY_WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-ingest-ws-'));
delete process.env.ALLOW_INSECURE_LOCAL;

const TENANT = 'tenant_ingest_fail_closed';
const NICHE = 'real_estate';

const { apiRouter } = await import('../src/api');
const { TenantService } = await import('../src/services/tenantService');
const { AppwriteService } = await import('../src/services/appwriteService');
const { IndustryNiche, TenantStatus, TenantSubscriptionTier } = await import('../src/models/tenant');

async function listen(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function appWithRouter(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  return app;
}

let apiKey = '';

test('setup: a provisioned, active tenant', async () => {
  TenantService.registerTenant({
    id: TENANT,
    name: 'Ingest fail-closed tenant',
    niche: IndustryNiche.REAL_ESTATE,
    tier: TenantSubscriptionTier.PROFESSIONAL,
    status: TenantStatus.ACTIVE,
    apiKeyHash: '',
    quota: { maxRequestsPerMinute: 60, maxDailyAiTokens: 1000, burstCapacity: 10, storageLimitMb: 10 },
    customGuardrails: [],
    encryptionKeyId: 'test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const provisioned = await TenantService.provisionCredential(TENANT);
  apiKey = provisioned.apiKey;
  assert.ok(apiKey.length > 0);
});

function payload(idempotencyKey: string): Record<string, unknown> {
  return {
    tenantId: TENANT,
    niche: NICHE,
    eventType: 'PROPERTY_VALUATION_REQUEST',
    metadata: { sourceSystem: 'wp3-test', region: 'eu-west', idempotencyKey },
    payload: { propertyId: 'prop_wp3', valuation: 123456 },
  };
}

function post(url: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      `${url}/api/telemetry/ingest`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length,
          'x-api-key': apiKey,
          'x-tenant-id': TENANT,
          'x-industry-niche': NICHE,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: any = text;
          try { parsed = JSON.parse(text); } catch { /* leave as text */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('a raw-persistence failure is refused (LEDGER_UNAVAILABLE) and claims no acceptance', async () => {
  const app = appWithRouter();
  const server = await listen(app);
  const original = AppwriteService.recordTelemetryEvent;
  AppwriteService.recordTelemetryEvent = async () => {
    throw new Error('EACCES: simulated ledger unwritable');
  };
  try {
    const res = await post(server.url, payload('idem_fail_closed_1'));
    assert.notEqual(res.status, 200, 'a failed write must never be answered 2xx');
    assert.ok(res.status >= 500 && res.status < 600, `expected a 5xx refusal, got ${res.status}`);
    assert.equal(res.body.status, 'error');
    assert.equal(res.body.code, 'LEDGER_UNAVAILABLE', 'the failure must be named as a ledger fault');
    assert.equal(res.body.rawPayloadPersisted, false, 'the record was NOT persisted and the flag must say so');
    assert.equal('transformationId' in res.body, false, 'no success artefact may be present');
    assert.doesNotMatch(String(res.body.message), /accepted/i, 'the message must not claim acceptance when nothing was stored');
  } finally {
    AppwriteService.recordTelemetryEvent = original;
    await server.close();
  }
});

test('a healthy ledger is not reported as a ledger fault (the injected failure is the cause)', async () => {
  const app = appWithRouter();
  const server = await listen(app);
  try {
    const res = await post(server.url, payload('idem_fail_closed_control'));
    assert.notEqual(res.body?.code, 'LEDGER_UNAVAILABLE', 'a healthy ledger write must not be named a ledger fault');
    // The write itself succeeded; any later failure is enrichment, which must declare the
    // raw record durable (rawPayloadPersisted: true). If a model is configured the call is 200.
    if (res.status !== 200) {
      assert.equal(res.body.rawPayloadPersisted, true, 'once the raw write lands, the flag must be true');
    }
  } finally {
    await server.close();
  }
});
