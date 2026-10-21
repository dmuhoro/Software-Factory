/**
 * Durable failure classification for the unattended loop (Sprint 29, WP-3).
 *
 * A run records *why* an attempt failed as a free-text reason (`AttemptRecord.reason`, the first
 * token of the thrown refusal) plus a truncated detail. That is enough for a human and useless for
 * a count: nothing can answer "how often does this repository fail verification versus fail review
 * versus hit a policy gate" without a machine-readable class. ADR-012 turns the recorded outcomes
 * into a bounded digest, and a class must exist before it can be counted.
 *
 * This classifier is pure: no LLM, no clock, no randomness, no I/O. It reads the refusal code, the
 * stage the attempt reached, the gate ids a `GATE_REFUSED` carries, and the full message, and
 * returns one class. Every gate id in the registry must map to a class — `test/loop-failure-class`
 * fails if one does not — and an unrecognized refusal is `unknown`, never guessed.
 *
 * The class type lives here and is imported (type-only) by `loopTypes`; nothing here imports a
 * runtime value from the loop, so there is no cycle.
 */
import { GATE_IDS } from './gateIds';
import type { LoopStage } from './loopTypes';

export type LoopFailureClass =
  | 'security'
  | 'verification'
  | 'review'
  | 'model'
  | 'environment'
  | 'policy'
  | 'defect'
  | 'unknown';

/** Stable priority order: a tie between class counts is broken by this order (most severe first). */
export const LOOP_FAILURE_CLASSES: readonly LoopFailureClass[] = [
  'security',
  'verification',
  'review',
  'model',
  'defect',
  'environment',
  'policy',
  'unknown',
];

/**
 * Every gate id maps to exactly one class. The registry-completeness test asserts this covers
 * `GATE_IDS` exactly, so a new gate cannot be added without classifying its refusals.
 *
 * - `ground-truth` is the declared-check failure: verification.
 * - `claimed-files-exist` judges the implementer's own claims against the tree: a model fault.
 * - `review-approve` is the reviewer's refusal: review.
 * - `secret-scan`, `doctrine-integrity`, `doctrine-isolation` are the security gates.
 * - `resource-admission` is the host's capacity: environment.
 * - the rest are policy gates — the loop's own rules refusing a change.
 */
export const GATE_FAILURE_CLASSES: Record<string, LoopFailureClass> = {
  'ground-truth': 'verification',
  'claimed-files-exist': 'model',
  'no-op-unit': 'policy',
  'review-approve': 'review',
  'secret-scan': 'security',
  'doctrine-integrity': 'security',
  'doctrine-isolation': 'security',
  'resource-admission': 'environment',
  'clean-tree': 'policy',
  'one-commit-per-unit': 'policy',
  'verified-commit-message': 'policy',
  'evidence-is-machine-derived': 'policy',
  'model-assignment': 'policy',
  'attempt-cap': 'policy',
  'plan-is-executable': 'policy',
  'unrelated-writes': 'policy',
  'bug-diagnosis-evidence': 'defect',
};

/** Non-gate refusal codes (the first token of a thrown message) and the class each denotes. */
const REASON_PATTERNS: ReadonlyArray<readonly [RegExp, LoopFailureClass]> = [
  [/^TARGET_DOCTRINE_LEAKED_INTO_RUN/, 'security'],
  [/^SECRET_/, 'security'],
  [/^DOCTRINE_MANIFEST_MISMATCH/, 'security'],
  [/^GROUND_TRUTH_/, 'verification'],
  [/^REVIEW_/, 'review'],
  [/^(MODEL_|MODEL_PROVIDER_)/, 'model'],
  [/^IMPLEMENTER_/, 'model'],
  [/^(SANDBOX_|GIT_|WORKTREE_|DOCTRINE_ROOT_)/, 'environment'],
  [/^merge-conflict/, 'environment'],
  [/^(DEFECT_|BUG_)/, 'defect'],
  [/^NOTHING_STAGED/, 'policy'],
  [/^(REPO_NOT_CLEAN|LOOP_|TASK_DOCUMENT_|TARGET_REPOSITORY_|GATE_REFUSED|GATE_NOT_IMPLEMENTED)/, 'policy'],
];

