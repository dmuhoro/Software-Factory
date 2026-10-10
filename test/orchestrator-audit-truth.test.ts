/**
 * WP-3c: the persisted audit trail reports the enrichment's real resilience context.
 *
 * `TransformationAuditTrail` carries `retryAttempts` and `circuitBreakerStatus`, and the
 * orchestrator filled them with the constants `0` and `'CLOSED'`. So every transformation in
 * the ledger claimed "no retries, breaker healthy" whether or not that was true -- including
 * a request that had just been retried three times through a half-open breaker. The fields
 * looked measured and were not.
 *
 * This test drives the real orchestrator with a stubbed enrichment that reports a retried,
 * half-open context, and asserts the persisted record carries those values rather than a
 * constant. Reverting the orchestrator to the constant makes it fail.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-audit-truth-'));
process.env.NODE_ENV = 'test';
process.env.FACTORY_DATA_DIR = DATA_DIR;
process.env.FACTORY_WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-audit-ws-'));
delete process.env.ALLOW_INSECURE_LOCAL;

const { PipelineOrchestrator } = await import('../src/services/pipelineOrchestrator');
const { AppwriteService } = await import('../src/services/appwriteService');
const { GeminiService } = await import('../src/services/geminiService');
const { TenantService } = await import('../src/services/tenantService');
const { IndustryNiche, TenantStatus, TenantSubscriptionTier } = await import('../src/models/tenant');

const TENANT = 'tenant_audit_truth';

test('the persisted audit trail carries the enrichment parser values, not constants', async () => {
  TenantService.registerTenant({
    id: TENANT,
    name: 'Audit truth tenant',
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

  const originalRecordTelemetryEvent = AppwriteService.recordTelemetryEvent;
  const originalRecordTransformation = AppwriteService.recordTransformation;
  const originalTransform = GeminiService.transformTelemetry;

  let captured: any;
  AppwriteService.recordTelemetryEvent = async () => ({ documentId: 'doc_wp3c', deduplicated: false });
  AppwriteService.recordTransformation = async (record) => { captured = record; };
  GeminiService.transformTelemetry = async () => ({
    output: {
      status: 'success',
      confidenceScore: 0.9,
      nicheSpecificResult: { propertyId: 'prop_wp3c' },
      recommendedActions: [],
      anomaliesDetected: [],
      complianceVerified: true,
    },
    tokensUsed: 10,
    durationMs: 5,
    model: 'stub-model',
    attempts: 3,
    circuitBreakerState: 'HALF_OPEN',
  });

  try {
    const result = await PipelineOrchestrator.execute({
      tenantId: TENANT,
      niche: 'real_estate',
      eventType: 'PROPERTY_VALUATION_REQUEST',
      metadata: { idempotencyKey: 'idem_audit_1' },
      payload: { propertyId: 'prop_wp3c', valuation: 100 },
    });

    assert.equal(result.status, 'success');
    assert.ok(captured, 'a transformation record must be persisted');
    assert.equal(captured.auditTrail.retryAttempts, 3, 'the real retry count must be recorded, not 0');
    assert.equal(captured.auditTrail.circuitBreakerStatus, 'HALF_OPEN', 'the real breaker state must be recorded, not a constant');
  } finally {
    AppwriteService.recordTelemetryEvent = originalRecordTelemetryEvent;
    AppwriteService.recordTransformation = originalRecordTransformation;
    GeminiService.transformTelemetry = originalTransform;
  }
});
