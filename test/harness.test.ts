import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { ApprovalPolicyService } from '../src/services/approvalPolicyService';
import { ContextIndexService, seedBuiltInContexts } from '../src/services/contextIndexService';
import { DurableStore } from '../src/services/durableStore';
import { FactoryJobService } from '../src/services/factoryJobService';
import { detectVerificationProfile } from '../src/services/verificationProfileService';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-harness-'));
const repo = path.join(workspace, 'repo');
fs.mkdirSync(path.join(repo, 'dist'), { recursive: true });
execFileSync('git', ['init', '-q', repo]);
execFileSync('git', ['-C', repo, 'config', 'user.email', 'harness@test.local']);
execFileSync('git', ['-C', repo, 'config', 'user.name', 'Harness Test']);
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { verify: 'node check.js' } }));
fs.writeFileSync(path.join(repo, 'check.js'), "process.exit(require('fs').readFileSync('READY','utf8').trim() === 'yes' ? 0 : 1)");
fs.writeFileSync(path.join(repo, 'READY'), 'no');
fs.writeFileSync(path.join(repo, 'dist', 'index.html'), '<!doctype html><title>harness</title>');
execFileSync('git', ['-C', repo, 'add', '.']);
execFileSync('git', ['-C', repo, 'commit', '-qm', 'initial']);
process.env.FACTORY_WORKSPACE_ROOT = workspace;
process.env.FACTORY_DATA_DIR = path.join(workspace, 'data');

test('verification profiles detect the repository contract', () => {
  assert.equal(detectVerificationProfile(repo).id, 'node-npm');
  assert.equal(detectVerificationProfile(repo).steps[0].label, 'npm run verify');
});

test('bounded repair loop classifies failure and stops after a passing repair', () => {
  DurableStore.resetForTests();
  const job = FactoryJobService.create({ tenantId: 'tenant_re_8841', title: 'Harness repair', problem: 'A failed check needs bounded repair', desiredOutcome: 'Verified product', acceptanceCriteria: ['repair evidence'] });
  let current = FactoryJobService.createProductBrief(job.tenantId, job.id, { audience: 'Founder', valueHypothesis: 'Reduce failed releases', wedge: 'Bounded repair' });
  current = FactoryJobService.createImplementationPlan(job.tenantId, current.id);
  current = FactoryJobService.prepareRepository(job.tenantId, current.id, { repositoryPath: repo });
  current = FactoryJobService.verifyRepository(job.tenantId, current.id);
  assert.equal(current.verificationRun?.passed, false);
  assert.equal(current.verificationRun?.failureClass, 'UNKNOWN');
  current = FactoryJobService.runRepairLoop(job.tenantId, current.id, { maxAttempts: 2, repairs: [{ files: [{ path: 'READY', content: 'yes' }] }] });
  assert.equal(current.repairLoop?.passed, true);
  assert.equal(current.repairLoop?.attempts.length, 1);
  assert.equal(current.verificationRun?.passed, true);
});

test('approval policy blocks delivery until a founder decision is durable', () => {
  DurableStore.resetForTests();
  const job = FactoryJobService.create({ tenantId: 'tenant_re_8841', title: 'Approval gate', problem: 'Delivery must be explicit', desiredOutcome: 'Approved release', acceptanceCriteria: [] });
  let current = FactoryJobService.createProductBrief(job.tenantId, job.id, { audience: 'Founder', valueHypothesis: 'Prevent accidental release', wedge: 'Approval gate' });
  current = FactoryJobService.createImplementationPlan(job.tenantId, current.id);
  current = FactoryJobService.transition(job.tenantId, current.id, 'IMPLEMENTING');
  current = FactoryJobService.transition(job.tenantId, current.id, 'VALIDATING');
  assert.throws(() => FactoryJobService.transition(job.tenantId, current.id, 'DELIVERED'), /APPROVAL_REQUIRED/);
  const request = ApprovalPolicyService.request({ tenantId: job.tenantId, jobId: job.id, action: 'DEPLOY_PRODUCTION', rationale: 'Founder reviewed verified preview' });
  ApprovalPolicyService.decide(job.tenantId, request.id, 'APPROVED', 'Approved for founder release');
  FactoryJobService.addEvidence(job.tenantId, job.id, { kind: 'verification', description: 'Founder reviewed the release evidence' });
  assert.equal(FactoryJobService.transition(job.tenantId, job.id, 'DELIVERED').status, 'DELIVERED');
});

test('context refresh records a new source commit and promotes institutional DNA', () => {
  DurableStore.resetForTests();
  seedBuiltInContexts();
  const refreshed = ContextIndexService.refreshRepository('Forge.ai', repo);
  assert.equal(refreshed.repository, 'Forge.ai');
  const promoted = ContextIndexService.promotePattern('Forge.ai', 'harness-aware product intake', 'brief-to-repository adapter');
  assert.ok(promoted.patterns.includes('harness-aware product intake'));
});
