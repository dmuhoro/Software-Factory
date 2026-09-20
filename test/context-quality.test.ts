import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableStore } from '../src/services/durableStore';
import { ContextIndexService, seedBuiltInContexts } from '../src/services/contextIndexService';
import { FactoryJobService } from '../src/services/factoryJobService';

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-context-'));

test('repository contexts are searchable and provide a measurable baseline', () => {
  DurableStore.resetForTests();
  const contexts = seedBuiltInContexts();
  assert.equal(contexts.length, 5);
  assert.ok(ContextIndexService.search('offline privacy device verification').some((context) => context.repository === 'ShrinkMedia'));
  assert.ok(ContextIndexService.search('AST local approval').some((context) => context.repository === 'Hermes-Forge'));
  assert.ok(ContextIndexService.qualityBaseline() > 0);
});

test('implementation plans inherit context patterns and quality gates', () => {
  DurableStore.resetForTests();
  const job = FactoryJobService.create({ tenantId: 'tenant_context', title: 'Offline document workflow', problem: 'Users need private offline document processing', desiredOutcome: 'Verified local document product', acceptanceCriteria: ['offline mode', 'device evidence'] });
  const withBrief = FactoryJobService.createProductBrief(job.tenantId, job.id, { audience: 'Privacy-sensitive operators', valueHypothesis: 'Reduce data exposure', wedge: 'On-device processing' });
  const planned = FactoryJobService.createImplementationPlan(job.tenantId, withBrief.id);
  assert.ok(planned.implementationPlan?.contextRefs.includes('ShrinkMedia'));
  assert.ok(planned.implementationPlan?.inheritedPatterns.some((pattern) => pattern.includes('offline')));
  assert.ok(planned.implementationPlan?.qualityGates.includes('security and tenant-boundary review'));
});

test('launch quality reports improvement against the repository baseline', () => {
  DurableStore.resetForTests();
  const snapshot = ContextIndexService.recordQuality({ tenantId: 'tenant_context', productName: 'Verified Product', score: 95, baselineScore: 60, dimensions: { verification: 25, security: 20, evidence: 20, operability: 15, productDiscipline: 15 }, evidenceKinds: ['test', 'security', 'preview'] });
  assert.equal(snapshot.improvementPercent, 58.3);
  assert.equal(ContextIndexService.qualitySummary('tenant_context').latestScore, 95);
});
