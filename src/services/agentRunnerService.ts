import { DurableStore } from './durableStore';
import { ParallelWorktreeService, AgentRun } from './parallelWorktreeService';

export type QueueStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
export interface QueueJob { id: string; tenantId: string; runId: string; taskId: string; status: QueueStatus; attempts: number; maxAttempts: number; leaseOwner?: string; leaseUntil?: string; lastError?: string; result?: Record<string, unknown>; createdAt: string; updatedAt: string; }
export interface RunnerResult { taskId: string; passed: boolean; output: string; evidence: string[]; error?: string; }

function tenantOf(value: Record<string, unknown>): string { return String(value.tenantId ?? ''); }
function now(): string { return new Date().toISOString(); }

export class AgentRunnerService {
  public static enqueue(tenantId: string, runId: string, maxAttempts = 2): QueueJob[] {
    const run = ParallelWorktreeService.get(tenantId, runId); if (!run) throw new Error('AGENT_RUN_NOT_FOUND');
    return run.tasks.map((task) => { const job: QueueJob = { id: DurableStore.id('queue', `${runId}:${task.id}`), tenantId, runId, taskId: task.id, status: 'QUEUED', attempts: 0, maxAttempts: Math.min(Math.max(maxAttempts, 1), 5), createdAt: now(), updatedAt: now() }; DurableStore.upsert('queueJobs', job.id, job as unknown as Record<string, unknown>); return job; });
  }
  public static claim(tenantId: string, worker: string, leaseMs = 120000): QueueJob | undefined {
    const current = Date.now(); const candidate = DurableStore.list('queueJobs').map((item) => item as unknown as QueueJob).filter((job) => job.tenantId === tenantId && ['QUEUED', 'RUNNING'].includes(job.status) && (!job.leaseUntil || Date.parse(job.leaseUntil) <= current) && job.attempts < job.maxAttempts).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]; if (!candidate) return undefined; const claimed = { ...candidate, status: 'RUNNING' as const, attempts: candidate.attempts + 1, leaseOwner: worker, leaseUntil: new Date(current + leaseMs).toISOString(), updatedAt: now() }; DurableStore.upsert('queueJobs', candidate.id, claimed as unknown as Record<string, unknown>); return claimed;
  }
  public static complete(tenantId: string, jobId: string, result: RunnerResult): QueueJob { const job = this.get(tenantId, jobId); if (!job) throw new Error('QUEUE_JOB_NOT_FOUND'); const updated: QueueJob = { ...job, status: result.passed ? 'SUCCEEDED' : (job.attempts >= job.maxAttempts ? 'FAILED' : 'QUEUED'), result: result as unknown as Record<string, unknown>, lastError: result.error, leaseOwner: undefined, leaseUntil: undefined, updatedAt: now() }; DurableStore.upsert('queueJobs', jobId, updated as unknown as Record<string, unknown>); ParallelWorktreeService.markTask(tenantId, this.worktreeId(tenantId, job.runId, job.taskId), result.passed ? 'COMPLETED' : 'FAILED'); return updated; }
  public static cancel(tenantId: string, jobId: string): QueueJob { const job = this.get(tenantId, jobId); if (!job) throw new Error('QUEUE_JOB_NOT_FOUND'); const updated = { ...job, status: 'CANCELLED' as const, leaseOwner: undefined, leaseUntil: undefined, updatedAt: now() }; DurableStore.upsert('queueJobs', jobId, updated as unknown as Record<string, unknown>); return updated; }
  public static list(tenantId: string, runId?: string): QueueJob[] { return DurableStore.list('queueJobs').filter((item) => tenantOf(item) === tenantId && (!runId || item.runId === runId)) as unknown as QueueJob[]; }
  public static get(tenantId: string, id: string): QueueJob | undefined { const job = DurableStore.get('queueJobs', id) as unknown as QueueJob | undefined; return job?.tenantId === tenantId ? job : undefined; }
  public static resumeExpired(tenantId: string): QueueJob[] { return this.list(tenantId).filter((job) => job.status === 'RUNNING' && job.leaseUntil && Date.parse(job.leaseUntil) <= Date.now()).map((job) => { const updated = { ...job, status: 'QUEUED' as const, leaseOwner: undefined, leaseUntil: undefined, updatedAt: now() }; DurableStore.upsert('queueJobs', job.id, updated as unknown as Record<string, unknown>); return updated; }); }
  private static worktreeId(tenantId: string, runId: string, taskId: string): string { const worktree = ParallelWorktreeService.list(tenantId, runId).find((item) => item.taskId === taskId); if (!worktree) throw new Error('WORKTREE_NOT_FOUND'); return worktree.id; }
}
