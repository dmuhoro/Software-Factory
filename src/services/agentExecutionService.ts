import { AgentRunnerService, QueueJob } from './agentRunnerService';
import { ParallelWorktreeService } from './parallelWorktreeService';
import { FrontierModelService } from './frontierModelService';
import { DurableStore } from './durableStore';

export interface ExecutionRecord { id: string; tenantId: string; queueJobId: string; taskId: string; model?: string; status: 'PROPOSED' | 'FAILED'; output: string; worktreePath?: string; createdAt: string; }

export class AgentExecutionService {
  public static async executeClaimed(tenantId: string, worker: string, input: { providerId: string; model: string; system?: string; maxOutputTokens?: number }): Promise<ExecutionRecord | undefined> {
    const job = AgentRunnerService.claim(tenantId, worker); if (!job) return undefined; const run = ParallelWorktreeService.get(tenantId, job.runId); const task = run?.tasks.find((candidate) => candidate.id === job.taskId); const worktree = ParallelWorktreeService.list(tenantId, job.runId).find((candidate) => candidate.taskId === job.taskId); if (!task || !worktree) { AgentRunnerService.complete(tenantId, job.id, { taskId: job.taskId, passed: false, output: '', evidence: [], error: 'TASK_WORKTREE_NOT_FOUND' }); return undefined; }
    try { const response = await FrontierModelService.request(tenantId, { providerId: input.providerId, model: input.model, system: input.system ?? 'You are a bounded software factory worker. Return a concise implementation proposal and verification plan. Do not claim files were changed unless evidence is supplied.', task: `${task.prompt}\n\nRepository worktree: ${worktree.worktreePath}\nReturn an implementation proposal, files to change, commands to verify, risks, and escalation conditions.`, maxOutputTokens: input.maxOutputTokens }); const record: ExecutionRecord = { id: DurableStore.id('execution', job.id), tenantId, queueJobId: job.id, taskId: job.taskId, model: input.model, status: 'PROPOSED', output: response.content, worktreePath: worktree.worktreePath, createdAt: new Date().toISOString() }; DurableStore.upsert('executionRuns', record.id, record as unknown as Record<string, unknown>); AgentRunnerService.complete(tenantId, job.id, { taskId: job.taskId, passed: false, output: response.content, evidence: [`execution:${record.id}`], error: 'PROPOSAL_REQUIRES_TOOL_APPLIER' }); return record; } catch (error: any) { AgentRunnerService.complete(tenantId, job.id, { taskId: job.taskId, passed: false, output: '', evidence: [], error: error?.message ?? 'MODEL_EXECUTION_FAILED' }); throw error; }
  }
}
