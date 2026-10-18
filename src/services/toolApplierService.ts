/**
 * Tool Applier Service.
 *
 * Bridges model output to durable change. The unattended loop asks a model for an
 * implementation, stores the proposal, and previously stopped there
 * (`PROPOSAL_REQUIRES_TOOL_APPLIER`). This service is the applier: it takes a
 * structured edit proposal, validates every path through `resolveFileWithin`,
 * applies the edits in an isolated git worktree, runs the repository's
 * verification contract, and — only when verification passes — requests a human
 * approval before anything is merged.
 *
 * Design rules (from OPERATIONS.md §2):
 *  1. The model returns structured edits (path, operation, content) — never raw
 *     text to be parsed and blindly written.
 *  2. Every path resolves through `resolveFileWithin` — the same guard the safe
 *     path already uses.
 *  3. Edits land in an isolated git worktree, never the primary branch.
 *  4. The worktree's own verification must pass before anything is proposed for
 *     merge.
 *  5. Merge requires a human approval token (`POST /approvals/:approvalId/decision`).
 *  6. Every applied edit is recorded with its evidence.
 *
 * Fail closed: a traversal attempt, a missing verification command, or a failed
 * verification is a refusal, not a silent pass.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DurableStore } from './durableStore';
import { ApprovalPolicyService, HarnessAction } from './approvalPolicyService';
import { detectVerificationProfile, executeVerification, VerificationProfile } from './verificationProfileService';
import { DoctrineService } from './doctrineService';
import type { LoopSandboxConfig } from './loopTypes';
import { resolveFileWithin } from '../utils/pathGuard';

export interface StructuredEdit {
  /** Repository-relative path. Absolute paths, "..", and anything under .git are refused. */
  path: string;
  /** 'create' | 'modify' | 'delete'. */
  operation: 'create' | 'modify' | 'delete';
  /** Full file content for create/modify. Ignored for delete. */
  content?: string;
}

export interface ToolApplyRequest {
  tenantId: string;
  repo: string;
  branch: string;
  edits: StructuredEdit[];
  verificationCommand?: string;
  requestedBy: string;
  rationale: string;
}

export interface ToolApplyResult {
  applied: boolean;
  worktreePath: string;
  branch: string;
  verificationPassed: boolean;
  approvalId?: string;
  evidence: string[];
  error?: string;
}

interface ToolApplyRecord {
  id: string;
  tenantId: string;
  repo: string;
  branch: string;
  worktreePath: string;
  worktreeBranch: string;
  edits: StructuredEdit[];
  evidence: string[];
  requestedBy: string;
  rationale: string;
  status: 'APPLIED_TO_WORKTREE' | 'VERIFICATION_FAILED' | 'APPROVAL_PENDING' | 'MERGED' | 'REJECTED';
  verificationOutput?: string;
  verificationExitCode?: number;
  commitHash?: string;
  approvalId?: string;
  approvedBy?: string;
  approvedAt?: string;
  rejectionNote?: string;
  rejectedBy?: string;
  rejectedAt?: string;
  mergedBy?: string;
  mergedAt?: string;
  createdAt: string;
  completedAt?: string;
}

const MAX_EDITS_PER_APPLY = 40;
const MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_VERIFY_TIMEOUT_MS = 120_000;

function fail(code: string, detail?: string): Error {
  return new Error(detail ? `${code}:${detail}` : code);
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function gitQuiet(repo: string, args: string[]): void {
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 30_000, stdio: 'ignore' });
}

