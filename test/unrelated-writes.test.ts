/**
 * WP-5: the unrelated-writes guard, in shadow mode.
 *
 * The property under test: a working-tree change that the implementer did not claim is *observed*.
 * `claimed-files-exist` refuses a claimed file that did not change; nothing in the loop looked at
 * the other direction — a file that changed and was never claimed. That is the cross-cutting write:
 * a formatter's rewrite, a codegen side effect, residue from a tool the unit ran, all of which would
 * be committed under a message that describes only the claimed work.
 *
 * It ships as a sensor, not yet an enforcer. The destructive default is `enforce: false`: the write
 * is recorded with the file named and nothing is refused, so an operator can see what the guard
 * would refuse in their repository before it has the power to refuse it. These tests pin both the
 * record and the (opt-in) refusal, and pin the wiring that makes the gate reachable at all.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { GATE_IDS } from '../src/services/gateIds';
import { registeredGateIds, runGate, type GateContext } from '../src/services/loopGates';
import { unclassifiedGateIds } from '../src/services/loopFailureClass';
import { parseLoopConfig } from '../src/services/doctrineService';
import type { GroundTruthProof } from '../src/services/groundTruthService';
import type { LoopRunRecord } from '../src/services/loopTypes';
import type { IsolationManifest } from '../src/services/doctrineIsolationService';

function proof(claimedFiles: string[], observedFiles: string[]): GroundTruthProof {
  return {
    passed: true,
    repo: '/tmp/unrelated-writes',
    head: '0'.repeat(40),
    checks: [],
    claimedFiles,
    observedFiles,
    rejectedNarration: [],
    recordedAt: new Date(0).toISOString(),
  };
}

function ctx(proofValue: GroundTruthProof, policy: { enforce: boolean; allow: string[] }): GateContext {
  return {
    stage: 'commit',
    timing: 'before',
    repo: '/tmp/unrelated-writes',
    isolation: { quarantine: [] } as unknown as IsolationManifest,
    run: {} as LoopRunRecord,
    proof: proofValue,
    unrelatedWrites: policy,
  };
}

const SHADOW = { enforce: false, allow: [] };
const ENFORCE = { enforce: true, allow: [] };

test('an unclaimed write is recorded in shadow mode and refuses nothing', () => {
  const result = runGate('unrelated-writes', ctx(proof(['src/a.ts'], ['src/a.ts', 'src/b.ts']), SHADOW));
  assert.equal(result.passed, true, 'the shadow guard must never refuse');
  assert.match(result.detail, /SHADOW: would refuse 1 unrelated write/, `detail did not record the shadow refusal: ${result.detail}`);
  assert.match(result.detail, /src\/b\.ts/, 'the shadow record must name the file it would refuse');
});

test('with enforcement on, the same write becomes a refusal that names the file', () => {
  const result = runGate('unrelated-writes', ctx(proof(['src/a.ts'], ['src/a.ts', 'src/b.ts']), ENFORCE));
  assert.equal(result.passed, false, 'enforcement must refuse an unrelated write');
  assert.match(result.detail, /did not claim/, `refusal did not state the reason: ${result.detail}`);
  assert.match(result.detail, /src\/b\.ts/, 'the refusal must name the file');
  assert.ok(!/SHADOW/.test(result.detail), 'an enforced refusal is not a shadow record');
});

test('a path or basename on the allowlist is claimed without being listed', () => {
  const byBasename = runGate('unrelated-writes', ctx(proof(['src/a.ts'], ['src/a.ts', 'dist/b.ts']), { enforce: true, allow: ['b.ts'] }));
  assert.equal(byBasename.passed, true, 'an allowlisted basename was still refused');
  assert.match(byBasename.detail, /allowlisted/, `detail did not state the allowlist cleared it: ${byBasename.detail}`);

  const byPattern = runGate('unrelated-writes', ctx(proof(['src/a.ts'], ['src/a.ts', 'pnpm-lock.yaml']), { enforce: true, allow: ['*.lock', 'pnpm-lock.yaml'] }));
  assert.equal(byPattern.passed, true, 'an allowlisted path pattern was still refused');
});

test('a tree where every observed file was claimed passes with nothing to record', () => {
  const result = runGate('unrelated-writes', ctx(proof(['src/a.ts', 'src/b.ts'], ['src/a.ts', 'src/b.ts']), ENFORCE));
  assert.equal(result.passed, true);
  assert.ok(!/SHADOW/.test(result.detail), 'a fully claimed tree is not a shadow refusal');
  assert.match(result.detail, /claimed or allowlisted/);
});

test('a stage with no proof is inert, never a refusal', () => {
  const result = runGate('unrelated-writes', {
    stage: 'commit',
    timing: 'before',
    repo: '/tmp/unrelated-writes',
    isolation: { quarantine: [] } as unknown as IsolationManifest,
    run: {} as LoopRunRecord,
  });
  assert.equal(result.passed, true, 'a missing proof is unknown, not a failure');
  assert.match(result.detail, /no proof/);
});

test('the gate is registered, classified, and therefore reachable', () => {
  assert.ok(GATE_IDS.includes('unrelated-writes'), 'the gate id is not declared');
  assert.ok(registeredGateIds().includes('unrelated-writes'), 'the gate has no implementation');
  assert.deepEqual(unclassifiedGateIds(), [], 'a gate id has no failure class');
});

// ── the doctrine boundary ────────────────────────────────────────────────────

function shippedLoop(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'doctrine', 'loop.json'), 'utf8')) as Record<string, unknown>;
}

test('the shipped doctrine resolves the guard to shadow mode with an empty allowlist', () => {
  const parsed = parseLoopConfig(shippedLoop());
  assert.deepEqual(parsed.unrelatedWrites, { enforce: false, allow: [] }, 'the shipped guard must not enforce');
});

test('an absent block defaults to shadow mode, and a malformed one is refused', () => {
  const absent = shippedLoop();
  delete absent.unrelatedWrites;
  assert.deepEqual(parseLoopConfig(absent).unrelatedWrites, { enforce: false, allow: [] }, 'an absent guard must default to shadow');

  const malformed = shippedLoop();
  malformed.unrelatedWrites = { enforce: 'yes', allow: [] };
  assert.throws(() => parseLoopConfig(malformed), /unrelatedWrites:enforce must be a boolean/, 'a non-boolean enforce must be refused');

  const badAllow = shippedLoop();
  badAllow.unrelatedWrites = { enforce: false, allow: [1] };
  assert.throws(() => parseLoopConfig(badAllow), /unrelatedWrites:allow must be an array of non-empty strings/, 'a non-string allowlist entry must be refused');
});
