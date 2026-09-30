import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AppwriteService } from '../src/services/appwriteService';
import { DurableStore } from '../src/services/durableStore';
import { FactoryJobService } from '../src/services/factoryJobService';
import { IndustryNiche } from '../src/models/tenant';
import { validateIncomingTelemetry } from '../src/utils/validation';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'software-factory-'));
process.env.FACTORY_DATA_DIR = dataDir;
process.env.ALLOW_INSECURE_LOCAL = 'true';

function payload(idempotencyKey: string) {
  return { tenantId: 'tenant_re_8841', niche: IndustryNiche.REAL_ESTATE, eventType: 'PROPERTY_LISTED', timestamp: new Date().toISOString(), payload: { propertyId: 'P-1', listPrice: 100 }, metadata: { sourceSystem: 'test', region: 'local', clientVersion: 'test', idempotencyKey } };
}

test('durable persistence survives store reload and preserves tenant partition', async () => {
  DurableStore.resetForTests();
  const first = await AppwriteService.recordTelemetryEvent(payload('idem-1'));
  const second = await AppwriteService.recordTelemetryEvent(payload('idem-1'));
  assert.equal(first.documentId, second.documentId);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'software-factory.json'), 'utf8')).telemetry[first.documentId].tenantId, 'tenant_re_8841');
  DurableStore.resetForTests();
  assert.equal((await AppwriteService.getAllTransformations()).length, 0);
  assert.equal(DurableStore.list('telemetry').length, 1);
});

test('validation rejects direct PHI and accepts a valid real-estate event', () => {
  assert.equal(validateIncomingTelemetry({ ...payload('phi'), niche: IndustryNiche.HEALTHCARE, payload: { patientCohortId: 'C-1', ssn: '000-12-3456' } }).isValid, false);
  assert.equal(validateIncomingTelemetry(payload('valid')).isValid, true);
});

test('factory jobs enforce ordered delivery transitions and evidence', () => {
  DurableStore.resetForTests();
  const job = FactoryJobService.create({ tenantId: 'tenant_re_8841', title: 'Founder inbox triage', problem: 'Ideas disappear between notes and delivery', desiredOutcome: 'Every idea becomes a validated next action', acceptanceCriteria: ['Creates a durable brief'] });
  assert.equal(FactoryJobService.get('tenant_hc_1042', job.id), undefined);
  assert.throws(() => FactoryJobService.transition(job.tenantId, job.id, 'DELIVERED'), /INVALID_FACTORY_TRANSITION/);
  let updated = FactoryJobService.transition(job.tenantId, job.id, 'SPECIFIED');
  updated = FactoryJobService.transition(job.tenantId, job.id, 'IMPLEMENTING');
  updated = FactoryJobService.addEvidence(job.tenantId, job.id, { kind: 'test', description: 'Verification passed' });
  assert.equal(updated.status, 'IMPLEMENTING');
  assert.equal(updated.evidence.length, 1);
});
