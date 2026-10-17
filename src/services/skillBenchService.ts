/**
 * The skills benchmark's arithmetic (Sprint 33, WP-4).
 *
 * ADR-013 §7 is blunt: a preference for a skill is not evidence that it helps. The only way to
 * decide whether to turn a vendored skill on for a role is to measure it — run the same fixture
 * tasks with the skill injected and without, repeat each side, and compare the results against a
 * rule fixed **before** any data is seen.
 *
 * This module holds the parts that must be beyond argument: the proportions, the Wilson score
 * intervals (the right interval for a small-n proportion, not the normal approximation that
 * misbehaves near 0 or 1), the paired on/off comparison, and the pre-registered adoption rule. It
 * is pure — no clock, no I/O, no model — so the same arm results always yield the same report, and
 * the report can be unit-tested without running a single loop.
 *
 * The orchestrator (`scripts/bench-skills.ts`) supplies the `runOne` function that actually executes
 * a fixture; this module never touches a repository.
 */

/** One fixture task's outcome for one arm, one repetition. */
export interface BenchRunResult {
  /** The unit's first attempt passed verification — the headline metric the rule is written on. */
  firstAttemptSuccess: boolean;
  /** The unit ended STUCK (attempts exhausted without a commit). */
  stuck: boolean;
  /** How many attempts were refused (a proxy for wasted model work). */
  refusals: number;
}

/** A proportion with its Wilson score interval, all in [0, 1]. */
export interface Proportion {
  successes: number;
  n: number;
  point: number;
  low: number;
  high: number;
}

export interface ArmSummary {
  runs: number;
  /** First-attempt success rate and its interval. */
  firstAttempt: Proportion;
  /** STUCK rate (point only; the rule compares points, not intervals, for the guardrail). */
  stuckRate: number;
  /** Total refused attempts across the arm. */
  refusals: number;
}

export interface AdoptionDecision {
  /** True only when every clause of the pre-registered rule passes. */
  adopt: boolean;
  /** The observed improvement in first-attempt rate (on − off), as a fraction. */
  delta: number;
  /** Every clause that failed, quoted so a reader can see exactly why the skill stays off. */
  reasons: string[];
  /** The rule, in full, so a report is self-describing. */
  rule: string;
}

export interface BenchReport {
  version: 1;
  /** True when the runs used a stub provider, not a real model. A stub report is never evidence. */
  stub: boolean;
  /** The model spec the arms ran on (or `stub` for the dry pass), for the label the rule requires. */
  model: string;
  fixtures: number;
  repetitions: number;
  generatedAt: string;
  arms: Partial<Record<'on' | 'off', ArmSummary>>;
  adoption: AdoptionDecision;
}

/**
 * The pre-registered adoption rule, verbatim from `sprints/sprint-33-closing-sprint.md` (recorded
 * there before any real run). It is reproduced here so the code and the sprint file cannot drift:
 * a test asserts they agree.
 */
export const BENCH_ADOPTION_RULE =
  'A skill is enabled for a role only if, over the bench (skills on vs off, >=3 repetitions per task): ' +
  'the first-attempt rate improves by >= 10 percentage points, and the two Wilson intervals do not overlap, ' +
  'and neither the STUCK rate nor the refusal count rises. Otherwise the skill stays off.';

/** The improvement threshold the rule demands, as a fraction. */
export const ADOPTION_MIN_FIRST_ATTEMPT_DELTA = 0.1;

/** The z for a 95% interval. */
const Z_95 = 1.959963984540054;

/**
 * The Wilson score interval for a binomial proportion. Preferred over the normal approximation
 * because the sample is small (fixtures × repetitions) and a first-attempt rate sits near 1.0, where
 * the normal interval can exceed [0, 1] and would let a claim look stronger than it is.
 */
export function wilsonInterval(successes: number, n: number, z: number = Z_95): Proportion {
  if (!Number.isFinite(successes) || !Number.isFinite(n) || n <= 0) return { successes: 0, n: Math.max(0, n | 0), point: 0, low: 0, high: 0 };
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return {
    successes,
    n,
    point: p,
    low: Math.max(0, (centre - margin) / denom),
    high: Math.min(1, (centre + margin) / denom),
  };
}

/** Two Wilson intervals overlap when either's range reaches into the other. */
export function intervalsOverlap(a: Proportion, b: Proportion): boolean {
  return a.low <= b.high && b.low <= a.high;
}

export function summariseArm(results: BenchRunResult[]): ArmSummary {
  const n = results.length;
  const firsts = results.filter((result) => result.firstAttemptSuccess).length;
  const stuck = results.filter((result) => result.stuck).length;
  const refusals = results.reduce((total, result) => total + Math.max(0, result.refusals), 0);
  return {
    runs: n,
    firstAttempt: wilsonInterval(firsts, n),
    stuckRate: n ? stuck / n : 0,
    refusals,
  };
}

