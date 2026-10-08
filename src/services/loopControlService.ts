/**
 * The remote control plane for the unattended loop.
 *
 * Sprint 24. The driver already knows how to run a task document to completion, and it already
 * persists its run record and its live event stream. What did not exist was any way to ask it to
 * start from an authenticated HTTP request, or to watch a run without shell access. This service
 * is that layer, and deliberately nothing more: it validates the caller's request against the
 * approved workspace, starts the real `ExecutionLoopService`, and exposes the durable run record
 * it produces. It does not re-implement the loop, and it does not keep a second state machine
 * that could disagree with the ledger.
 *
 * Two safety boundaries live here:
 *
 *  - The repository is an allowlist, not a parameter. It must resolve inside the approved
 *    workspace root and be a git repository, or the submission is refused. An endpoint that can
 *    start arbitrary execution on an arbitrary path is a remote code execution primitive.
 *  - One run per repository at a time. The loop assumes it is the only writer of the target tree;
 *    two runs on one repository would interleave commits. A second submission while one is live
 *    is refused by name.
 */
import { ConfirmationService, type IssuedConfirmation } from './confirmationService';
import { ExecutionLoopService, type LoopRunOutcome } from './executionLoopService';
import type { LoopRunRecord, LoopStatus } from './loopTypes';
import { resolveWithin, isGitRepository } from '../utils/pathGuard';

/** The operation a confirmation token is bound to. Kept out of the token's visible shape. */
const CANCEL_OPERATION = 'loop.run.cancel';

export interface SubmitLoopRunInput {
  tenantId: string;
  /** Path to the target git repository. Must resolve inside the approved workspace. */
  repo: string;
  /** Path to the task document. Must resolve inside the approved workspace. */
  taskDocument: string;
  /** Lowers doctrine's attempts-per-unit. Cannot raise it. */
  attemptCap?: number;
}

export interface SubmitLoopRunResult {
  runId: string;
  repo: string;
  taskDocument: string;
  status: 'running';
}

export interface LoopRunSummary {
  runId: string;
  status: LoopStatus;
  repo: string;
  taskDocument: string;
  startedAt: string;
  finishedAt?: string;
  active: boolean;
  units: { total: number; done: number; stuck: number; blocked: number };
  commits: number;
  gates: number;
  refusedGates: number;
  hardStop?: string;
  refusal?: string;
}

interface ActiveLoopRun {
  runId: string;
  repo: string;
  tenantId: string;
  /** Resolves when the driver has finished, successfully or not. */
  settled: Promise<LoopRunOutcome>;
}

export class LoopControlService {
  private static readonly active = new Map<string, ActiveLoopRun>();
  private static readonly activeByRepo = new Map<string, string>();

  /**
   * Validates and starts a run. Resolves with the run id as soon as the run record exists, so the
   * caller gets a handle while the work continues in the background.
   */
  public static async submit(input: SubmitLoopRunInput): Promise<{ runId: string; repo: string; taskDocument: string; status: 'running' }> {
    const repo = resolveRepo(input.repo);
    const taskDocument = resolveTaskDocument(input.taskDocument);

    const busy = this.activeByRepo.get(repo);
    if (busy) throw new Error(`LOOP_RUN_ALREADY_ACTIVE:${busy}`);

    let runId = '';
    const runPromise = ExecutionLoopService.run({
      repo,
      taskDocument,
      tenantId: input.tenantId,
      attemptCap: input.attemptCap,
      onRunCreated: (id) => { runId = id; },
    });

    if (!runId) {
      // The run refused before it created a record (dirty tree, unreadable document, doctrine
      // drift). Surface the real refusal rather than reporting a run that does not exist.
      await runPromise;
      throw new Error('the loop resolved without creating a run record');
    }

// The run's synchronous prefix has already created its record, so the repository is now
      // claimed. Registering synchronously closes the window where a second submission could pass
      // the `busy` check above. If the driver resolved without ever creating a record it has a
      // bug, not a domain condition: throw a plain internal fault, never a phantom run id.
      this.activeByRepo.set(repo, runId);
    this.active.set(runId, { runId, repo, tenantId: input.tenantId, settled: runPromise });
    const release = (): void => {
      this.active.delete(runId);
      if (this.activeByRepo.get(repo) === runId) this.activeByRepo.delete(repo);
    };
    void runPromise.then(release, release);

    return { runId, repo, taskDocument, status: 'running' };
  }