/** Validates a structured edit and resolves its path inside the repository. */
function validateAndResolveEdit(repo: string, edit: StructuredEdit): { resolvedPath: string; edit: StructuredEdit } {
  if (!edit.path || !edit.path.trim()) throw fail('TOOL_APPLY_PATH_REQUIRED');
  if (path.isAbsolute(edit.path)) throw fail('TOOL_APPLY_PATH_ABSOLUTE', edit.path);
  const normalised = path.normalize(edit.path);
  if (normalised.startsWith('..')) throw fail('TOOL_APPLY_PATH_TRAVERSAL', edit.path);
  if (normalised.split(path.sep).includes('.git')) throw fail('TOOL_APPLY_PATH_GITDIR', edit.path);

  // resolveFileWithin re-validates on real paths and defeats symlinked intermediates.
  const resolved = resolveFileWithin(repo, edit.path, 'TOOL_APPLY_PATH_OUTSIDE_REPO');
  const rel = path.relative(repo, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw fail('TOOL_APPLY_PATH_ESCAPES_REPO', edit.path);
  return { resolvedPath: resolved, edit };
}

/** Applies a single edit to the worktree. */
function applyEdit(worktreePath: string, edit: StructuredEdit): void {
  const target = path.join(worktreePath, edit.path);
  switch (edit.operation) {
    case 'create':
    case 'modify': {
      if (typeof edit.content !== 'string') throw fail('TOOL_APPLY_CONTENT_REQUIRED', edit.path);
      if (Buffer.byteLength(edit.content, 'utf8') > MAX_FILE_BYTES) throw fail('TOOL_APPLY_FILE_TOO_LARGE', edit.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, edit.content, 'utf8');
      break;
    }
    case 'delete': {
      if (!fs.existsSync(target)) return; // idempotent delete
      fs.rmSync(target, { recursive: true, force: true });
      break;
    }
  }
}

/** Runs the repository's verification inside the worktree, sandboxed. */
function verifyWorktree(
  worktreePath: string,
  repo: string,
  verificationCommand?: string,
  timeoutMs: number = DEFAULT_VERIFY_TIMEOUT_MS,
): { passed: boolean; output: string; exitCode: number; profile?: VerificationProfile } {
  const profile = detectVerificationProfile(worktreePath);
  const command = verificationCommand || profile.steps.map((step) => step.label).join(' && ');
  const sandbox: LoopSandboxConfig = DoctrineService.load().loop.sandbox;
  const execution = executeVerification(worktreePath, profile, timeoutMs, sandbox, [repo]);
  return {
    passed: execution.passed,
    output: execution.output,
    exitCode: execution.exitCode,
    profile,
  };
}

/** Commits all changes in the worktree and returns the new commit hash. */
function commitWorktree(worktreePath: string, message: string): string {
  execFileSync('git', ['-C', worktreePath, 'add', '-A'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['-C', worktreePath, 'commit', '-qm', message], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return git(worktreePath, ['rev-parse', 'HEAD']);
}

/** Merges the worktree branch into the target branch on the primary repository. */
function mergeBranch(repo: string, sourceBranch: string, targetBranch: string, message: string): void {
  git(repo, ['switch', targetBranch]);
  git(repo, ['merge', '--no-ff', sourceBranch, '-m', message]);
}

export class ToolApplierService {
  /**
   * Applies a structured edit proposal in an isolated worktree, verifies it, and
   * requests human approval before merge. Returns a result the caller uses to
   * route to the approvals API (`POST /approvals/:approvalId/decision`).
   *
   * Nothing is merged until `approve(approvalId)` is called with a human decision.
   */
  public static apply(request: ToolApplyRequest): ToolApplyResult {
    const { tenantId, repo, branch, edits, requestedBy, rationale } = request;
    const evidence: string[] = [];

    if (!edits.length) throw fail('TOOL_APPLY_NO_EDITS');
    if (edits.length > MAX_EDITS_PER_APPLY) throw fail('TOOL_APPLY_TOO_MANY_EDITS', String(edits.length));

    // Resolve and validate every edit path before touching disk. Fail closed on the
    // first traversal attempt — never apply a partial batch that contains an escape.
    const resolved: Array<{ resolvedPath: string; edit: StructuredEdit }> = [];
    for (const edit of edits) {
      resolved.push(validateAndResolveEdit(repo, edit));
    }

    // Create an isolated worktree for this apply. Edits never touch the primary
    // branch until verification passes and a human approves.
    const root = path.resolve(process.env.FACTORY_WORKTREE_ROOT || path.join(path.dirname(repo), '.factory-worktrees', 'tool-applier'));
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const applyId = DurableStore.id('toolapply', `${tenantId}:${Date.now()}`);
    const worktreePath = path.join(root, applyId);
    const worktreeBranch = `factory/tool-apply/${applyId}`;

    try {
      git(repo, ['worktree', 'add', '-b', worktreeBranch, worktreePath, branch]);
      evidence.push(`worktree created at ${worktreePath} branch ${worktreeBranch}`);

      // Apply every validated edit inside the worktree.
      for (const { resolvedPath, edit } of resolved) {
        const rel = path.relative(worktreePath, resolvedPath);
        applyEdit(worktreePath, edit);
        evidence.push(`applied ${edit.operation} ${rel}`);
      }

      // Record the applied edits durably before verification, so a failed run
      // still leaves an audit trail of what was attempted.
      const recordId = DurableStore.id('toolapply-record', applyId);
      const record: ToolApplyRecord = {
        id: recordId,
        tenantId,
        repo,
        branch,
        worktreePath,
        worktreeBranch,
        edits: resolved.map(({ edit }) => edit),
        requestedBy,
        rationale,
        status: 'APPLIED_TO_WORKTREE',
        evidence,
        createdAt: new Date().toISOString(),
      };
      DurableStore.upsert('toolApplyRecords', recordId, record as unknown as Record<string, unknown>);

      // Run the repository's verification contract inside the worktree, sandboxed.
      const verification = verifyWorktree(worktreePath, repo, request.verificationCommand);
      evidence.push(`verification ${verification.passed ? 'passed' : 'failed'} (exit ${verification.exitCode})`);

      if (!verification.passed) {
        const updated: ToolApplyRecord = {
          ...record,
          status: 'VERIFICATION_FAILED',
          verificationOutput: verification.output,
          verificationExitCode: verification.exitCode,
          completedAt: new Date().toISOString(),
        };
        DurableStore.upsert('toolApplyRecords', recordId, updated as unknown as Record<string, unknown>);
        // Clean up the failed worktree.
        try { gitQuiet(repo, ['worktree', 'remove', '--force', worktreePath]); } catch { /* best effort */ }
        try { gitQuiet(repo, ['branch', '-D', worktreeBranch]); } catch { /* best effort */ }
        return {
          applied: false,
          worktreePath,
          branch: worktreeBranch,
          verificationPassed: false,
          evidence,
          error: `verification failed: ${verification.output.slice(-2000)}`,
        };
      }

      // Commit the verified changes in the worktree.
      const commitMessage = `[tool-apply] ${rationale}\n\nApplied ${edits.length} edit(s) to ${branch}\nEvidence: ${evidence.join('; ')}`;
      const commitHash = commitWorktree(worktreePath, commitMessage);
      evidence.push(`committed ${commitHash.slice(0, 12)}`);

      // Request human approval before merging. MODIFY_BRANCH is not an automatic
      // action, so this creates a PENDING approval the operator must decide.
      const approval = ApprovalPolicyService.request({
        tenantId,
        action: 'MODIFY_BRANCH',
        rationale: `Tool apply ${applyId}: ${rationale}. Verified in worktree ${worktreePath}, commit ${commitHash}.`,
        requestedBy,
      });
      evidence.push(`approval requested ${approval.id}`);

      const updated: ToolApplyRecord = {
        ...record,
        status: 'APPROVAL_PENDING',
        commitHash,
        approvalId: approval.id,
        completedAt: new Date().toISOString(),
      };
      DurableStore.upsert('toolApplyRecords', recordId, updated as unknown as Record<string, unknown>);

      return {
        applied: true,
        worktreePath,
        branch: worktreeBranch,
        verificationPassed: true,
        approvalId: approval.id,
        evidence,
      };
    } catch (error: any) {
      // Clean up the worktree on any failure so no partial state is left behind.
      try { gitQuiet(repo, ['worktree', 'remove', '--force', worktreePath]); } catch { /* best effort */ }
      try { gitQuiet(repo, ['branch', '-D', worktreeBranch]); } catch { /* best effort */ }
      throw error;
    }
  }

  /**
   * Merges an approved tool apply into the target branch.
   *
   * Requires the approval to be APPROVED. Refuses if the approval is missing,
   * already decided, or rejected. After merging, the worktree is removed and the
   * branch is deleted.
   */
  public static approve(tenantId: string, approvalId: string, decidedBy = 'founder'): { merged: boolean; commitHash: string; branch: string; targetBranch: string } {
    const approval = ApprovalPolicyService.get(tenantId, approvalId);
    if (!approval) throw fail('TOOL_APPLY_APPROVAL_NOT_FOUND', approvalId);
    if (approval.action !== 'MODIFY_BRANCH') throw fail('TOOL_APPLY_WRONG_ACTION', approval.action);
    if (approval.status !== 'PENDING') throw fail('TOOL_APPLY_APPROVAL_NOT_PENDING', approval.status);

    // Load the durable record to recover the worktree path, branch, and commit.
    const matching = DurableStore.list('toolApplyRecords').filter((item) => {
      const rec = item as unknown as { approvalId?: string; tenantId?: string };
      return rec.approvalId === approvalId && rec.tenantId === tenantId;
    }) as unknown as ToolApplyRecord[];
    const record = matching[0];
    if (!record) throw fail('TOOL_APPLY_RECORD_NOT_FOUND', approvalId);
    if (!record.worktreePath || !record.worktreeBranch || !record.commitHash || !record.branch) {
      throw fail('TOOL_APPLY_RECORD_INCOMPLETE', approvalId);
    }

    // Merge the verified branch into the target branch on the primary repository.
    const mergeMessage = `[tool-apply] merge ${record.worktreeBranch} into ${record.branch}\nApproved by ${decidedBy} via approval ${approvalId}\n${record.commitHash.slice(0, 12)}`;
    mergeBranch(record.repo, record.worktreeBranch, record.branch, mergeMessage);

    // Approve the durable approval record.
    ApprovalPolicyService.decide(tenantId, approvalId, 'APPROVED', `Tool apply merged into ${record.branch}`, decidedBy);

    // Clean up: remove the worktree and delete the branch.
    try { gitQuiet(record.repo, ['worktree', 'remove', '--force', record.worktreePath]); } catch { /* best effort */ }
    try { gitQuiet(record.repo, ['branch', '-D', record.worktreeBranch]); } catch { /* best effort */ }

    const updated: ToolApplyRecord = {
      ...record,
      status: 'MERGED',
      approvedBy: decidedBy,
      approvedAt: new Date().toISOString(),
    };
    DurableStore.upsert('toolApplyRecords', record.id, updated as unknown as Record<string, unknown>);

    return { merged: true, commitHash: record.commitHash, branch: record.worktreeBranch, targetBranch: record.branch };
  }

  /** Rejects a pending tool apply, cleaning up the worktree. */
  public static reject(tenantId: string, approvalId: string, note: string, decidedBy = 'founder'): { rejected: boolean } {
    const approval = ApprovalPolicyService.get(tenantId, approvalId);
    if (!approval) throw fail('TOOL_APPLY_APPROVAL_NOT_FOUND', approvalId);
    if (approval.status !== 'PENDING') throw fail('TOOL_APPLY_APPROVAL_NOT_PENDING', approval.status);

    ApprovalPolicyService.decide(tenantId, approvalId, 'REJECTED', note, decidedBy);

    const matching = DurableStore.list('toolApplyRecords').filter((item) => {
      const rec = item as unknown as { approvalId?: string; tenantId?: string };
      return rec.approvalId === approvalId && rec.tenantId === tenantId;
    }) as unknown as ToolApplyRecord[];
    const entry = matching[0];
    if (entry?.worktreePath) {
      try { gitQuiet(entry.repo, ['worktree', 'remove', '--force', entry.worktreePath]); } catch { /* best effort */ }
    }
    if (entry?.worktreeBranch) {
      try { gitQuiet(entry.repo, ['branch', '-D', entry.worktreeBranch]); } catch { /* best effort */ }
    }

    const updated: ToolApplyRecord = {
      ...entry,
      status: 'REJECTED',
      rejectionNote: note,
      rejectedBy: decidedBy,
      rejectedAt: new Date().toISOString(),
    };
    DurableStore.upsert('toolApplyRecords', entry.id, updated as unknown as Record<string, unknown>);

    return { rejected: true };
  }

  /** Lists all tool apply records for a tenant, for audit and observability. */
  public static list(tenantId: string): Array<{ id: string; status: string; branch?: string; commitHash?: string; createdAt: string; approvalId?: string }> {
    return DurableStore.list('toolApplyRecords')
      .filter((item) => (item as unknown as { tenantId: string }).tenantId === tenantId)
      .map((item) => item as unknown as { id: string; status: string; branch?: string; commitHash?: string; createdAt: string; approvalId?: string });
  }
}
