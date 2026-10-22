/**
 * The skills benchmark's arithmetic (Sprint 33 WP-4; rule amended in Sprint 34 WP-2).
 *
 * ADR-013 §7 is blunt: a preference for a skill is not evidence that it helps. The only way to
 * decide whether to turn a vendored skill on for a role is to measure it — run the same fixture
 * tasks with the skill injected and without, repeat each side, and compare the results against a
 * rule fixed **before** any data is seen.
 *
 * This module holds the parts that must be beyond argument: the proportions, the Wilson score
 * intervals (kept for reporting, not used as the decision rule), the paired per-fixture comparison,
 * and the pre-registered adoption rule. It is pure — no clock, no I/O, no model — so the same arm
 * results always yield the same report, and the report can be unit-tested without running a loop.
 *
 * The rule changed in Sprint 34 (WP-2), before any real run. The original rule compared the two
 * arms' Wilson intervals as if they were independent samples; the design is **paired** (every
 * fixture runs under both arms), so that clause was both underpowered and the wrong test. The
 * amended rule is an **exact sign test** over the per-fixture winners, keeps the ≥10-point
 * threshold and the no-rise-in-STUCK/refusals guardrails, and records the minimum detectable effect
 * at the observed n so a null result is read honestly. See `sprints/sprint-34-first-orders.md`.
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
  /** Wall-clock time for this single run, in ms. Measured by the orchestrator; absent when unknown. */
  wallTimeMs?: number;
  /** Tokens the model path reported for this run. Absent when the provider reported none. */
  tokens?: number;
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
  /** First-attempt success rate and its Wilson interval (reported for context, not the rule). */
  firstAttempt: Proportion;
  /** STUCK rate (point only; the rule compares points, not intervals, for the guardrail). */
  stuckRate: number;
  /** Total refused attempts across the arm. */
  refusals: number;
}

/** One fixture's results under both arms, reduced to the winner the sign test counts. */
export interface PairedFixture {
  fixture: string;
  /** First-attempt successes in the on arm (aggregated over repetitions). */
  onSuccesses: number;
  /** First-attempt successes in the off arm (aggregated over repetitions). */
  offSuccesses: number;
  repetitions: number;
  /** Which arm had the higher aggregate first-attempt rate; `tie` when equal. */
  sign: 'on' | 'off' | 'tie';
}

export interface PairedSummary {
  fixtures: number;
  /** Fixtures where the on arm's aggregate first-attempt rate was higher. */
  onWins: number;
  /** Fixtures where the off arm's aggregate first-attempt rate was higher. */
  offWins: number;
  /** Fixtures where the two arms tied (ignored by the sign test). */
  ties: number;
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
  /** The one-sided exact-sign-test p-value over the non-tied fixtures (1 when there are none). */
  signTestP: number;
  /**
   * The minimum true on-win rate detectable with 80% power at the observed number of non-tied
   * fixtures, at α = 0.05. A null result means "below this effect at this n", not "no effect".
   */
  mde: number;
}

export interface BenchReport {
  version: 2;
  /** True when the runs used a stub provider, not a real model. A stub report is never evidence. */
  stub: boolean;
  /** The model spec the arms ran on (or `stub` for the dry pass), for the label the rule requires. */
  model: string;
  fixtures: number;
  repetitions: number;
  generatedAt: string;
  arms: Partial<Record<'on' | 'off', ArmSummary>>;
  /** The paired per-fixture comparison the amended rule is written on. */
  pairs: PairedSummary;
  adoption: AdoptionDecision;
  /** Total wall time across every run, in ms. */
  wallTimeMs: number;
  /** Total tokens the model path reported; null when no run reported a token count. */
  tokens: number | null;
}

/**
 * The amended pre-registered adoption rule. Sprint 34 (WP-2) reproduces it in
 * `sprints/sprint-34-first-orders.md`, recorded before any real run; a test asserts they agree.
 */
