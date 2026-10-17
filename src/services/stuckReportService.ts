/**
 * The stuck-unit report (Sprint 33, WP-3).
 *
 * When a unit exhausts its attempts and goes STUCK, the run record already holds everything an
 * operator needs — the failure class, every attempt with its stage and refusal, and the truncation
 * tail — but it holds it as a run-shaped ledger object, not as an answer to the only questions an
 * operator actually asks: *what class of failure is this, what did we already try, and what do we do
 * next?*
 *
 * This module answers those three, deterministically, from the recorded run: no clock, no model, no
 * I/O. The same record always yields the same reports. It is delivered on the loop's settlement
 * webhook (see `loopControlService`) so an operator's receiver learns a unit is stuck at the moment
 * the run settles, not when someone next opens the report file.
 */
import type { LoopFailureClass } from './loopFailureClass';
import type { LoopRunRecord, UnitRecord } from './loopTypes';

interface StuckAttempt {
  attempt: number;
  stage: string;
  reason: string;
  detail: string;
}

export interface StuckUnitReport {
  unitId: string;
  title: string;
  failureClass: LoopFailureClass;
  /** Every failed attempt of the stuck unit, in order: what was tried and how it was refused. */
  whatWasTried: StuckAttempt[];
  /** A concrete, class-specific next action for the operator. Never fabricated; derived from the class. */
  nextStep: string;
}

/**
 * The next step for each failure class.
 *
 * These are deliberately *actions*, not restatements of the class: "read the verification output",
 * not "verification failed". They are the operator's first move, not a promise that it will fix the
 * unit — the loop cannot know that, and a report that pretends to would be the false confidence this
 * codebase refuses everywhere else.
 */
const NEXT_STEP: Record<LoopFailureClass, string> = {
  security: 'Do not retry unattended: a security refusal is not a transient failure. Inspect the secret-scan or doctrine-integrity refusal in the attempt detail, remove the offending content, and only then re-submit.',
  verification: 'Read the failing verification command and its output tail in the unit report, reproduce it by hand in the repository, and fix the implementation (or the declared check if it is wrong) before re-submitting.',
  review: 'Read the reviewer findings on each axis in the attempt record, address the specific objection the review raised, and re-submit; a repeated review refusal usually means the acceptance criteria are ambiguous.',
  model: 'The model returned output the loop could not use (malformed manifest, empty files, or a missing provider). Check the provider is registered and enabled, and that the model follows the JSON file-manifest contract, then re-submit.',
  environment: 'The host, sandbox, or git state refused the work (bwrap, worktree, or an unclean tree). Run `npm run verify:host` on the executor host and clear the repository state before re-submitting.',
  policy: 'A loop rule refused the change (no-op unit, unrelated writes, attempt cap, or a claimed file that did not change). Read which rule fired and change the design so the unit does real, claimed work.',
  unknown: 'The refusal did not match a known class. Read the attempt reason and detail verbatim in the unit report and diagnose from the raw refusal; if it recurs, it needs a new class in loopFailureClass.ts.',
};

/** The next step for a failure class. Total: every class has one. */
export function nextStepForFailureClass(failureClass: LoopFailureClass): string {
  return NEXT_STEP[failureClass];
}

function reportFor(unit: UnitRecord): StuckUnitReport {
  const failureClass: LoopFailureClass = unit.failureClass ?? 'unknown';
  const whatWasTried: StuckAttempt[] = unit.attempts
    .filter((attempt) => !attempt.passed)
    .map((attempt) => ({
      attempt: attempt.attempt,
      stage: attempt.stage,
      reason: attempt.reason,
      detail: attempt.detail.slice(0, 500),
    }));
  return { unitId: unit.unitId, title: unit.title, failureClass, whatWasTried, nextStep: nextStepForFailureClass(failureClass) };
}

/**
 * One report per STUCK unit, in the run's unit order. A run with no stuck unit yields an empty list,
 * never `undefined`, so a receiver can always rely on the key being present.
 */
export function buildStuckReports(run: LoopRunRecord): StuckUnitReport[] {
  return run.units.filter((unit) => unit.status === 'stuck').map(reportFor);
}