/**
 * Applies the pre-registered rule to the two arms. The rule is conjunctive: every clause must pass,
 * so a skill with a large but noisy improvement, or one that improves first-attempt rate while
 * making more units get stuck, stays off.
 */
export function evaluateAdoption(on: ArmSummary, off: ArmSummary): AdoptionDecision {
  const reasons: string[] = [];
  const delta = on.firstAttempt.point - off.firstAttempt.point;

  if (delta < ADOPTION_MIN_FIRST_ATTEMPT_DELTA) {
    reasons.push(
      `first-attempt rate improved by ${(delta * 100).toFixed(1)}pp, below the required ${(ADOPTION_MIN_FIRST_ATTEMPT_DELTA * 100).toFixed(0)}pp`,
    );
  }
  if (intervalsOverlap(on.firstAttempt, off.firstAttempt)) {
    reasons.push('the two Wilson intervals overlap, so the improvement is not distinguishable from noise');
  }
  if (on.stuckRate > off.stuckRate) {
    reasons.push(`STUCK rate rose from ${(off.stuckRate * 100).toFixed(1)}% to ${(on.stuckRate * 100).toFixed(1)}%`);
  }
  if (on.refusals > off.refusals) {
    reasons.push(`refusal count rose from ${off.refusals} to ${on.refusals}`);
  }

  return { adopt: reasons.length === 0, delta, reasons, rule: BENCH_ADOPTION_RULE };
}

export interface SkillBenchOptions {
  /** Fixture names, each an independent task. */
  fixtures: string[];
  /** Repetitions per fixture per arm (the rule requires >= 3). */
  repetitions: number;
  /** Which arms to run. Both are required to decide. */
  arms: Array<'on' | 'off'>;
  /** True for the stub dry pass. */
  stub: boolean;
  /** The model spec the arms run on (label). */
  model: string;
  /** Executes one fixture for one arm and one repetition. The only side-effecting seam. */
  runOne: (args: { fixture: string; arm: 'on' | 'off'; repetition: number }) => Promise<BenchRunResult>;
  /** ISO timestamp supplier, injected so the report is reproducible under test. */
  now: () => string;
}

/**
 * Runs the paired matrix — every fixture, every repetition, every arm — and builds one report.
 * Repetitions below the rule's floor of 3 are refused rather than silently accepted, because a
 * 1-repetition comparison cannot satisfy a rule that names 3.
 */
export async function runSkillBench(options: SkillBenchOptions): Promise<BenchReport> {
  if (options.repetitions < 3) {
    throw new Error(`BENCH_REPETITIONS_TOO_FEW: the pre-registered rule requires >= 3 repetitions per task, got ${options.repetitions}`);
  }
  if (!options.arms.includes('on') || !options.arms.includes('off')) {
    throw new Error('BENCH_ARMS_INCOMPLETE: the rule is a paired comparison; both the on and off arms are required');
  }

  const perArm: Record<'on' | 'off', BenchRunResult[]> = { on: [], off: [] };
  for (const arm of options.arms) {
    for (const fixture of options.fixtures) {
      for (let repetition = 0; repetition < options.repetitions; repetition += 1) {
        perArm[arm].push(await options.runOne({ fixture, arm, repetition }));
      }
    }
  }

  const on = summariseArm(perArm.on);
  const off = summariseArm(perArm.off);
  return {
    version: 1,
    stub: options.stub,
    model: options.model,
    fixtures: options.fixtures.length,
    repetitions: options.repetitions,
    generatedAt: options.now(),
    arms: { on, off },
    adoption: evaluateAdoption(on, off),
  };
}

export type BenchEvidenceVerdict =
  | { ok: true }
  | { ok: false; code: 'BENCH_STUB_NOT_EVIDENCE' | 'BENCH_NO_PAIRED_ARMS'; detail: string };

/**
 * Whether a report may be used as evidence for the `skills-adoption-evidence` capability.
 *
 * A stub dry pass proves the harness runs; it measures the stub, not a model, so it can never show a
 * skill helped. It is refused by name, and a report missing an arm is refused too — the rule is a
 * paired comparison, and half of it is not evidence.
 */
export function benchReportEvidence(report: Pick<BenchReport, 'stub' | 'arms'>): BenchEvidenceVerdict {
  if (report.stub) {
    return {
      ok: false,
      code: 'BENCH_STUB_NOT_EVIDENCE',
      detail: 'this report is a stub dry pass (stub: true): it exercises the harness, not a model, and cannot evidence skills-adoption-evidence',
    };
  }
  if (!report.arms.on || !report.arms.off) {
    return { ok: false, code: 'BENCH_NO_PAIRED_ARMS', detail: 'a skills-adoption claim needs both the on and off arms; this report is missing one' };
  }
  return { ok: true };
}