function gateIdsFromMessage(message: string): string[] {
  const match = message.match(/GATE_REFUSED:[^:]*:([^:]*):/);
  return match && match[1] ? match[1].split(',') : [];
}

export interface LoopFailureInput {
  /** The stage the attempt had reached when it failed. */
  stage: LoopStage;
  /** The refusal code — the first token of the thrown message. */
  reason: string;
  /** The full refusal message, if available (its gate ids and markers are read here). */
  message?: string;
  /** Gate ids, when the caller already parsed them from the message. */
  gateIds?: string[];
}

/** Classifies one failed attempt. Pure and total: an unrecognized refusal is `unknown`. */
export function classifyLoopFailure(input: LoopFailureInput): LoopFailureClass {
  const { stage, reason } = input;
  const message = input.message ?? '';

  // A quarantined instruction reaching a payload is always a security halt, whatever stage it was
  // caught at (Sprint 29, WP-1).
  if (/TARGET_DOCTRINE_LEAKED_INTO_RUN/.test(reason) || /TARGET_DOCTRINE_LEAKED_INTO_RUN/.test(message)) {
    return 'security';
  }

  const gateIds = input.gateIds ?? gateIdsFromMessage(message);
  for (const id of gateIds) {
    const cls = GATE_FAILURE_CLASSES[id];
    if (cls) return cls;
  }

  for (const [pattern, cls] of REASON_PATTERNS) {
    if (pattern.test(reason)) return cls;
  }

  // No gate and no recognized code: fall back to where the attempt died.
  if (stage === 'verify') return 'verification';
  if (stage === 'review') return 'review';
  return 'unknown';
}

export interface FailureClassCount {
  failureClass: LoopFailureClass;
  count: number;
}

/**
 * Tallies classes across attempts. Ordered by count descending, then by class priority, so the
 * same records always yield the same order (ADR-012, determinism).
 */
export function summariseFailureClasses(
  attempts: ReadonlyArray<{ failureClass?: LoopFailureClass }>,
): { counts: FailureClassCount[]; dominant?: LoopFailureClass } {
  const tally = new Map<LoopFailureClass, number>();
  for (const attempt of attempts) {
    if (!attempt.failureClass) continue;
    tally.set(attempt.failureClass, (tally.get(attempt.failureClass) ?? 0) + 1);
  }
  const counts = [...tally.entries()]
    .map(([failureClass, count]) => ({ failureClass, count }))
    .sort((a, b) => b.count - a.count || LOOP_FAILURE_CLASSES.indexOf(a.failureClass) - LOOP_FAILURE_CLASSES.indexOf(b.failureClass));
  return { counts, dominant: counts[0]?.failureClass };
}

/**
 * The run-level class: the dominant class across failed attempts, else the class of a run-level
 * hard stop (wall-clock, resource, attempt/commit caps) with no failed attempt to point at. A run
 * that failed nothing has no class.
 */
export function runFailureClass(
  attempts: ReadonlyArray<{ failureClass?: LoopFailureClass }>,
  hardStop?: string,
): LoopFailureClass | undefined {
  const { dominant } = summariseFailureClasses(attempts);
  if (dominant) return dominant;
  if (!hardStop) return undefined;
  if (/cancelled by operator/.test(hardStop)) return 'unknown';
  if (/wall-clock|resource exhaustion/.test(hardStop)) return 'environment';
  if (/total attempts|commits \d/.test(hardStop)) return 'policy';
  if (/GATE_REFUSED/.test(hardStop)) return 'policy';
  return 'unknown';
}

/** The registry the completeness test checks against. */
export function unclassifiedGateIds(): string[] {
  return GATE_IDS.filter((id) => !(id in GATE_FAILURE_CLASSES));
}