export const BENCH_ADOPTION_RULE =
  'A skill is enabled for a role only if, over the bench (skills on vs off, >=3 repetitions per task, ' +
  'paired per fixture): an exact sign test over the non-tied fixtures favours the on arm at alpha = 0.05, ' +
  'and the aggregate first-attempt rate improves by >= 10 percentage points, and neither the STUCK rate ' +
  'nor the refusal count rises. Otherwise the skill stays off. The report states the MDE at the observed n.';

/** The improvement threshold the rule demands, as a fraction. */
export const ADOPTION_MIN_FIRST_ATTEMPT_DELTA = 0.1;

/** The significance level of the exact sign test. */
export const ADOPTION_SIGNIFICANCE = 0.05;

/** The power the reported minimum detectable effect is computed at. */
const ADOPTION_POWER = 0.8;

/** The z for a 95% interval. */
const Z_95 = 1.959963984540054;

/**
 * The Wilson score interval for a binomial proportion. Preferred over the normal approximation
 * because the sample is small (fixtures × repetitions) and a first-attempt rate sits near 1.0, where
 * the normal interval can exceed [0, 1] and would let a claim look stronger than it is.
 *
 * Kept for reporting: the amended rule no longer compares intervals, but the interval is still the
 * honest way to show a reader how wide an arm's rate is.
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

/** Reduces one fixture's two arms to the winner the sign test counts. */
export function pairFixture(fixture: string, on: BenchRunResult[], off: BenchRunResult[]): PairedFixture {
  const onSuccesses = on.filter((result) => result.firstAttemptSuccess).length;
  const offSuccesses = off.filter((result) => result.firstAttemptSuccess).length;
  const sign: PairedFixture['sign'] = onSuccesses > offSuccesses ? 'on' : onSuccesses < offSuccesses ? 'off' : 'tie';
  return { fixture, onSuccesses, offSuccesses, repetitions: on.length, sign };
}

export function summarisePairs(pairs: PairedFixture[]): PairedSummary {
  return {
    fixtures: pairs.length,
    onWins: pairs.filter((pair) => pair.sign === 'on').length,
    offWins: pairs.filter((pair) => pair.sign === 'off').length,
    ties: pairs.filter((pair) => pair.sign === 'tie').length,
  };
}

/** `log C(n, k)`, so a binomial tail is computed without overflowing. */
function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  let total = 0;
  for (let i = 1; i <= k; i += 1) total += Math.log(n - k + i) - Math.log(i);
  return total;
}

/**
 * The one-sided exact sign-test p-value, P(X >= wins) for X ~ Binomial(trials, 0.5).
 *
 * The exact binomial is used rather than a normal approximation because the number of fixtures is
 * small; at small n the approximation is exactly where a claim would look stronger than the data.
 * With no non-tied fixtures there is no evidence, so the p-value is 1 (the skill stays off).
 */
export function signTestPValue(wins: number, trials: number): number {
  if (!Number.isFinite(wins) || !Number.isFinite(trials) || trials <= 0 || wins <= 0) return 1;
  const k = Math.min(Math.floor(wins), trials);
  let sum = 0;
  for (let i = k; i <= trials; i += 1) sum += Math.exp(logChoose(trials, i) - trials * Math.LN2);
  return Math.min(1, sum);
}

/** P(X >= k) for X ~ Binomial(n, p), in log space. */
function upperTail(k: number, n: number, p: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  let sum = 0;
  for (let i = k; i <= n; i += 1) {
    sum += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  }
  return Math.min(1, sum);
}

/**
 * The minimum detectable effect for the exact sign test at `trials` non-tied fixtures: the smallest
 * true on-win probability `p` for which the critical region {X >= k*} has at least the requested
 * power, where k* is the smallest k that makes the one-sided test significant at `alpha`.
 *
 * Returns 1 when no achievable on-win rate reaches the power at this n — the honest reading of a
 * bench too small to detect anything short of a near-certain win. This number is what makes a null
 * result interpretable: at a small n the MDE is large, so "no effect" means "below an effect we
 * could not have detected anyway".
 */
