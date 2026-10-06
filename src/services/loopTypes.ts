/**
 * Shared shapes for the unattended loop.
 *
 * Kept in its own module so the gate registry and the driver can both describe a run without
 * importing each other — a cycle between the two is exactly how a gate ends up not running.
 */
import { proofDigest, type GroundTruthProof } from './groundTruthService';
import type { ModelAssignment } from './doctrineService';

export type LoopStage = 'plan' | 'implement' | 'verify' | 'commit' | 'report';

export type UnitStatus = 'pending' | 'running' | 'done' | 'stuck' | 'blocked';

export interface AttemptRecord {
  attempt: number;
  startedAt: string;
  finishedAt: string;
  /** The last stage the attempt reached before it failed. */
  stage: LoopStage;
  passed: boolean;
  /** Machine-readable reason: a gate id, a refusal code, or a check id. */
  reason: string;
  detail: string;
  proofDigest?: string;
  /** Bounded tail of the failing command's output, for the operator reading the report. */
  outputTail?: string;
}

export interface UnitRecord {
  unitId: string;
  milestoneId: string;
  title: string;
  type: string;
  criteria: Array<{ id: string; text: string; check?: string }>;
  verify?: string;
  dependsOn: string[];
  status: UnitStatus;
  attempts: AttemptRecord[];
  commitSha?: string;
  commitSubject?: string;
  proofDigest?: string;
  /** The proof this unit was committed under, kept so a resumed run can still be audited. */
  proof?: SlimProof;
  blockedBy?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface GateResult {
  id: string;
  stage: LoopStage;
  timing: 'before' | 'after';
  passed: boolean;
  blocking: boolean;
  detail: string;
  checkedAt: string;
}

export type LoopStatus = 'running' | 'completed' | 'halted' | 'refused';

export interface LoopEvent {
  at: string;
  stage: LoopStage | 'run';
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface LoopRunRecord {
  runId: string;
  status: LoopStatus;
  startedAt: string;
  finishedAt?: string;
  repo: string;
  taskDocument: string;
  taskDocumentHash: string;
  doctrineDigest: string;
  execution: 'sequential' | 'worktree-parallel';
  attemptCap: number;
  tenantId: string;
  quarantineCount: number;
  units: UnitRecord[];
  /** HEADs created by this run, in order. */
  commits: Array<{ unitId: string; sha: string; subject: string }>;
  gates: GateResult[];
  events: LoopEvent[];
  models: ModelAssignment[];
  hardStop?: string;
  refusal?: string;
  /** Number of narration claims recorded and discarded across the run. */
  narrationRejected: number;
}

export interface SlimCheck {
  id: string;
  kind: 'tree' | 'diff' | 'command';
  command?: string;
  exitCode: number;
  passed: boolean;
  outputDigest?: string;
  startedAt: string;
  completedAt: string;
}

/**
 * A proof with its output tails removed.
 *
 * The tail is the raw text of a failing command: useful in the attempt record, wrong to
 * duplicate into the ledger for every committed unit. Everything the evidence gate checks —
 * command, exit code, timing, digest — survives the reduction.
 */
export interface SlimProof {
  passed: boolean;
  repo: string;
  head: string;
  checks: SlimCheck[];
  claimedFiles: string[];
  observedFiles: string[];
  rejectedNarration: string[];
  recordedAt: string;
  digest: string;
}

export function slimProof(proof: GroundTruthProof): SlimProof {
  return {
    passed: proof.passed,
    repo: proof.repo,
    head: proof.head,
    checks: proof.checks.map((check) => ({
      id: check.id,
      kind: check.kind,
      command: check.command,
      exitCode: check.exitCode,
      passed: check.passed,
      outputDigest: check.outputDigest,
      startedAt: check.startedAt,
      completedAt: check.completedAt,
    })),
    claimedFiles: [...proof.claimedFiles],
    observedFiles: [...proof.observedFiles],
    rejectedNarration: [...proof.rejectedNarration],
    recordedAt: proof.recordedAt,
    digest: proofDigest(proof),
  };
}

export function widenProof(slim: SlimProof): GroundTruthProof {
  return {
    passed: slim.passed,
    repo: slim.repo,
    head: slim.head,
    checks: slim.checks.map((check) => ({ ...check, outputTail: '' })),
    claimedFiles: [...slim.claimedFiles],
    observedFiles: [...slim.observedFiles],
    rejectedNarration: [...slim.rejectedNarration],
    recordedAt: slim.recordedAt,
  };
}
