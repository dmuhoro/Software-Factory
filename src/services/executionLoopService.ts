import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { DurableStore } from './durableStore';
import { DoctrineService } from './doctrineService';
import { DoctrineIsolationService, type IsolationManifest } from './doctrineIsolationService';
import { FrontierModelService } from './frontierModelService';
import { ResourceGovernorService } from './resourceGovernorService';
import { ImplementerService } from './implementerService';
import { ReviewService } from './reviewService';
import { commitUnit, readLoopVersion } from './commitService';
import { collectGroundTruth, proofDigest, type GroundTruthProof } from './groundTruthService';
import { detectVerificationProfile } from './verificationProfileService';
import { decompose, loadTaskDocument, type WorkUnit } from './taskDocumentService';
import { assertRegistryComplete, runStageGates, type GateContext } from './loopGates';
import { resolveFileWithin } from '../utils/pathGuard';
import { slimProof, widenProof, type AttemptRecord, type GateResult, type LoopEvent, type LoopRunRecord, type LoopStage, type UnitRecord } from './loopTypes';

/**
 * The driver: PLAN → IMPLEMENT → VERIFY → COMMIT → REPORT, one unit at a time, unattended.
 *
 * What makes it a loop rather than a script:
 *
 *  - Every stage transition runs doctrine's hooks through the gate registry, and a blocking
 *    refusal stops the stage with its reason recorded. No stage is entered because it was next
 *    in a list of strings; it is entered because its gates said yes.
 *  - A unit gets `attempt.maxPerUnit` attempts. Each attempt quotes the previous refusal back to
 *    the model, rolls the working tree back to where the attempt started, and is recorded with
 *    the stage it died in. After the cap the unit is STUCK and the run continues with the next
 *    independent unit — no unit blocks the run forever, and nothing is reported as done that was
 *    not verified.
 *  - Hard stops (wall clock, total attempts, commits, doctrine drift, resource exhaustion) end
 *    the run rather than the run continuing under rules someone changed mid-flight.
 *  - The run always leaves a report on disk, including when it refuses or halts: the failure
 *    record is the point of an unattended loop.
 */

export interface LoopRunOptions {
  repo: string;
  taskDocument: string;
  tenantId?: string;
  /** Lowers `attempt.maxPerUnit`. Cannot raise it: doctrine is a ceiling, not a request. */
  attemptCap?: number;
  resumeRunId?: string;
  reportDir?: string;
  /** Extra environment for the processes this run spawns. */
  env?: Record<string, string>;
  /** Called the moment the live event stream is opened, so an operator can tail it mid-run. */
  onStart?: (eventsPath: string) => void;
  /** Called for every event as it is produced, before it is durable. */
  onEvent?: (entry: LoopEvent) => void;
}

export interface LoopRunOutcome {
  record: LoopRunRecord;
  reportFiles: { markdown: string; json: string };
  /** Absolute path to the live JSONL event stream (`record.eventsPath`). */
  eventsPath: string;
  /** 0 = every unit committed; 2 = some units are stuck or blocked; 3 = the run halted. */
  exitCode: 0 | 2 | 3;
}

class LoopHardStop extends Error {
  public readonly reason: string;
  constructor(reason: string) {
    super(`HARD_STOP:${reason}`);
    this.reason = reason;
  }
}

/** Failure classes where a second attempt would fail for the same reason. */
const NON_RETRYABLE = /^(MODEL_|TASK_DOCUMENT_|GATE_NOT_IMPLEMENTED)/;

function iso(): string {
  return new Date().toISOString();
}

