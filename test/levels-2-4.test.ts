import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { DurableStore } from '../src/services/durableStore';
import { WorkspaceService } from '../src/services/workspaceService';
import { ClientDeliveryService } from '../src/services/clientDeliveryService';
import { HostedDeploymentService } from '../src/services/hostedDeploymentService';
import { FrontierModelService } from '../src/services/frontierModelService';
import { ParallelWorktreeService } from '../src/services/parallelWorktreeService';

function repo(): string { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-levels-')); execFileSync('git', ['init', '-q', root]); execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']); execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']); fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{"test":"node -e \\\"console.log(\\\\\"ok\\\\\")\\\"}}'); execFileSync('git', ['-C', root, 'add', '.']); execFileSync('git', ['-C', root, 'commit', '-qm', 'initial']); return root; }

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-levels-data-')); process.env.FACTORY_DATA_DIR = state; DurableStore.resetForTests();

test('Level 2 client workspace creates isolated handover and acceptance evidence', () => {
  const root = repo(); process.env.FACTORY_WORKSPACE_ROOT = path.dirname(root); process.env.FACTORY_CLIENT_WORKSPACE_ROOT = path.join(state, 'clients'); const project = WorkspaceService.register({ tenantId: 'client-tenant', name: 'Client Product', repositoryPath: root, kind: 'client' }); const workspace = ClientDeliveryService.registerWorkspace({ tenantId: 'client-tenant', projectId: project.id, clientName: 'Acme Client' }); const handover = ClientDeliveryService.createHandover('client-tenant', project.id, { acceptanceCriteria: ['verified', 'rollback'] }); assert.equal(fs.existsSync(handover.file), true); assert.ok(handover.checksum); assert.ok(handover.file.startsWith(workspace.isolationRoot)); const acceptance = ClientDeliveryService.accept('client-tenant', project.id, handover.id, { acceptedBy: 'acme-owner', criteria: [{ id: 'verified', label: 'Verification passes', passed: true, evidence: ['run-digest'] }, { id: 'rollback', label: 'Rollback documented', passed: true, evidence: ['rollback-record'] }] }); assert.equal(acceptance.status, 'ACCEPTED'); });

test('Level 3 hosted target deploys, observes health, and rolls back', () => {
  const root = repo(); process.env.FACTORY_WORKSPACE_ROOT = path.dirname(root); const project = WorkspaceService.register({ tenantId: 'deploy-tenant', name: 'Deploy Product', repositoryPath: root }); const target = HostedDeploymentService.registerTarget({ tenantId: 'deploy-tenant', projectId: project.id, artifactRoot: path.join(state, 'hosted') }); const artifact = path.join(state, 'artifact'); fs.mkdirSync(artifact, { recursive: true }); fs.writeFileSync(path.join(artifact, 'release.txt'), 'v1'); const first = HostedDeploymentService.deploy('deploy-tenant', target.id, artifact, { approved: true, sourceCommit: 'commit-1' }); assert.equal(first.status, 'DEPLOYED'); HostedDeploymentService.observe('deploy-tenant', first.id, { passed: true, detail: 'healthy' }); fs.writeFileSync(path.join(artifact, 'release.txt'), 'v2'); const second = HostedDeploymentService.deploy('deploy-tenant', target.id, artifact, { approved: true, sourceCommit: 'commit-2' }); assert.equal(second.previousDeploymentId, first.id); const rolled = HostedDeploymentService.rollback('deploy-tenant', second.id); assert.equal(rolled.status, 'ROLLED_BACK'); assert.match(rolled.health.detail, /deployment/); });

test('Level 4 registers frontier provider and prepares parallel isolated worktrees', () => {
  const root = repo(); const provider = FrontierModelService.register({ tenantId: 'agent-tenant', id: 'frontier', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9999/v1', modelIds: ['frontier-code'] }); assert.equal(provider.modelIds[0], 'frontier-code'); const run = ParallelWorktreeService.plan({ tenantId: 'agent-tenant', repositoryPath: root, providerId: provider.id, maxParallel: 2, tasks: [{ id: 'api', title: 'API', prompt: 'Implement API' }, { id: 'tests', title: 'Tests', prompt: 'Implement tests', dependsOn: ['api'] }] }); const prepared = ParallelWorktreeService.prepareWorktrees('agent-tenant', run.id); assert.equal(prepared.worktrees.length, 2); assert.notEqual(prepared.worktrees[0].worktreePath, prepared.worktrees[1].worktreePath); assert.equal(prepared.run.status, 'RUNNING'); assert.equal(ParallelWorktreeService.markTask('agent-tenant', prepared.worktrees[0].id, 'COMPLETED').status, 'COMPLETED'); });