export function minimumDetectableEffect(trials: number, alpha: number = ADOPTION_SIGNIFICANCE, power: number = ADOPTION_POWER): number {
  if (!Number.isFinite(trials) || trials <= 0) return 1;
  let critical = -1;
  for (let k = 1; k <= trials; k += 1) {
    if (signTestPValue(k, trials) <= alpha) { critical = k; break; }
  }
  if (critical < 0) return 1;
  for (let step = 0; step <= 499; step += 1) {
    const p = 0.5 + (0.5 * step) / 499;
    if (upperTail(critical, trials, p) >= power) return p;
  }
  return 1;
}

/**
 * Applies the amended pre-registered rule. Conjunctive: every clause must pass, so a skill with a
 * large but noisy improvement, or one that improves the first-attempt rate while making more units
 * get stuck, stays off.
 */
export function evaluateAdoption(on: ArmSummary, off: ArmSummary, pairs: PairedSummary): AdoptionDecision {
  const reasons: string[] = [];
  const delta = on.firstAttempt.point - off.firstAttempt.point;
  const discordant = pairs.onWins + pairs.offWins;
  const signTestP = signTestPValue(pairs.onWins, discordant);
  const mde = minimumDetectableEffect(discordant);

  if (delta < ADOPTION_MIN_FIRST_ATTEMPT_DELTA) {
    reasons.push(
      `first-attempt rate improved by ${(delta * 100).toFixed(1)}pp, below the required ${(ADOPTION_MIN_FIRST_ATTEMPT_DELTA * 100).toFixed(0)}pp`,
    );
  }
  if (discordant === 0) {
    reasons.push('no fixture separated the arms (every fixture tied), so there is no paired evidence');
  } else if (signTestP >= ADOPTION_SIGNIFICANCE) {
    reasons.push(`the exact sign test is not significant (p=${signTestP.toFixed(3)} >= ${ADOPTION_SIGNIFICANCE} over ${discordant} non-tied fixture(s); MDE at this n is ${(mde * 100).toFixed(0)}pp)`);
  }
  if (on.stuckRate > off.stuckRate) {
    reasons.push(`STUCK rate rose from ${(off.stuckRate * 100).toFixed(1)}% to ${(on.stuckRate * 100).toFixed(1)}%`);
  }
  if (on.refusals > off.refusals) {
    reasons.push(`refusal count rose from ${off.refusals} to ${on.refusals}`);
  }

  return { adopt: reasons.length === 0, delta, reasons, rule: BENCH_ADOPTION_RULE, signTestP, mde };
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
  const perFixture: Record<string, { on: BenchRunResult[]; off: BenchRunResult[] }> = {};
  for (const fixture of options.fixtures) perFixture[fixture] = { on: [], off: [] };
  for (const arm of options.arms) {
    for (const fixture of options.fixtures) {
      for (let repetition = 0; repetition < options.repetitions; repetition += 1) {
        const result = await options.runOne({ fixture, arm, repetition });
        perArm[arm].push(result);
        perFixture[fixture][arm].push(result);
      }
    }
  }

  const on = summariseArm(perArm.on);
  const off = summariseArm(perArm.off);
  const pairs = summarisePairs(options.fixtures.map((fixture) => pairFixture(fixture, perFixture[fixture].on, perFixture[fixture].off)));
  const wallTimeMs = [...perArm.on, ...perArm.off].reduce((total, result) => total + (Number.isFinite(result.wallTimeMs) ? Math.max(0, result.wallTimeMs as number) : 0), 0);
  const tokenResults = [...perArm.on, ...perArm.off].filter((result) => Number.isFinite(result.tokens));
  const tokens = tokenResults.length ? tokenResults.reduce((total, result) => total + Math.max(0, result.tokens as number), 0) : null;

  return {
    version: 2,
    stub: options.stub,
    model: options.model,
    fixtures: options.fixtures.length,
    repetitions: options.repetitions,
    generatedAt: options.now(),
    arms: { on, off },
    pairs,
    adoption: evaluateAdoption(on, off, pairs),
    wallTimeMs,
    tokens,
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
