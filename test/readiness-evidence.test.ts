import assert from 'node:assert/strict';
import test from 'node:test';
import { DurableStore } from '../src/services/durableStore';
import { ReadinessEvidenceService } from '../src/services/readinessEvidenceService';

const tenant = `proof-${Date.now()}`;
DurableStore.resetForTests();

test('readiness proof requires observed run and artifact evidence', () => {
  assert.throws(() => ReadinessEvidenceService.record({ tenantId: tenant, level: 'LEVEL_2_CLIENT', criterion: 'three client-like dry runs', status: 'PASSED', artifactRefs: [], measurements: {}, reviewer: 'founder' }), /PASSED_PROOF_REQUIRES_OBSERVATION/);
  const record = ReadinessEvidenceService.record({ tenantId: tenant, level: 'LEVEL_2_CLIENT', criterion: 'isolated client workspace', status: 'PASSED', runId: 'dry-run-1', observedAt: new Date().toISOString(), artifactRefs: ['handover.json'], measurements: { isolation: true }, reviewer: 'founder' }); assert.equal(record.status, 'PASSED'); const summary = ReadinessEvidenceService.summary(tenant, 'LEVEL_2_CLIENT'); assert.equal(summary.readyForDeclaration, false); assert.ok(summary.pending.length > 0); assert.match(ReadinessEvidenceService.evidenceDigest(tenant, 'LEVEL_2_CLIENT'), /^[a-f0-9]{64}$/);
});
