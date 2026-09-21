import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { DurableStore } from '../src/services/durableStore';
import { FactoryJobService } from '../src/services/factoryJobService';
import { WorkspaceService } from '../src/services/workspaceService';
import { ApprovalPolicyService } from '../src/services/approvalPolicyService';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-workspace-lifecycle-'));
const repo = path.join(root, 'product');
fs.mkdirSync(repo, { recursive: true });
execFileSync('git', ['init', '-q', repo]);
execFileSync('git', ['-C', repo, 'config', 'user.email', 'lifecycle@test.local']);
execFileSync('git', ['-C', repo, 'config', 'user.name', 'Lifecycle Test']);
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { verify: 'node -e "process.exit(0)"' } }));
execFileSync('git', ['-C', repo, 'add', '.']);
execFileSync('git', ['-C', repo, 'commit', '-qm', 'initial']);
process.env.FACTORY_WORKSPACE_ROOT = root;
process.env.FACTORY_DATA_DIR = path.join(root, 'data');
process.env.FACTORY_BACKUP_DIR = path.join(root, 'backups');

test('project registry creates a canonical daily workspace record', () => {
  DurableStore.resetForTests();
  const project = WorkspaceService.register({ tenantId: 'tenant_re_8841', name: 'Lifecycle Product', repositoryPath: repo, kind: 'personal', deploymentTarget: 'filesystem-preview' });
  assert.equal(WorkspaceService.select(project.tenantId, 'lifecycle product')?.id, project.id);
  assert.equal(project.verificationProfile, 'node-npm');
  assert.equal(WorkspaceService.inbox(project.tenantId).projects.length, 1);
});

test('backup and restore preserve the durable ledger', () => {
  DurableStore.resetForTests();
  FactoryJobService.create({ tenantId: 'tenant_re_8841', title: 'Backup proof', problem: 'Ledger must survive restore', desiredOutcome: 'Restore succeeds', acceptanceCriteria: [] });
  const backup = WorkspaceService.backup('tenant_re_8841');
  assert.ok(fs.existsSync(backup.file));
  assert.equal(WorkspaceService.restore('tenant_re_8841', backup.id).checksum, backup.checksum);
});

test('continuation report exposes incomplete work and delivery is blocked by pending tasks', () => {
  DurableStore.resetForTests();
  const job = FactoryJobService.create({ tenantId: 'tenant_re_8841', title: 'Incomplete product', problem: 'Started repository has unfinished work', desiredOutcome: 'Finish it', acceptanceCriteria: ['User flow works'] });
  const task = job.completionTasks?.[0];
  assert.ok(task);
  const report = FactoryJobService.continuationReport(job.tenantId, job.id);
  assert.ok(report.pendingTasks.length > 0);
  let current = FactoryJobService.transition(job.tenantId, job.id, 'SPECIFIED');
  current = FactoryJobService.transition(job.tenantId, current.id, 'IMPLEMENTING');
  current = FactoryJobService.transition(job.tenantId, current.id, 'VALIDATING');
  const approval = ApprovalPolicyService.request({ tenantId: job.tenantId, jobId: job.id, action: 'DEPLOY_PRODUCTION', rationale: 'Test delivery gate' });
  ApprovalPolicyService.decide(job.tenantId, approval.id, 'APPROVED', 'Still pending task should block');
  assert.throws(() => FactoryJobService.transition(job.tenantId, current.id, 'DELIVERED'), /COMPLETION_TASKS_PENDING/);
});
