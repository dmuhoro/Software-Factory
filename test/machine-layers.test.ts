import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { DurableStore } from '../src/services/durableStore';
import { ParallelWorktreeService } from '../src/services/parallelWorktreeService';
import { AgentRunnerService } from '../src/services/agentRunnerService';
import { SandboxPolicyService } from '../src/services/sandboxPolicyService';
import { QualityGateService } from '../src/services/qualityGateService';

function repo(): string { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-machine-')); execFileSync('git', ['init', '-q', root]); execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']); execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']); fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{"test":"node -e \\"console.log(\\\\"ok\\\\")\\"}}'); execFileSync('git', ['-C', root, 'add', '.']); execFileSync('git', ['-C', root, 'commit', '-qm', 'initial']); return root; }
const root = repo(); const data = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-machine-data-')); process.env.FACTORY_DATA_DIR = data; process.env.FACTORY_WORKSPACE_ROOT = path.dirname(root); process.env.FACTORY_SANDBOX_ROOT = path.join(data, 'sandboxes'); DurableStore.resetForTests();

test('durable runner leases, resumes, and completes queued work', () => { const run = ParallelWorktreeService.plan({ tenantId: 'runner', repositoryPath: root, tasks: [{ id: 'one', title: 'One', prompt: 'one' }] }); ParallelWorktreeService.prepareWorktrees('runner', run.id); const jobs = AgentRunnerService.enqueue('runner', run.id); const claimed = AgentRunnerService.claim('runner', 'worker-1', 0); assert.equal(claimed?.status, 'RUNNING'); assert.equal(AgentRunnerService.resumeExpired('runner').length, 1); const reClaimed = AgentRunnerService.claim('runner', 'worker-2'); assert.equal(reClaimed?.attempts, 2); const completed = AgentRunnerService.complete('runner', reClaimed!.id, { taskId: 'one', passed: true, output: 'ok', evidence: ['verification.log'] }); assert.equal(completed.status, 'SUCCEEDED'); assert.equal(jobs[0].id, completed.id); });

test('sandbox policy rejects unapproved paths and records explicit controls', () => { assert.throws(() => SandboxPolicyService.createPolicy({ tenantId: 'sandbox', sourcePath: '/home' }), /SANDBOX_SOURCE_OUTSIDE_APPROVED_WORKSPACE/); const policy = SandboxPolicyService.createPolicy({ tenantId: 'sandbox', sourcePath: root, runtime: 'docker-isolated', network: 'disabled', secretRefs: ['FACTORY_API_KEY'] }); assert.equal(policy.network, 'disabled'); assert.equal(policy.runtime, 'docker-isolated'); assert.equal(SandboxPolicyService.planRun('sandbox', policy.id).status, 'PLANNED'); });

test('quality gates detect project type and block credential-like content', () => { const adapter = QualityGateService.detect('quality', 'project-1', root); assert.equal(adapter.kind, 'node'); fs.writeFileSync(path.join(root, 'leak.ts'), 'const key = "sk-abcdefghijklmnopqrstuvwxyz";'); const scan = QualityGateService.scan('quality', root, 'project-1'); assert.equal(scan.status, 'BLOCKED'); assert.ok(scan.findings.some((item) => item.severity === 'HIGH')); });