function git(repo: string, args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 60_000, maxBuffer: 4_000_000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out: (out ?? '').trim() };
  } catch (error: any) {
    return { code: typeof error.status === 'number' ? error.status : 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}`.trim() };
  }
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\([nrt"\\])/g, (_match, code: string) => ({ n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' })[code] ?? code);
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  return trimmed;
}

/** Every path git currently reports, split into tracked-changes and untracked. */
function treePaths(repo: string): { tracked: Set<string>; untracked: Set<string> } {
  const tracked = new Set<string>();
  const untracked = new Set<string>();
  const porcelain = git(repo, ['status', '--porcelain']);
  for (const line of porcelain.out.split('\n')) {
    if (!line.trim()) continue;
    const xy = line.slice(0, 2);
    const file = unquote(line.slice(3));
    if (xy === '??') untracked.add(file);
    else tracked.add(file);
  }
  return { tracked, untracked };
}

/**
 * Puts the tree back where the attempt found it. Unstaging is not discarding: tracked changes
 * the attempt made are restored to HEAD, and files the attempt created (including anything the
 * verification command left behind) are removed only if they did not exist before the attempt.
 * Files that existed before the run are untouched — the loop refuses to start on a dirty tree,
 * so anything new arrived during the run.
 */
function rollback(repo: string, before: { tracked: Set<string>; untracked: Set<string> }): void {
  git(repo, ['reset', '-q', 'HEAD', '--', '.']);
  git(repo, ['checkout', '--', '.']);
  const after = treePaths(repo);
  for (const file of after.untracked) {
    if (before.untracked.has(file)) continue;
    const target = path.join(repo, file);
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      // A path that cannot be removed leaves the tree dirty, which the next attempt's
      // clean-tree gate reports by name rather than hiding.
    }
  }
  for (const file of after.tracked) {
    if (before.tracked.has(file)) continue;
    git(repo, ['checkout', '--', file]);
  }
}

/** Deterministic dependency order, preserving document order among independent units. */
function orderedUnits(units: WorkUnit[]): WorkUnit[] {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const placed = new Set<string>();
  const out: WorkUnit[] = [];
  const pending = [...units];
  while (pending.length) {
    const next = pending.find((unit) => unit.dependsOn.every((dep) => placed.has(dep) || !byId.has(dep)));
    if (!next) throw parseRefusal(`unit dependency cycle between: ${pending.map((unit) => unit.id).join(', ')}`);
    pending.splice(pending.indexOf(next), 1);
    placed.add(next.id);
    out.push(next);
  }
  return out;
}

function parseRefusal(detail: string): Error {
  return new Error(`TASK_DOCUMENT_INVALID:${detail}`);
}

/** Verification commands for one unit: its own declaration, else the repository's profile. */
function verifyCommands(unit: WorkUnit, repo: string): Array<{ id: string; command: string }> {
  if ((unit.verify ?? '').trim()) return [{ id: `unit-${unit.id}`, command: unit.verify!.trim() }];
  const profile = detectVerificationProfile(repo);
  return profile.steps.map((step) => ({ id: `${profile.id}-${step.id}`, command: `${step.executable} ${step.args.join(' ')}`.trim() }));
}

function gateIdsFrom(message: string): string[] {
  const parts = message.split(':');
  return parts[0] === 'GATE_REFUSED' && parts[2] ? parts[2].split(',') : [];
}

/** Refusals that must end the run instead of being retried into the attempt cap. */
const HALTING_GATES = new Set(['resource-admission', 'doctrine-integrity', 'doctrine-isolation']);

function tail(text: string, limit = 2000): string {
  return text.length > limit ? `…${text.slice(-limit)}` : text;
}

export class ExecutionLoopService {
  public static getRun(runId: string): LoopRunRecord | undefined {
    return DurableStore.get('factoryLoopRuns', runId) as unknown as LoopRunRecord | undefined;
  }

  public static listRuns(): LoopRunRecord[] {
    return DurableStore.list('factoryLoopRuns') as unknown as LoopRunRecord[];
  }

  public static async run(options: LoopRunOptions): Promise<LoopRunOutcome> {
    const startedAtMs = Date.now();
    const doctrine = DoctrineService.load();
    const loop = doctrine.loop;

    if (loop.concurrency.execution !== 'sequential') throw new Error(`EXECUTION_MODE_UNSUPPORTED:${loop.concurrency.execution}`);
    assertRegistryComplete();

    const repo = path.resolve(options.repo);
    const tenantId = options.tenantId ?? 'default';
    const attemptCap = Math.min(Math.max(1, options.attemptCap ?? loop.attempt.maxPerUnit), loop.attempt.maxPerUnit);

    // The loop only starts where it can reason about every change: the run is the only writer.
    if (!options.resumeRunId) {
      const starting = treePaths(repo);
      if (starting.tracked.size || starting.untracked.size) {
        throw new Error(`REPO_NOT_CLEAN:${[...starting.tracked, ...starting.untracked].slice(0, 8).join(', ')}`);
      }
    }

    const isolation = DoctrineIsolationService.stage(repo, options.env ?? {});
    const document = loadTaskDocument(path.resolve(options.taskDocument));
    const units = decompose(document, { maxAcceptanceCriteriaPerMilestone: loop.unit.maxAcceptanceCriteriaPerMilestone });
    const assignments = DoctrineService.allAssignments(document.models);
    const tenantProviders = new Set(FrontierModelService.list(tenantId).map((provider) => provider.id));

    const record = options.resumeRunId
      ? this.resume(options.resumeRunId, document.sourceHash, doctrine.digest, repo)
      : this.fresh(repo, document.sourceHash, document.sourcePath ?? options.taskDocument, {
          tenantId,
          attemptCap,
          execution: loop.concurrency.execution,
          quarantineCount: isolation.quarantine.length,
          models: assignments,
          units,
        });

    // The live stream opens before any work starts: an operator tails this file to tell a run
    // that is working from one that is stuck, from the very first gate check.
    const eventsPath = this.openEventStream(record, path.resolve(options.reportDir ?? defaultReportDir()));
    options.onStart?.(eventsPath);

    const persist = (): void => {
      DurableStore.upsert('factoryLoopRuns', record.runId, record as unknown as Record<string, unknown>);
    };
    const event = (level: LoopEvent['level'], stage: LoopEvent['stage'], message: string): void => {
      const entry = { at: iso(), stage, level, message };
      record.events.push(entry);
      try {
        fs.appendFileSync(eventsPath, `${JSON.stringify(entry)}\n`, 'utf8');
      } catch {
        // The ledger still carries the event; the stream is a convenience, not the record.
      }
      options.onEvent?.(entry);
    };
    const baseContext = (): Omit<GateContext, 'stage' | 'timing'> => ({ repo, isolation, run: record, tenantProviders });

    const enterStage = (stage: LoopStage, timing: 'before' | 'after', extra: Partial<GateContext> = {}): GateResult[] => {
      const outcome = runStageGates(stage, timing, { ...baseContext(), ...extra });
      record.gates.push(...outcome.results);
      const refused = outcome.results.filter((item) => !item.passed);
      event(
        refused.length ? 'warn' : 'info',
        stage,
        refused.length
          ? `gate(s) ${refused.map((item) => item.id).join(', ')} refused at ${stage}.${timing}`
          : `${outcome.results.length} gate(s) passed at ${stage}.${timing}`,
      );
      persist();
      if (!outcome.ok) {
        const detail = outcome.refusals.map((item) => `${item.id}: ${item.detail}`).join(' | ');
        throw new Error(`GATE_REFUSED:${stage}:${outcome.refusals.map((item) => item.id).join(',')}:${detail}`);
      }
      return outcome.results;
    };

    const checkHardStop = (): void => {
      const elapsedMinutes = (Date.now() - startedAtMs) / 60_000;
      if (elapsedMinutes > loop.hardStop.maxWallClockMinutes) throw new LoopHardStop(`wall-clock after ${elapsedMinutes.toFixed(1)}m (cap ${loop.hardStop.maxWallClockMinutes}m)`);
      const attempts = record.units.reduce((total, unit) => total + unit.attempts.length, 0);
      if (attempts > loop.hardStop.maxTotalAttempts) throw new LoopHardStop(`total attempts ${attempts} exceed ${loop.hardStop.maxTotalAttempts}`);
      if (record.commits.length > loop.hardStop.maxCommits) throw new LoopHardStop(`commits ${record.commits.length} exceed ${loop.hardStop.maxCommits}`);
      if (loop.hardStop.doctrineIntegrity && !DoctrineService.verifyManifest().ok) throw new LoopHardStop('doctrine manifest no longer matches');
      if (loop.hardStop.resourceExhaustion) {
        const admission = ResourceGovernorService.admit(1);
        if (!admission.admitted) throw new LoopHardStop(`resource exhaustion: ${admission.reasons.join('; ')}`);
      }
    };

    let lastProof: GroundTruthProof | undefined;
    let refusal: string | undefined;
    let hardStop: string | undefined;

    // ── PLAN ────────────────────────────────────────────────────────────────
    try {
      checkHardStop();
      enterStage('plan', 'before');
      enterStage('plan', 'after', { units });
      event('info', 'plan', `plan accepted: ${units.length} unit(s), attempt cap ${attemptCap}, doctrine ${record.doctrineDigest.slice(0, 19)}…`);
    } catch (error) {
      if (error instanceof LoopHardStop) hardStop = error.reason;
      else refusal = (error as Error).message;
    }
    persist();

    // ── IMPLEMENT / VERIFY / COMMIT, one unit at a time ─────────────────────
    if (!refusal && !hardStop) {
      try {
        for (const unit of orderedUnits(units)) {
          const unitRecord = record.units.find((item) => item.unitId === unit.id)!;
          if (unitRecord.status === 'done' || unitRecord.status === 'stuck') continue;

          const unmet = unit.dependsOn.filter((dep) => record.units.find((item) => item.unitId === dep)?.status !== 'done');
          if (unmet.length) {
            unitRecord.status = 'blocked';
            unitRecord.blockedBy = unmet.join(', ');
            event('warn', 'plan', `unit ${unit.id} is blocked by ${unitRecord.blockedBy}`);
            persist();
            continue;
          }

          checkHardStop();
          const proof = await this.runUnit({
            repo,
            tenantId,
            document,
            unit,
            unitRecord,
            record,
            isolation,
            attemptCap,
            loop,
            tenantProviders,
            onGateResults: (results) => record.gates.push(...results),
            persist,
            event,
            checkHardStop,
          });
          if (proof) lastProof = proof;
        }

        // ── REPORT ─────────────────────────────────────────────────────────
        // The report is audited against a real proof: the one this run produced, or the one a
        // previous session stored with the commit it verified. A run that verified nothing has
        // no evidence to audit and claims none.
        enterStage('report', 'before');
        const reportProof = lastProof ?? lastStoredProof(record);
        const outcome = runStageGates('report', 'after', { ...baseContext(), proof: reportProof });
        record.gates.push(...outcome.results);
        if (!outcome.ok) hardStop = `report-gate:${outcome.refusals.map((item) => item.id).join(',')}`;
      } catch (error) {
        if (error instanceof LoopHardStop) hardStop = error.reason;
        else hardStop = `run-error:${tail((error as Error).message, 400)}`;
        event('error', 'run', `run stopped: ${hardStop}`);
      }
    }

    record.finishedAt = iso();
    record.hardStop = hardStop;
    record.refusal = refusal;
    if (hardStop) record.status = 'halted';
    else if (refusal) record.status = 'refused';
    else record.status = 'completed';
    persist();

    const reportFiles = this.writeReport(record, options.reportDir);
    const exitCode: 0 | 2 | 3 = hardStop ? 3 : record.units.some((unit) => unit.status !== 'done') ? 2 : 0;
    return { record, reportFiles, eventsPath, exitCode };
  }

  // ── one unit: its attempts, its rollback, its one commit ─────────────────

  private static async runUnit(input: {
    repo: string;
    tenantId: string;
    document: ReturnType<typeof loadTaskDocument>;
    unit: WorkUnit;
    unitRecord: UnitRecord;
    record: LoopRunRecord;
    isolation: IsolationManifest;
    attemptCap: number;
    loop: ReturnType<typeof DoctrineService.load>['loop'];
    tenantProviders: Set<string>;
    onGateResults: (results: GateResult[]) => void;
    persist: () => void;
    event: (level: LoopEvent['level'], stage: LoopEvent['stage'], message: string) => void;
    checkHardStop: () => void;
  }): Promise<GroundTruthProof | undefined> {
    const { repo, unit, unitRecord, record, isolation, attemptCap, loop, tenantProviders } = input;
    unitRecord.status = 'running';
    unitRecord.startedAt = unitRecord.startedAt ?? iso();
    input.event('info', 'run', `unit ${unit.id} started — ${unit.title}`);
    input.persist();

    let feedback: string | undefined;
    let succeeded = false;
    let proof: GroundTruthProof | undefined;
    // Record a commit exactly once per run, wherever the flow reaches it (immediate checkpoint,
    // success block, or the keep-the-commit catch path).
    const recordCommit = (unitId: string, sha: string, subject: string): void => {
      if (!record.commits.some((item) => item.sha === sha)) record.commits.push({ unitId, sha, subject });
    };

    while (unitRecord.attempts.length < attemptCap && !succeeded) {
      const attempt: AttemptRecord = {
        attempt: unitRecord.attempts.length + 1,
        startedAt: iso(),
        finishedAt: iso(),
        stage: 'implement',
        passed: false,
        reason: '',
        detail: '',
      };
      unitRecord.attempts.push(attempt);
      input.event('info', 'implement', `unit ${unit.id} attempt ${attempt.attempt}/${attemptCap} starting`);
      // A run is the only writer of this tree, so an interrupted attempt's residue is not
      // evidence. Start every attempt from the committed state so half-written files from a
      // killed attempt can never leak into the next one.
      rollback(repo, { tracked: new Set<string>(), untracked: new Set<string>() });
      const before = treePaths(repo);
      let committed: { sha: string; subject: string } | undefined;

      try {
        input.checkHardStop();

        // ── IMPLEMENT ─────────────────────────────────────────────────────
        const assignment = DoctrineService.modelFor('implementer', input.document.models);
        const enter = (stage: LoopStage, timing: 'before' | 'after', extra: Partial<GateContext> = {}): void => {
          const outcome = runStageGates(stage, timing, { repo, isolation, run: record, tenantProviders, unit: unitRecord, ...extra });
          record.gates.push(...outcome.results);
          const refused = outcome.results.filter((item) => !item.passed);
          input.event(
            refused.length ? 'warn' : 'info',
            stage,
            refused.length
              ? `gate(s) ${refused.map((item) => item.id).join(', ')} refused at ${stage}.${timing}`
              : `${outcome.results.length} gate(s) passed at ${stage}.${timing}`,
          );
          if (!outcome.ok) {
            const detail = outcome.refusals.map((item) => `${item.id}: ${item.detail}`).join(' | ');
            throw new Error(`GATE_REFUSED:${stage}:${outcome.refusals.map((item) => item.id).join(',')}:${detail}`);
          }
        };

        enter('implement', 'before', { taskOverrides: input.document.models });
        const result = await ImplementerService.implement({
          tenantId: input.tenantId,
          repo,
          unit,
          document: input.document,
          assignment,
          doctrineLines: DoctrineService.rules().map((rule) => `${rule.id}: ${rule.statement}`),
          isolation,
          timeoutMs: loop.verification.timeoutMs,
          feedback,
        });
        const claimed = result.files.map((file) => {
          const target = resolveFileWithin(repo, file.path, 'IMPLEMENTER_PATH_INVALID');
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, file.content, 'utf8');
          return file.path;
        });
        if (!claimed.length) throw new Error('IMPLEMENTER_OUTPUT_EMPTY:no files were returned for this unit');

        attempt.stage = 'implement';
        const claimedProof = collectGroundTruth({
          repo,
          claimedFiles: claimed,
          requireNonEmptyDiff: true,
          narratedClaims: [result.narration],
          timeoutMs: loop.verification.timeoutMs,
          env: childEnv(isolation),
        });
        enter('implement', 'after', { proof: claimedProof });

        // ── VERIFY ────────────────────────────────────────────────────────
        attempt.stage = 'verify';
        enter('verify', 'before');
        const commands = verifyCommands(unit, repo);
        proof = collectGroundTruth({
          repo,
          claimedFiles: claimed,
          requireNonEmptyDiff: true,
          commands,
          narratedClaims: [result.narration],
          timeoutMs: loop.verification.timeoutMs,
          env: childEnv(isolation),
        });
        record.narrationRejected += proof.rejectedNarration.length;
        enter('verify', 'after', { proof });

        // ── REVIEW ────────────────────────────────────────────────────────
        // Between "it verifies" and "it ships" sits an adversarial read. The reviewer answers
        // only `{approved, findings}`; the `review-approve` gate turns a no into a refused
        // attempt, and the findings become the next attempt's feedback.
        attempt.stage = 'review';
        const reviewAssignment = DoctrineService.modelFor('reviewer', input.document.models);
        enter('review', 'before', { taskOverrides: input.document.models, usedRoles: ['reviewer'] });
        const review = await ReviewService.review({
          tenantId: input.tenantId,
          repo,
          unit,
          document: input.document,
          assignment: reviewAssignment,
          doctrineLines: DoctrineService.rules().map((rule) => `${rule.id}: ${rule.statement}`),
          isolation,
          proof,
          timeoutMs: loop.verification.timeoutMs,
          feedback,
        });
        attempt.review = { approved: review.approved, findings: review.findings, reviewer: `${review.providerId}/${review.model}` };
        enter('review', 'after', { proof, review });

        // ── COMMIT ────────────────────────────────────────────────────────
        attempt.stage = 'commit';
        const headBefore = git(repo, ['rev-parse', 'HEAD']).out;
        enter('commit', 'before', { proof });
        const commit = commitUnit({
          repo,
          type: unit.type,
          scope: unit.milestoneId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unit',
          title: unit.title,
          proof,
          unitId: unit.id,
          attempt: attempt.attempt,
          models: record.models,
          loopVersion: readLoopVersion(),
          review: attempt.review,
          refusePathPatterns: loop.commit.refusePathPatterns,
          requireGroundTruth: loop.commit.requireGroundTruth,
          requireProvenanceFooter: loop.commit.requireProvenanceFooter,
          subjectMaxLength: loop.commit.subjectMaxLength,
        });
        committed = { sha: commit.sha, subject: commit.subject };
        // The commit is the durable fact. Checkpoint it now, before any further gate can run,
        // so a kill between here and the success block never loses the commit or re-creates it.
        recordCommit(unit.id, commit.sha, commit.subject);
        unitRecord.commitSha = commit.sha;
        unitRecord.commitSubject = commit.subject;
        input.persist();
        const headAfter = git(repo, ['rev-parse', 'HEAD']).out;
        const range = git(repo, ['rev-list', '--count', `${headBefore}..${headAfter}`]).out;
        enter('commit', 'after', { proof, commitsInUnit: Number(range) || 0 });

        // ── the unit is done ──────────────────────────────────────────────
        succeeded = true;
        attempt.passed = true;
        attempt.reason = 'verified';
        attempt.detail = `${commands.length} verification command(s) exited 0`;
        attempt.proofDigest = proofDigest(proof);
        unitRecord.status = 'done';
        unitRecord.commitSha = commit.sha;
        unitRecord.commitSubject = commit.subject;
        unitRecord.proofDigest = attempt.proofDigest;
        unitRecord.proof = slimProof(proof);
        unitRecord.finishedAt = iso();
        recordCommit(unit.id, commit.sha, commit.subject);
        input.event('info', 'commit', `unit ${unit.id} committed ${commit.sha.slice(0, 12)} — ${commit.subject}`);
      } catch (error) {
        const message = (error as Error).message;
        attempt.reason = message.split(':')[0] || 'UNKNOWN';
        attempt.detail = tail(message);
        if (proof && !attempt.proofDigest) attempt.outputTail = tail(proof.checks.filter((check) => !check.passed).map((check) => `${check.id}: ${check.outputTail ?? ''}`).join('\n'), 4000);
        feedback = tail(message, 2000);
        input.event('warn', attempt.stage, `unit ${unit.id} attempt ${attempt.attempt} refused at ${attempt.stage}: ${tail(message, 300)}`);

        const halting = gateIdsFrom(message).some((id) => HALTING_GATES.has(id));
        const nonRetryable = NON_RETRYABLE.test(message);

        // A commit that already landed is evidence, not something to erase. Keep it and stop.
        if (committed) {
          recordCommit(unit.id, committed.sha, committed.subject);
          unitRecord.commitSha = committed.sha;
          unitRecord.commitSubject = committed.subject;
          unitRecord.proofDigest = proof ? proofDigest(proof) : undefined;
        } else {
          rollback(repo, before);
        }

        if (halting) throw new LoopHardStop(`${unit.id}: ${tail(message, 400)}`);

        if (nonRetryable) {
          unitRecord.status = 'stuck';
          unitRecord.finishedAt = iso();
          input.event('error', attempt.stage, `unit ${unit.id} is stuck: ${attempt.detail}`);
        } else if (unitRecord.attempts.length >= attemptCap) {
          unitRecord.status = 'stuck';
          unitRecord.finishedAt = iso();
          input.event('error', attempt.stage, `unit ${unit.id} is stuck after ${attemptCap} attempt(s): ${attempt.detail}`);
        }
      } finally {
        attempt.finishedAt = iso();
        input.persist();
      }
    }

    if (!succeeded && unitRecord.status === 'running') {
      unitRecord.status = 'stuck';
      unitRecord.finishedAt = iso();
    }
    input.persist();
    return succeeded ? proof : undefined;
  }

  // ── run record lifecycle ────────────────────────────────────────────────

  /**
   * Opens the live event stream for the run. Rewrites it with the run's recorded history so a
   * resumed run appends to the same file an operator was already tailing.
   */
  private static openEventStream(record: LoopRunRecord, reportDir: string): string {
    fs.mkdirSync(reportDir, { recursive: true });
    const eventsPath = path.join(reportDir, `${record.runId}.events.jsonl`);
    fs.writeFileSync(eventsPath, record.events.map((entry) => `${JSON.stringify(entry)}\n`).join(''), 'utf8');
    record.eventsPath = eventsPath;
    return eventsPath;
  }

  private static fresh(repo: string, documentHash: string, taskDocument: string, input: {
    tenantId: string;
    attemptCap: number;
    execution: 'sequential' | 'worktree-parallel';
    quarantineCount: number;
    models: ReturnType<typeof DoctrineService.allAssignments>;
    units: WorkUnit[];
  }): LoopRunRecord {
    const now = iso();
    const runId = `looprun_${crypto.createHash('sha256').update(`${repo}:${taskDocument}:${now}:${crypto.randomBytes(6).toString('hex')}`).digest('hex').slice(0, 24)}`;
    const record: LoopRunRecord = {
      runId,
      status: 'running',
      startedAt: now,
      repo,
      taskDocument,
      taskDocumentHash: documentHash,
      doctrineDigest: DoctrineService.digest(),
      execution: input.execution,
      attemptCap: input.attemptCap,
      tenantId: input.tenantId,
      quarantineCount: input.quarantineCount,
      units: input.units.map((unit): UnitRecord => ({
        unitId: unit.id,
        milestoneId: unit.milestoneId,
        title: unit.title,
        type: unit.type,
        criteria: unit.criteria,
        verify: unit.verify,
        dependsOn: unit.dependsOn,
        status: 'pending',
        attempts: [],
      })),
      commits: [],
      gates: [],
      events: [],
      models: input.models,
      narrationRejected: 0,
    };
    DurableStore.upsert('factoryLoopRuns', runId, record as unknown as Record<string, unknown>);
    return record;
  }

  private static resume(runId: string, documentHash: string, doctrineDigest: string, repo: string): LoopRunRecord {
    const existing = this.getRun(runId);
    if (!existing) throw new Error(`LOOP_RUN_NOT_FOUND:${runId}`);
    if (existing.taskDocumentHash !== documentHash) throw new Error(`LOOP_RUN_INCOMPATIBLE:${runId}: the task document changed since this run started`);
    if (existing.doctrineDigest !== doctrineDigest) throw new Error(`LOOP_RUN_INCOMPATIBLE:${runId}: the doctrine changed since this run started`);
    if (existing.repo !== repo) throw new Error(`LOOP_RUN_INCOMPATIBLE:${runId}: the run belongs to another repository`);
    if (existing.status !== 'halted' && existing.status !== 'running') throw new Error(`LOOP_RUN_INCOMPATIBLE:${runId}: run is already ${existing.status}`);
    // If the run was killed mid-work, it left residue: half-written files, staged changes. The
    // run is the only writer of this tree, so that residue is not evidence — restore the tree to
    // the last committed state, loudly, so no interrupted attempt leaks into the next one.
    const starting = treePaths(repo);
    const dirty = [...starting.tracked, ...starting.untracked];
    if (dirty.length) {
      rollback(repo, { tracked: new Set<string>(), untracked: new Set<string>() });
      existing.restoredOnResume = { at: iso(), paths: dirty.slice(0, 200) };
      existing.events.push({
        at: iso(),
        stage: 'run',
        level: 'warn',
        message: `resumed run was interrupted mid-work; restored ${dirty.length} path(s) to the last committed state`,
      });
    }
    this.reconcileDanglingCommit(repo, existing);
    existing.status = 'running';
    existing.finishedAt = undefined;
    existing.hardStop = undefined;
    for (const unit of existing.units) {
      // An interrupted unit never committed: its attempts stand, its work is re-done.
      if (unit.status === 'running') unit.status = 'pending';
    }
    DurableStore.upsert('factoryLoopRuns', existing.runId, existing as unknown as Record<string, unknown>);
    return existing;
  }

  /**
   * A kill that lands between `git commit` and the checkpointed persist leaves a run whose unit
   * says "running" while the commit already sits on HEAD. Never duplicate that commit: reconcile
   * it as done, using the machine-derived Proof digest the commit body itself records, and name
   * that the commit was not re-made.
   */
  private static reconcileDanglingCommit(repo: string, record: LoopRunRecord): void {
    const interrupted = record.units.filter((unit) => unit.status === 'running');
    if (!interrupted.length) return;
    const head = git(repo, ['rev-parse', 'HEAD']);
    if (head.code !== 0 || !head.out) return;
    const message = git(repo, ['log', '-1', '--format=%B']);
    if (message.code !== 0) return;
    const unitMatch = message.out.match(/^Unit: (\S+)/m);
    const digest = message.out.match(/^Proof: (sha256:[0-9a-f]{64})/m);
    if (!unitMatch || !digest) return;
    const unit = interrupted.find((item) => item.unitId === unitMatch[1]);
    if (!unit) return;
    const subject = git(repo, ['log', '-1', '--format=%s']).out;
    unit.status = 'done';
    unit.commitSha = head.out;
    unit.commitSubject = subject;
    unit.proofDigest = digest[1];
    unit.finishedAt = iso();
    const attempt = unit.attempts.at(-1);
    if (attempt) {
      attempt.passed = true;
      attempt.reason = 'reconciled-on-resume';
      attempt.detail = 'the commit for this unit was found on HEAD with its Proof digest; it was not re-committed';
    }
    if (!record.commits.some((item) => item.sha === head.out)) {
      record.commits.push({ unitId: unit.unitId, sha: head.out, subject });
    }
    record.events.push({
      at: iso(),
      stage: 'run',
      level: 'info',
      message: `unit ${unit.unitId} reconciled as done: its commit was found on HEAD (${head.out.slice(0, 12)}) with Proof ${digest[1]}`,
    });
  }

  // ── the report ──────────────────────────────────────────────────────────

  public static writeReport(record: LoopRunRecord, reportDir?: string): { markdown: string; json: string } {
    const dir = path.resolve(reportDir ?? defaultReportDir());
    fs.mkdirSync(dir, { recursive: true });
    const stem = path.join(dir, record.runId);
    fs.writeFileSync(`${stem}.json`, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    fs.writeFileSync(`${stem}.md`, renderReport(record), 'utf8');
    return { markdown: `${stem}.md`, json: `${stem}.json` };
  }
}

function defaultReportDir(): string {
  if ((process.env.FACTORY_LOOP_REPORT_DIR ?? '').trim()) return process.env.FACTORY_LOOP_REPORT_DIR!.trim();
  return path.join(path.dirname(DurableStore.dataFile()), 'loop-runs');
}

/** The environment every process this loop spawns receives. Scrubbed, doctrine-stamped. */
function childEnv(isolation: IsolationManifest): NodeJS.ProcessEnv {
  return isolation.childEnv as NodeJS.ProcessEnv;
}

/** The proof attached to the newest commit this run (or a previous session) recorded. */
function lastStoredProof(record: LoopRunRecord): ReturnType<typeof widenProof> | undefined {
  for (let index = record.units.length - 1; index >= 0; index -= 1) {
    const unit = record.units[index];
    if (unit.proof) return widenProof(unit.proof);
  }
  return undefined;
}

function renderReport(record: LoopRunRecord): string {
  const attempts = record.units.reduce((total, unit) => total + unit.attempts.length, 0);
  const refused = record.gates.filter((gate) => !gate.passed);
  const lines: string[] = [
    `# Loop run ${record.runId}`,
    '',
    `**Status:** ${record.status.toUpperCase()}${record.hardStop ? ` — hard stop: ${record.hardStop}` : ''}${record.refusal ? ` — refused to start: ${record.refusal}` : ''}`,
    '',
    `| | |`,
    `|---|---|`,
    `| Repository | \`${record.repo}\` |`,
    `| Task document | \`${record.taskDocument}\` (${record.taskDocumentHash}) |`,
    `| Doctrine | \`${record.doctrineDigest}\` |`,
    `| Execution | ${record.execution} |`,
    `| Attempt cap | ${record.attemptCap} per unit |`,
    `| Started | ${record.startedAt} |`,
    `| Finished | ${record.finishedAt ?? '—'} |`,
    `| Quarantined instruction files | ${record.quarantineCount} |`,
    `| Event stream | \`${record.eventsPath ?? '—'}\` |`,
    `| Resume restoration | ${record.restoredOnResume ? `${record.restoredOnResume.paths.length} path(s) restored from an interrupted attempt` : '—'} |`,
    `| Narration claims discarded | ${record.narrationRejected} |`,
    '',
    '## Units',
    '',
    '| Unit | Status | Attempts | Commit | Verify |',
    '|---|---|---|---|---|',
    ...record.units.map((unit) => {
      const verify = unit.verify ?? '(repository profile)';
      return `| ${unit.unitId} | ${unit.status}${unit.blockedBy ? ` (by ${unit.blockedBy})` : ''} | ${unit.attempts.length}/${record.attemptCap} | ${unit.commitSha ? `\`${unit.commitSha.slice(0, 12)}\` ${unit.commitSubject ?? ''}` : '—'} | \`${verify.slice(0, 60)}\` |`;
    }),
    '',
    '## Commits',
    '',
    ...(record.commits.length ? record.commits.map((commit) => `- \`${commit.sha.slice(0, 12)}\` ${commit.subject} _(${commit.unitId})_`) : ['- none']),
    '',
    '## Attempt log',
    '',
    ...(attempts
      ? record.units.flatMap((unit) => unit.attempts.map((attempt) => `- **${unit.unitId}** attempt ${attempt.attempt} @ ${attempt.stage}: ${attempt.passed ? 'passed' : `failed (${attempt.reason})`} — ${attempt.detail.slice(0, 300)}`))
      : ['- no attempt was made']),
    '',
    '## Gates',
    '',
    `Executed ${record.gates.length} gate check(s); ${refused.length} refused.`,
    '',
    ...(refused.length ? refused.map((gate) => `- ❌ **${gate.id}** (${gate.stage}.${gate.timing}) ${gate.detail}`) : ['- no refusal']),
    '',
    '## Models',
    '',
    ...record.models.map((model) => `- ${model.role} → \`${model.providerId}/${model.model}\` (${model.source})`),
    '',
    '## Events',
    '',
    ...record.events.slice(-100).map((entry) => `- ${entry.at} [${entry.level}] ${entry.stage}: ${entry.message}`),
    '',
    '---',
    '',
    'Evidence in this report is derived from recorded checks. Nothing here is the model\'s own word.',
    '',
  ];
  return lines.join('\n');
}
