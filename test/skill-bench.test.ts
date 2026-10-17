/**
 * Sprint 33, WP-4; rule amended in Sprint 34, WP-2: the skills benchmark.
 *
 * Two layers are proven here:
 *
 *  1. **The arithmetic and the rule.** The Wilson interval (kept for reporting), the paired
 *     per-fixture comparison, the exact sign test, the minimum detectable effect, and the amended
 *     pre-registered adoption rule are pure functions, tested directly — including the negative
 *     clauses, because the interesting question is not "does a good result adopt" but "does a
 *     merely-noisy or guardrail-violating or underpowered result correctly stay off". A drift guard
 *     asserts the rule text in the code equals the amended rule recorded in the sprint file before
 *     any real run.
 *
 *  2. **The stub dry pass actually runs.** The orchestrator is invoked as a real subprocess against
 *     a reduced matrix; its stdout must be a well-formed report labelled `stub: true` with both
 *     arms, pairings, wall time and Wilson intervals — and that report must be refused as
 *     capability evidence.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import {
  BENCH_ADOPTION_RULE,
  ADOPTION_MIN_FIRST_ATTEMPT_DELTA,
  ADOPTION_SIGNIFICANCE,
  wilsonInterval,
  intervalsOverlap,
  summariseArm,
  pairFixture,
  summarisePairs,
  signTestPValue,
  minimumDetectableEffect,
  evaluateAdoption,
  runSkillBench,
  benchReportEvidence,
  type BenchRunResult,
  type ArmSummary,
  type PairedSummary,
} from '../src/services/skillBenchService';

const ROOT = process.cwd();

// ── part 1: the arithmetic ──────────────────────────────────────────────────

test('WP-4: a Wilson interval stays inside [0,1] and brackets the point estimate', () => {
  for (const [successes, n] of [[0, 5], [1, 5], [3, 5], [5, 5], [40, 40], [0, 1], [1, 1]] as const) {
    const interval = wilsonInterval(successes, n);
    assert.equal(interval.point, successes / n);
    assert.ok(interval.low >= 0 && interval.low <= 1, `low out of range for ${successes}/${n}: ${interval.low}`);
    assert.ok(interval.high >= 0 && interval.high <= 1, `high out of range for ${successes}/${n}: ${interval.high}`);
    assert.ok(interval.low <= interval.point && interval.point <= interval.high, `point not bracketed for ${successes}/${n}`);
  }
});

test('WP-4: a zero denominator yields a zero interval, never NaN', () => {
  const interval = wilsonInterval(0, 0);
  assert.deepEqual(interval, { successes: 0, n: 0, point: 0, low: 0, high: 0 });
});

test('WP-4: a certain result keeps its interval below 1 (no false precision)', () => {
  const interval = wilsonInterval(3, 3);
  assert.equal(interval.point, 1);
  assert.ok(interval.low < 1, 'even 3/3 must not claim a lower bound of certainty');
  assert.equal(interval.high, 1);
});

test('WP-4: summariseArm counts first-attempts, stuck units and refused attempts', () => {
  const results: BenchRunResult[] = [
    { firstAttemptSuccess: true, stuck: false, refusals: 0 },
    { firstAttemptSuccess: false, stuck: true, refusals: 3 },
    { firstAttemptSuccess: true, stuck: false, refusals: 0 },
    { firstAttemptSuccess: false, stuck: false, refusals: 1 },
  ];
  const arm = summariseArm(results);
  assert.equal(arm.runs, 4);
  assert.equal(arm.firstAttempt.successes, 2);
  assert.equal(arm.firstAttempt.point, 0.5);
  assert.equal(arm.stuckRate, 0.25);
  assert.equal(arm.refusals, 4);
});

// ── part 1b: the paired comparison and the exact sign test ──────────────────

const run = (pass: boolean): BenchRunResult => ({ firstAttemptSuccess: pass, stuck: false, refusals: 0 });

test('WP-2: pairFixture names the winning arm and calls a tie a tie', () => {
  assert.equal(pairFixture('a', [run(true), run(true)], [run(true), run(false)]).sign, 'on');
  assert.equal(pairFixture('b', [run(true), run(false)], [run(true), run(true)]).sign, 'off');
  assert.equal(pairFixture('c', [run(true), run(false)], [run(true), run(false)]).sign, 'tie');
  const paired = pairFixture('a', [run(true), run(true), run(true)], [run(false)]);
  assert.equal(paired.onSuccesses, 3);
  assert.equal(paired.offSuccesses, 0);
  assert.equal(paired.repetitions, 3);
});

test('WP-2: summarisePairs counts on-wins, off-wins and ties', () => {
  const pairs = summarisePairs([
    pairFixture('a', [run(true)], [run(false)]),
    pairFixture('b', [run(true)], [run(false)]),
    pairFixture('c', [run(false)], [run(true)]),
    pairFixture('d', [run(true)], [run(true)]),
  ]);
  assert.deepEqual(pairs, { fixtures: 4, onWins: 2, offWins: 1, ties: 1 });
});

test('WP-2: the exact sign test is the binomial tail, not a normal approximation', () => {
  assert.equal(signTestPValue(0, 5), 1, 'no wins is no evidence');
  assert.equal(signTestPValue(3, 0), 1, 'no trials is no evidence');
  // P(X >= 12 | 12, 0.5) = 1/4096
  assert.ok(Math.abs(signTestPValue(12, 12) - 1 / 4096) < 1e-12);
  // Symmetric case: P(X >= 6 | 12, 0.5) = 0.5 + 0.5 * C(12,6)/4096
  assert.ok(Math.abs(signTestPValue(6, 12) - (0.5 + 0.5 * 924 / 4096)) < 1e-9);
  // Monotone: more wins is stronger evidence.
  assert.ok(signTestPValue(10, 12) < signTestPValue(9, 12));
});

test('WP-2: the MDE at n=12 is large, and shrinks as n grows', () => {
  assert.equal(minimumDetectableEffect(0), 1);
  const mde12 = minimumDetectableEffect(12);
  assert.ok(mde12 > 0.5 && mde12 <= 1, `MDE(12) must be in (0.5,1], got ${mde12}`);
  assert.ok(minimumDetectableEffect(40) < mde12, 'more pairs must detect a smaller effect');
});

// ── part 1c: the amended rule ───────────────────────────────────────────────

function arm(successes: number, n: number, stuck = 0, refusals = 0): ArmSummary {
  return {
    runs: n,
    firstAttempt: wilsonInterval(successes, n),
    stuckRate: n ? stuck / n : 0,
    refusals,
  };
}

function pairs(onWins: number, offWins: number, ties = 0): PairedSummary {
  return { fixtures: onWins + offWins + ties, onWins, offWins, ties };
}

test('WP-2: a clear, significant, guardrail-clean paired improvement adopts', () => {
  const decision = evaluateAdoption(arm(8, 8), arm(1, 8), pairs(12, 0));
  assert.equal(decision.adopt, true, `expected adoption, got: ${decision.reasons.join('; ')}`);
  assert.ok(decision.delta >= ADOPTION_MIN_FIRST_ATTEMPT_DELTA);
  assert.ok(decision.signTestP < ADOPTION_SIGNIFICANCE);
  assert.equal(decision.reasons.length, 0);
});

test('WP-2: an improvement below 10pp stays off and says why', () => {
  const decision = evaluateAdoption(arm(4, 10), arm(5, 10), pairs(10, 0));
  assert.equal(decision.adopt, false);
  assert.ok(decision.reasons.some((reason) => reason.includes('below the required 10pp')), decision.reasons.join('; '));
});

test('WP-2: a paired improvement the sign test cannot call stays off (noise is not evidence)', () => {
  const decision = evaluateAdoption(arm(8, 8), arm(1, 8), pairs(2, 1));
  assert.equal(decision.adopt, false);
  assert.ok(decision.reasons.some((reason) => reason.includes('sign test is not significant')), decision.reasons.join('; '));
  assert.ok(decision.signTestP >= ADOPTION_SIGNIFICANCE);
});

test('WP-2: every fixture tying stays off — an unseparated bench is not evidence', () => {
  const decision = evaluateAdoption(arm(8, 8), arm(1, 8), pairs(0, 0, 12));
  assert.equal(decision.adopt, false);
  assert.ok(decision.reasons.some((reason) => reason.includes('no fixture separated the arms')), decision.reasons.join('; '));
});

test('WP-2: a worsening STUCK rate keeps the skill off, even with a big improvement', () => {
  const decision = evaluateAdoption(arm(8, 8, 3), arm(1, 8, 0), pairs(12, 0));
  assert.equal(decision.adopt, false);
  assert.ok(decision.reasons.some((reason) => reason.includes('STUCK rate rose')), decision.reasons.join('; '));
});

test('WP-2: a rising refusal count keeps the skill off', () => {
  const decision = evaluateAdoption(arm(8, 8, 0, 12), arm(1, 8, 0, 2), pairs(12, 0));
  assert.equal(decision.adopt, false);
  assert.ok(decision.reasons.some((reason) => reason.includes('refusal count rose')), decision.reasons.join('; '));
});

test('WP-2: the decision records the MDE at the observed n', () => {
  const decision = evaluateAdoption(arm(8, 8), arm(1, 8), pairs(12, 0));
  assert.ok(decision.mde > 0.5 && decision.mde <= 1, `MDE must be recorded, got ${decision.mde}`);
});

test('WP-2: the amended rule in the code matches the rule recorded in the sprint file', () => {
  const sprint = fs.readFileSync(path.join(ROOT, 'sprints', 'sprint-34-first-orders.md'), 'utf8');
  // Markdown wraps prose across lines and prefixes a block quote with ">", so compare on text
  // with block-quote markers and collapsed whitespace.
  const flat = sprint.replace(/^>\s?/gm, '').replace(/\s+/g, ' ');
  for (const fragment of [
    'exact sign test',
    '\u2265 10 percentage points',
    'neither the STUCK rate nor the refusal count rises',
    'MDE',
  ]) {
    assert.ok(flat.includes(fragment), `the sprint file must record the amended rule; missing: ${fragment}`);
  }
  assert.ok(
    !flat.includes('Wilson intervals do not overlap') || flat.indexOf('Dropped') < flat.indexOf('Wilson intervals do not overlap'),
    'the amended rule must not re-state the dropped interval clause as operative',
  );
  assert.match(BENCH_ADOPTION_RULE, /improves by >= 10 percentage points/);
  assert.match(BENCH_ADOPTION_RULE, /exact sign test over the non-tied fixtures/);
  assert.match(BENCH_ADOPTION_RULE, /STUCK rate nor the refusal count rises/);
  assert.match(BENCH_ADOPTION_RULE, /MDE/);
});

// ── the orchestrator, with a fake runner ─────────────────────────────────────

test('WP-4: runSkillBench refuses a repetition count below the rule floor of 3', async () => {
  await assert.rejects(
    runSkillBench({ fixtures: ['a'], repetitions: 2, arms: ['on', 'off'], stub: true, model: 'stub', runOne: async () => ({ firstAttemptSuccess: true, stuck: false, refusals: 0 }), now: () => 'x' }),
    /BENCH_REPETITIONS_TOO_FEW/,
  );
});

test('WP-4: runSkillBench refuses a comparison missing an arm', async () => {
  await assert.rejects(
    runSkillBench({ fixtures: ['a'], repetitions: 3, arms: ['on'], stub: true, model: 'stub', runOne: async () => ({ firstAttemptSuccess: true, stuck: false, refusals: 0 }), now: () => 'x' }),
    /BENCH_ARMS_INCOMPLETE/,
  );
});

test('WP-2: runSkillBench runs the full matrix and builds the paired comparison', async () => {
  const seen: string[] = [];
  const report = await runSkillBench({
    fixtures: ['f1', 'f2'],
    repetitions: 3,
    arms: ['on', 'off'],
    stub: true,
    model: 'stub/stub-code',
    runOne: async ({ fixture, arm, repetition }) => {
      seen.push(`${fixture}:${arm}:${repetition}`);
      // f1: on always passes, off never -> an on win. f2: the reverse -> an off win.
      const pass = fixture === 'f1' ? arm === 'on' : arm === 'off';
      return { firstAttemptSuccess: pass, stuck: false, refusals: 0, wallTimeMs: 5, tokens: 10 };
    },
    now: () => '2026-10-17T00:00:00.000Z',
  });
  assert.equal(seen.length, 2 * 3 * 2);
  assert.equal(report.fixtures, 2);
  assert.equal(report.repetitions, 3);
  assert.equal(report.model, 'stub/stub-code');
  assert.equal(report.stub, true);
  assert.ok(report.arms.on && report.arms.off);
  assert.deepEqual(report.pairs, { fixtures: 2, onWins: 1, offWins: 1, ties: 0 });
  assert.equal(report.wallTimeMs, 12 * 5);
  assert.equal(report.tokens, 12 * 10);
});

test('WP-2: runSkillBench reports tokens as null when no run reported any', async () => {
  const report = await runSkillBench({
    fixtures: ['f1'],
    repetitions: 3,
    arms: ['on', 'off'],
    stub: true,
    model: 'stub/stub-code',
    runOne: async () => ({ firstAttemptSuccess: true, stuck: false, refusals: 0, wallTimeMs: 2 }),
    now: () => 'x',
  });
  assert.equal(report.tokens, null, 'a token count the path did not report must be null, never a guess');
});

// ── the evidence gate ────────────────────────────────────────────────────────

test('WP-4: a stub report is refused as capability evidence, by name', () => {
  const verdict = benchReportEvidence({ stub: true, arms: { on: arm(3, 3), off: arm(3, 3) } });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.code, 'BENCH_STUB_NOT_EVIDENCE');
});

test('WP-4: a real report missing an arm is refused as evidence', () => {
  const verdict = benchReportEvidence({ stub: false, arms: { on: arm(3, 3) } });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.code, 'BENCH_NO_PAIRED_ARMS');
});

test('WP-4: a real, paired report is accepted as evidence', () => {
  assert.deepEqual(benchReportEvidence({ stub: false, arms: { on: arm(3, 3), off: arm(3, 3) } }), { ok: true });
});

// ── the stub dry pass, as a real subprocess ─────────────────────────────────

test('WP-4: the stub dry pass runs and emits a labelled, paired report', { timeout: 300_000 }, () => {
  const output = execFileSync('npx', [
    'tsx', 'scripts/bench-skills.ts',
    '--dry', '--limit', '1', '--repetitions', '3',
    '--now', '2026-10-17T00:00:00.000Z',
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const report = JSON.parse(output) as { stub: boolean; model: string; fixtures: number; repetitions: number; pairs: PairedSummary; wallTimeMs: number; tokens: number | null; arms: { on?: { firstAttempt: { n: number; low: number; high: number } }; off?: { firstAttempt: { n: number } } }; generatedAt: string };
  assert.equal(report.stub, true, 'the dry pass must be labelled stub: true');
  assert.equal(report.model, 'stub/stub-code');
  assert.equal(report.fixtures, 1);
  assert.equal(report.repetitions, 3);
  assert.equal(report.generatedAt, '2026-10-17T00:00:00.000Z');
  assert.equal(report.arms.on?.firstAttempt.n, 3, 'the on arm must have run every repetition');
  assert.equal(report.arms.off?.firstAttempt.n, 3, 'the off arm must have run every repetition');
  assert.ok(report.arms.on!.firstAttempt.high >= report.arms.on!.firstAttempt.low);
  assert.equal(report.pairs.fixtures, 1, 'the report must carry the paired comparison');
  assert.ok(typeof report.wallTimeMs === 'number' && report.wallTimeMs > 0, 'the report must carry wall time');
  assert.ok(report.tokens === null || typeof report.tokens === 'number', 'tokens must be a number or null, never a guess');
});

test('WP-4: package.json wires the bench scripts', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.match(pkg.scripts['bench:skills'], /bench-skills\.ts/);
  assert.match(pkg.scripts['bench:fixtures'], /bench-fixtures\.ts/);
});

// ── the "on" arm must actually inject, or the comparison is a lie ────────────

test('WP-4: the on-arm doctrine really turns injection on, so the arms differ', async () => {
  const { DoctrineService } = await import('../src/services/doctrineService');
  const { SkillInjectionService } = await import('../src/services/skillInjectionService');
  const crypto = await import('node:crypto');
  const os = await import('node:os');

  const source = DoctrineService.root();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-bench-test-'));
  fs.cpSync(source, root, { recursive: true });
  const loopPath = path.join(root, 'loop.json');
  const loop = JSON.parse(fs.readFileSync(loopPath, 'utf8')) as { skills: { inject: boolean; byRole: Record<string, string[]> } };
  loop.skills = { ...loop.skills, inject: true };
  fs.writeFileSync(loopPath, JSON.stringify(loop, null, 2));
  const covered = Object.keys((JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8')) as { files: Record<string, string> }).files);
  const files: Record<string, string> = {};
  for (const rel of covered) files[rel] = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex')}`;
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ version: 1, files }, null, 2));

  const previous = process.env.FACTORY_DOCTRINE_ROOT;
  try {
    process.env.FACTORY_DOCTRINE_ROOT = root;
    DoctrineService.clearCache();
    assert.equal(DoctrineService.load().loop.skills.inject, true, 'the on-arm doctrine must load with inject on');
    const advisory = SkillInjectionService.advisoryForImplementer(1);
    assert.ok(advisory.enabled, 'the on-arm advisory must be enabled');
    assert.match(advisory.block, /<<<SKILL: tdd>>>/, 'the on arm must actually inject the pinned implementer skill');
  } finally {
    if (previous === undefined) delete process.env.FACTORY_DOCTRINE_ROOT;
    else process.env.FACTORY_DOCTRINE_ROOT = previous;
    DoctrineService.clearCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