  /** A run's record, scoped to the tenant that owns it. A foreign run is a miss, not a 403. */
  public static get(tenantId: string, runId: string): LoopRunRecord | undefined {
    const record = ExecutionLoopService.getRun(runId);
    return record && record.tenantId === tenantId ? record : undefined;
  }

  /** Every run this tenant has submitted, newest first. */
  public static list(tenantId: string): LoopRunRecord[] {
    return ExecutionLoopService.listRuns()
      .filter((run) => run.tenantId === tenantId)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }

  public static summaries(tenantId: string): Array<Record<string, unknown>> {
    return this.list(tenantId).map((run) => this.summary(run));
  }

  public static summary(run: LoopRunRecord): Record<string, unknown> {
    const status: LoopStatus = run.status;
    return {
      runId: run.runId,
      status,
      repo: run.repo,
      taskDocument: run.taskDocument,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      active: this.isActive(run.runId),
      units: {
        total: run.units.length,
        done: run.units.filter((unit) => unit.status === 'done').length,
        stuck: run.units.filter((unit) => unit.status === 'stuck').length,
        blocked: run.units.filter((unit) => unit.status === 'blocked').length,
      },
      commits: run.commits.length,
      gates: run.gates.length,
      refusedGates: run.gates.filter((gate) => !gate.passed).length,
      ...(run.hardStop ? { hardStop: run.hardStop } : {}),
      ...(run.refusal ? { refusal: run.refusal } : {}),
    };
  }

  public static isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  /** Resolves when a run this process started finishes. Undefined for a run started elsewhere. */
  public static whenSettled(runId: string): Promise<LoopRunOutcome> | undefined {
    return this.active.get(runId)?.settled;
  }

  // ── two-phase cancellation ──────────────────────────────────────────────
  //
  // Stopping a run is irreversible: work already committed stays committed, and the units that
  // had not started will never run. So it takes the same two calls an irreversible operation
  // takes anywhere else - ask, look at what is about to happen, then present a token.

  /** Phase one. Issues the single-use token; takes no action on the run. */
  public static requestCancel(tenantId: string, runId: string): IssuedConfirmation {
    const record = this.get(tenantId, runId);
    if (!record) throw new Error('LOOP_RUN_NOT_FOUND');
    if (record.status !== 'running') throw new Error('LOOP_RUN_NOT_CANCELABLE');
    return ConfirmationService.issue({ tenantId, operation: CANCEL_OPERATION, subjectId: runId });
  }

  /**
   * Phase two. Consumes the token and asks the loop to stop at its next unit boundary.
   *
   * Returns false when the run had already settled between the two calls. That is not a failure
   * of the request - the outcome the caller wanted already happened - so it is reported as
   * `alreadySettled` rather than as an error.
   */
  public static confirmCancel(
    tenantId: string,
    runId: string,
    token: unknown,
  ): { alreadySettled: boolean } {
    const record = this.get(tenantId, runId);
    if (!record) throw new Error('LOOP_RUN_NOT_FOUND');

    const redeemed = ConfirmationService.consume({ token, tenantId, operation: CANCEL_OPERATION, subjectId: runId });
    if (!redeemed) throw new Error('LOOP_CONFIRMATION_INVALID');

    if (record.status !== 'running') return { alreadySettled: true };
    // requestCancellation re-reads the record and refuses a settled run, so a race between the
    // status check above and the instruction below cannot report success for a run that ended.
    const accepted = ExecutionLoopService.requestCancellation(runId);
    return { alreadySettled: !accepted };
  }
}

/** Validates a target repository: required, inside the approved workspace, and a git repository. */
export function resolveLoopRepo(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('LOOP_REPO_REQUIRED');
  const resolved = resolveWithin(raw, { code: 'LOOP_REPO_OUTSIDE_WORKSPACE', mustExist: true, mustBeDirectory: true });
  if (!isGitRepository(resolved)) throw new Error('LOOP_REPO_NOT_GIT');
  return resolved;
}

/** Validates a task document path: required and inside the approved workspace. */
export function resolveLoopTaskDocument(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('LOOP_TASK_DOCUMENT_REQUIRED');
  return resolveWithin(raw, { code: 'LOOP_TASK_DOCUMENT_OUTSIDE_WORKSPACE', mustExist: true });
}

const resolveRepo = resolveLoopRepo;
const resolveTaskDocument = resolveLoopTaskDocument;