/**
 * Durable failure classification (Sprint 29, WP-3).
 *
 * The classifier is the sensor the learning digest (ADR-012) reads: if it guessed, or disagreed
 * with itself between runs, every count in the digest would be a fiction. So this suite does not
 * merely check a handful of happy paths — it asserts that *every* gate id the registry knows is
 * classified, that the classes are total over the real refusal codes the loop throws, and that an
 * unrecognized refusal is `unknown` rather than a plausible guess.
 *
 * The registry-completeness assertion is the guard: adding a gate without a class turns it red.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { GATE_IDS } from '../src/services/gateIds';
import {
  GATE_FAILURE_CLASSES,
  LOOP_FAILURE_CLASSES,
  classifyLoopFailure,
  runFailureClass,
  summariseFailureClasses,
  unclassifiedGateIds,
  type LoopFailureClass,
} from '../src/services/loopFailureClass';

// ── the taxonomy is total over the registry ────────────────────────────────

test('every gate id the registry knows has a failure class', () => {
  assert.deepEqual(
    unclassifiedGateIds(),
    [],
    'a gate was added to the registry without a failure class; its refusals would count as unknown',
  );
  assert.equal(
    Object.keys(GATE_FAILURE_CLASSES).length,
    GATE_IDS.length,
    'the class map and the gate registry must name the same set — no orphan class, no unclassified gate',
  );
});

test('every gate id classifies a GATE_REFUSED to a real class, never unknown', () => {
  for (const id of GATE_IDS) {
    const cls = classifyLoopFailure({
      stage: 'verify',
      reason: 'GATE_REFUSED',
      message: `GATE_REFUSED:verify:${id}:check failed`,
    });
    assert.notEqual(cls, 'unknown', `gate ${id} classified as unknown`);
    assert.ok(LOOP_FAILURE_CLASSES.includes(cls), `gate ${id} produced a class outside the taxonomy: ${cls}`);
  }
});

// ── the gate → class mapping is the one we documented ──────────────────────

test('each gate maps to the class its semantics imply', () => {
  const expected: Record<string, LoopFailureClass> = {
    'ground-truth': 'verification',
    'claimed-files-exist': 'model',
    'review-approve': 'review',
    'secret-scan': 'security',
    'doctrine-integrity': 'security',
    'doctrine-isolation': 'security',
    'resource-admission': 'environment',
    'no-op-unit': 'policy',
    'clean-tree': 'policy',
    'one-commit-per-unit': 'policy',
    'verified-commit-message': 'policy',
    'evidence-is-machine-derived': 'policy',
    'model-assignment': 'policy',
    'attempt-cap': 'policy',
    'plan-is-executable': 'policy',
    'unrelated-writes': 'policy',
  };
  assert.deepEqual(GATE_FAILURE_CLASSES, expected);
});

test('a GATE_REFUSED message is parsed for its gate ids, not read as free text', () => {
  // Two ids, comma-joined, exactly the shape `gateIdsFrom` in the driver produces.
  assert.equal(
    classifyLoopFailure({ stage: 'commit', reason: 'GATE_REFUSED', message: 'GATE_REFUSED:commit:clean-tree,one-commit-per-unit:two commits' }),
    'policy',
  );
  // The security gate wins regardless of the stage it fired at.
  assert.equal(
    classifyLoopFailure({ stage: 'commit', reason: 'GATE_REFUSED', message: 'GATE_REFUSED:commit:secret-scan:token in diff' }),
    'security',
  );
});

// ── real refusal codes, from the modules that throw them ───────────────────

test('the refusal codes the loop actually throws classify to their real class', () => {
  const cases: Array<[string, LoopFailureClass]> = [
    ['TARGET_DOCTRINE_LEAKED_INTO_RUN', 'security'],
    ['SECRET_CONTENT_REFUSED', 'security'],
    ['SECRET_PATH_REFUSED', 'security'],
    ['DOCTRINE_MANIFEST_MISMATCH', 'security'],
    ['GROUND_TRUTH_REQUIRED', 'verification'],
    ['REVIEW_OUTPUT_MALFORMED', 'review'],
    ['REVIEW_REJECTED_WITHOUT_FINDINGS', 'review'],
    ['IMPLEMENTER_OUTPUT_EMPTY', 'model'],
    ['IMPLEMENTER_OUTPUT_MALFORMED', 'model'],
    ['MODEL_PROVIDER_NOT_REGISTERED', 'model'],
    ['MODEL_NOT_REGISTERED_FOR_PROVIDER', 'model'],
    ['SANDBOX_TOOLCHAIN_HIDDEN', 'environment'],
    ['GIT_COMMAND_FAILED', 'environment'],
    ['NOTHING_STAGED', 'policy'],
    ['REPO_NOT_CLEAN', 'policy'],
  ];
  for (const [reason, expected] of cases) {
    assert.equal(classifyLoopFailure({ stage: 'commit', reason }), expected, `${reason} misclassified`);
  }
});

test('a leak is a security halt at any stage, whether it is the reason or buried in the message', () => {
  assert.equal(classifyLoopFailure({ stage: 'implement', reason: 'TARGET_DOCTRINE_LEAKED_INTO_RUN' }), 'security');
  assert.equal(
    classifyLoopFailure({ stage: 'plan', reason: 'GATE_REFUSED', message: 'GATE_REFUSED:plan::TARGET_DOCTRINE_LEAKED_INTO_RUN: AGENTS.md' }),
    'security',
  );
});

// ── fail closed: unknown is a real answer ──────────────────────────────────

test('an unrecognized refusal code is unknown, never a plausible guess', () => {
  assert.equal(classifyLoopFailure({ stage: 'commit', reason: 'SOMETHING_WE_HAVE_NEVER_SEEN' }), 'unknown');
  assert.equal(classifyLoopFailure({ stage: 'plan', reason: '' }), 'unknown');
});

test('with no code and no gate, the stage is the last honest signal', () => {
  assert.equal(classifyLoopFailure({ stage: 'verify', reason: 'UNKNOWN' }), 'verification');
  assert.equal(classifyLoopFailure({ stage: 'review', reason: 'UNKNOWN' }), 'review');
  assert.equal(classifyLoopFailure({ stage: 'implement', reason: 'UNKNOWN' }), 'unknown');
});

// ── determinism and summary ────────────────────────────────────────────────

test('classification is deterministic: the same input yields the same class every time', () => {
  const input = { stage: 'verify' as const, reason: 'GATE_REFUSED', message: 'GATE_REFUSED:verify:ground-truth:exit 1' };
  const first = classifyLoopFailure(input);
  for (let index = 0; index < 50; index += 1) assert.equal(classifyLoopFailure(input), first);
});

test('summariseFailureClasses counts, orders by count then severity, and names the dominant class', () => {
  const attempts = [
    { failureClass: 'verification' as const },
    { failureClass: 'verification' as const },
    { failureClass: 'security' as const },
    { failureClass: undefined },
  ];
  const { counts, dominant } = summariseFailureClasses(attempts);
  assert.deepEqual(counts, [
    { failureClass: 'verification', count: 2 },
    { failureClass: 'security', count: 1 },
  ]);
  assert.equal(dominant, 'verification');

  // A tie breaks by the fixed severity order (security before verification), so the digest is
  // not at the mercy of Map insertion order.
  const tied = summariseFailureClasses([{ failureClass: 'verification' as const }, { failureClass: 'security' as const }]);
  assert.deepEqual(tied.counts.map((entry) => entry.failureClass), ['security', 'verification']);
});

test('runFailureClass reads the attempts first, then a run-level hard stop, and is absent when clean', () => {
  assert.equal(runFailureClass([{ failureClass: 'review' as const }]), 'review');
  assert.equal(runFailureClass([], 'wall-clock after 360.0m (cap 360m)'), 'environment');
  assert.equal(runFailureClass([], 'total attempts 90 (cap 90)'), 'policy');
  assert.equal(runFailureClass([], 'unit M1: GATE_REFUSED:verify:ground-truth:exit 1'), 'policy');
  assert.equal(runFailureClass([], undefined), undefined);
  // Attempts win over a hard stop: the class of what actually failed, not of the wall clock that
  // later stopped the run.
  assert.equal(runFailureClass([{ failureClass: 'model' as const }], 'wall-clock after 360.0m'), 'model');
});
