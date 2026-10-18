/**
 * Agent Execution Service.
 *
 * Bridges a claimed queue job to a verified, approval-gated repository change.
 * Previously this service asked a model for a proposal, stored it, and stopped
 * with `PROPOSAL_REQUIRES_TOOL_APPLIER` — nothing applied the model's output to
 * disk. Now it asks the model for structured edits, applies them through
 * `ToolApplierService` (path-guard → isolated worktree → sandboxed verification
 * → human approval), and returns the result.
 *
 * The model is prompted to return a JSON envelope: `{"edits":[{path,operation,content}]}`.
 * Anything that is not that shape is a hard refusal — the model's prose is never
 * treated as a change.
 */

import { AgentRunnerService, QueueJob } from './agentRunnerService';
import { ParallelWorktreeService } from './parallelWorktreeService';
import { FrontierModelService } from './frontierModelService';
import { DurableStore } from './durableStore';
import { ToolApplierService, StructuredEdit, ToolApplyRequest } from './toolApplierService';

export interface ExecutionRecord { id: string; tenantId: string; queueJobId: string; taskId: string; model?: string; status: 'APPLIED' | 'FAILED'; output: string; worktreePath?: string; approvalId?: string; createdAt: string; }

const MAX_EDITS_PER_APPLY = 40;

function fail(code: string, detail?: string): Error {
  return new Error(detail ? `${code}:${detail}` : code);
}

function parseStructuredEdits(raw: string): StructuredEdit[] {
  if (typeof raw !== 'string' || !raw.trim()) throw fail('EXECUTION_OUTPUT_EMPTY');
  let candidate = raw.trim();
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidate = fenced[1].trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw fail('EXECUTION_OUTPUT_MALFORMED', 'no JSON object found');
  candidate = candidate.slice(start, end + 1);

  let parsed: unknown;
  try { parsed = JSON.parse(candidate); } catch (error) { throw fail('EXECUTION_OUTPUT_MALFORMED', (error as Error).message); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw fail('EXECUTION_OUTPUT_MALFORMED', 'top level must be an object');
  const record = parsed as Record<string, unknown>;
  const edits = record.edits;
  if (!Array.isArray(edits) || edits.length === 0) throw fail('EXECUTION_OUTPUT_NO_EDITS', 'edits must be a non-empty array');
  if (edits.length > MAX_EDITS_PER_APPLY) throw fail('EXECUTION_OUTPUT_TOO_MANY_EDITS', String(edits.length));

  const result: StructuredEdit[] = [];
  for (const entry of edits) {
    if (typeof entry !== 'object' || entry === null) throw fail('EXECUTION_OUTPUT_MALFORMED', 'edit entry must be an object');
    const e = entry as Record<string, unknown>;
    if (typeof e.path !== 'string' || !e.path.trim()) throw fail('EXECUTION_OUTPUT_MALFORMED', 'edit path must be a non-empty string');
    if (!['create', 'modify', 'delete'].includes(String(e.operation))) {
      throw fail('EXECUTION_OUTPUT_MALFORMED', `edit operation must be create, modify, or delete (got ${String(e.operation)})`);
    }
    if ((e.operation === 'create' || e.operation === 'modify') && typeof e.content !== 'string') {
      throw fail('EXECUTION_OUTPUT_MALFORMED', `edit ${e.path} content must be a string for ${e.operation}`);
    }
    result.push({ path: e.path.trim(), operation: e.operation as 'create' | 'modify' | 'delete', content: typeof e.content === 'string' ? e.content : undefined });
  }
  return result;
}

export class AgentExecutionService {
  public static async executeClaimed(tenantId: string, worker: string, input: { providerId: string; model: string; repo: string; branch?: string; system?: string; maxOutputTokens?: number }): Promise<ExecutionRecord | undefined> {
    const job = AgentRunnerService.claim(tenantId, worker);
    if (!job) return undefined;
    const run = ParallelWorktreeService.get(tenantId, job.runId);
    const task = run?.tasks.find((candidate) => candidate.id === job.taskId);
    const worktree = ParallelWorktreeService.list(tenantId, job.runId).find((candidate) => candidate.taskId === job.taskId);
    if (!task || !worktree) {
      AgentRunnerService.complete(tenantId, job.id, { taskId: job.taskId, passed: false, output: '', evidence: [], error: 'TASK_WORKTREE_NOT_FOUND' });
      return undefined;
    }

    const repo = input.repo || worktree.worktreePath;
    const branch = input.branch || `agent/${job.taskId}`;
    const system = input.system ?? 'You are a bounded software factory worker. Return structured file edits as JSON. Do not claim files were changed unless evidence is supplied.';
    const taskPrompt = `${task.prompt}\n\nRepository worktree: ${worktree.worktreePath}\nTarget branch: ${branch}\nReturn ONLY a JSON object: {"edits":[{"path":"relative/path.ext","operation":"create|modify|delete","content":"full file content"}]}.\nRules:\n- Paths are relative to the repository root.\n- Return the COMPLETE content of every file you change.\n- Change only what the task requires.\n- Never include credentials, tokens, or private keys.\n- No prose outside the JSON object.`;

    try {
      const response = await FrontierModelService.request(tenantId, {
        providerId: input.providerId,
        model: input.model,
        system,
        task: taskPrompt,
        maxOutputTokens: input.maxOutputTokens,
      });

      const edits = parseStructuredEdits(response.content);

      const applyRequest: ToolApplyRequest = {
        tenantId,
        repo,
        branch,
        edits,
        requestedBy: worker,
        rationale: `Agent execution ${job.id}: ${task.title}`,
      };

      const result = ToolApplierService.apply(applyRequest);

      const record = {
        id: DurableStore.id('execution', job.id),
        tenantId,
        queueJobId: job.id,
        taskId: job.taskId,
        model: input.model,
        status: result.verificationPassed ? 'APPLIED' : 'FAILED',
        output: result.error ?? `Applied ${edits.length} edit(s), verification ${result.verificationPassed ? 'passed' : 'failed'}`,
        worktreePath: result.worktreePath,
        approvalId: result.approvalId,
        createdAt: new Date().toISOString(),
      };
      DurableStore.upsert('executionRuns', record.id, record as unknown as Record<string, unknown>);

      AgentRunnerService.complete(tenantId, job.id, {
        taskId: job.taskId,
        passed: result.verificationPassed,
        output: result.error ?? `Verification ${result.verificationPassed ? 'passed' : 'failed'}; ${result.evidence.join('; ')}`,
        evidence: [...result.evidence, result.approvalId ? `approval:${result.approvalId}` : ''],
        error: result.verificationPassed ? undefined : result.error,
      });

      return record as unknown as ExecutionRecord;
    } catch (error: any) {
      AgentRunnerService.complete(tenantId, job.id, {
        taskId: job.taskId,
        passed: false,
        output: '',
        evidence: [],
        error: error?.message ?? 'MODEL_EXECUTION_FAILED',
      });
      throw error;
    }
  }
}
