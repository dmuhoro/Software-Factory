import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableStore } from '../src/services/durableStore';
import { FailureService } from '../src/services/failureService';
import { OutcomeService } from '../src/services/outcomeService';
import { AutonomyService } from '../src/services/autonomyService';

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-operations-'));

test('failure records classify next action and escalate after retry budget', () => {
  DurableStore.resetForTests();
  const first = FailureService.record({ tenantId: 'tenant_re_8841', domain: 'DEPLOYMENT', message: 'health check failed', retryBudget: 1 });
  assert.equal(first.nextAction, 'Stop release completion and inspect deployment output');
  assert.equal(FailureService.retry(first.tenantId, first.id).status, 'CONTAINED');
  assert.equal(FailureService.retry(first.tenantId, first.id).status, 'ESCALATED');
  assert.equal(FailureService.resolve(first.tenantId, first.id, 'Rolled back to known-good artifact').status, 'RESOLVED');
});

test('outcome records measure time saved and preserve reusable learning', () => {
  DurableStore.resetForTests();
  OutcomeService.record({ tenantId: 'tenant_re_8841', jobId: 'job-1', productName: 'Founder tool', signal: 'TIME_SAVED', value: 4, unit: 'hours/week', note: 'Reduced release administration', reusablePatterns: ['evidence-first release'], decisionsToAvoid: ['manual release notes'] });
  const summary = OutcomeService.summary('tenant_re_8841');
  assert.equal(summary.timeSaved, 4);
  assert.deepEqual(summary.reusablePatterns, ['evidence-first release']);
});

test('autonomy sessions enforce graduated actions and budgets', () => {
  DurableStore.resetForTests();
  const session = AutonomyService.start({ tenantId: 'tenant_re_8841', level: 'D_VERIFY_REPAIR', maxSteps: 1, maxCostUnits: 2 });
  const consumed = AutonomyService.consume(session.tenantId, session.id, 'RUN_VERIFICATION', 1);
  assert.equal(consumed.stepsUsed, 1);
  assert.throws(() => AutonomyService.consume(session.tenantId, session.id, 'CREATE_PREVIEW'), /AUTONOMY_ACTION_NOT_ALLOWED/);
  assert.throws(() => AutonomyService.consume(session.tenantId, session.id, 'RUN_VERIFICATION', 1), /AUTONOMY_STEP_BUDGET_EXCEEDED/);
});
