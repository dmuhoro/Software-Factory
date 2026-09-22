import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DurableStore } from './durableStore';
import { FrontierModelService } from './frontierModelService';

export interface WorktreeRecord { id: string; tenantId: string; runId: string; taskId: string; repositoryPath: string; worktreePath: string; branch: string; status: 'READY' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'MERGED'; createdAt: string; }
export interface AgentTask { id: string; title: string; prompt: string; model?: string; dependsOn?: string[]; }
export interface AgentRun { id: string; tenantId: string; repositoryPath: string; providerId?: string; status: 'PLANNED' | 'RUNNING' | 'BLOCKED' | 'COMPLETED' | 'FAILED'; maxParallel: number; mergeOrder: string[]; tasks: AgentTask[]; worktreeIds: string[]; createdAt: string; }

function safe(value: string): string { return value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task'; }
function git(repo: string, args: string[]): string { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 30000 }).trim(); }
function tenantOf(value: Record<string, unknown>): string { return String(value.tenantId ?? ''); }

export class ParallelWorktreeService {
  public static plan(input: { tenantId: string; repositoryPath: string; tasks: AgentTask[]; providerId?: string; maxParallel?: number }): AgentRun {
    if (!fs.existsSync(path.join(input.repositoryPath, '.git'))) throw new Error('AGENT_REPOSITORY_NOT_GIT'); if (!input.tasks.length) throw new Error('AGENT_TASKS_REQUIRED'); const ids = new Set<string>(); for (const task of input.tasks) { if (ids.has(task.id)) throw new Error('AGENT_TASK_IDS_MUST_BE_UNIQUE'); ids.add(task.id); for (const dependency of task.dependsOn ?? []) if (!ids.has(dependency) && !input.tasks.some((candidate) => candidate.id === dependency)) throw new Error(`AGENT_DEPENDENCY_NOT_FOUND:${dependency}`); }
    if (input.providerId && !FrontierModelService.get(input.tenantId, input.providerId)) throw new Error('MODEL_PROVIDER_NOT_FOUND'); const run: AgentRun = { id: DurableStore.id('agentrun', `${input.tenantId}:${input.repositoryPath}:${input.tasks.map((task) => task.id).join(',')}`), tenantId: input.tenantId, repositoryPath: path.resolve(input.repositoryPath), providerId: input.providerId, status: 'PLANNED', maxParallel: Math.min(Math.max(input.maxParallel ?? 2, 1), 8), mergeOrder: input.tasks.map((task) => task.id), tasks: input.tasks, worktreeIds: [], createdAt: new Date().toISOString() }; DurableStore.upsert('agentRuns', run.id, run as unknown as Record<string, unknown>); return run;
  }
  public static prepareWorktrees(tenantId: string, runId: string): { run: AgentRun; worktrees: WorktreeRecord[] } {
    const run = this.get(tenantId, runId); if (!run) throw new Error('AGENT_RUN_NOT_FOUND'); const root = path.resolve(process.env.FACTORY_WORKTREE_ROOT || path.join(path.dirname(run.repositoryPath), '.factory-worktrees', run.id)); fs.mkdirSync(root, { recursive: true, mode: 0o700 }); const worktrees = run.tasks.map((task, index) => { const branch = `factory/${safe(run.id)}/${String(index + 1).padStart(2, '0')}-${safe(task.id)}`; const worktreePath = path.join(root, `${String(index + 1).padStart(2, '0')}-${safe(task.id)}`); if (!fs.existsSync(worktreePath)) git(run.repositoryPath, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD']); const record: WorktreeRecord = { id: DurableStore.id('worktree', `${run.id}:${task.id}`), tenantId, runId, taskId: task.id, repositoryPath: run.repositoryPath, worktreePath, branch, status: 'READY', createdAt: new Date().toISOString() }; DurableStore.upsert('worktrees', record.id, record as unknown as Record<string, unknown>); return record; }); const updated = { ...run, status: 'RUNNING' as const, worktreeIds: worktrees.map((item) => item.id) }; DurableStore.upsert('agentRuns', run.id, updated as unknown as Record<string, unknown>); return { run: updated, worktrees };
  }
  public static markTask(tenantId: string, worktreeId: string, status: WorktreeRecord['status']): WorktreeRecord { const value = DurableStore.get('worktrees', worktreeId) as unknown as WorktreeRecord | undefined; if (!value || value.tenantId !== tenantId) throw new Error('WORKTREE_NOT_FOUND'); const updated = { ...value, status }; DurableStore.upsert('worktrees', worktreeId, updated as unknown as Record<string, unknown>); return updated; }
  public static list(tenantId: string, runId?: string): WorktreeRecord[] { return DurableStore.list('worktrees').filter((item) => tenantOf(item) === tenantId && (!runId || item.runId === runId)) as unknown as WorktreeRecord[]; }
  public static get(tenantId: string, id: string): AgentRun | undefined { const run = DurableStore.get('agentRuns', id) as unknown as AgentRun | undefined; return run?.tenantId === tenantId ? run : undefined; }
  public static runs(tenantId: string): AgentRun[] { return DurableStore.list('agentRuns').filter((item) => tenantOf(item) === tenantId) as unknown as AgentRun[]; }
}
