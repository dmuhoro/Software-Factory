/**
 * The resource governor's sample seam.
 *
 * The suite pins a benign host sample in `setup-isolate-env.ts` so the loop-driving tests measure
 * the loop and not the developer's desktop. That raises the question this file answers: does the
 * governor still govern? A seam that quietly disabled the check would be a protection that no
 * longer protects anything — exactly the failure this repository treats as worse than none.
 *
 * So these cases pin the *other* way: they clear the override, prove the real host is read, then
 * feed the governor a host that is genuinely short and prove it still refuses, by name, and by
 * throwing. The seam swaps the input; the budgets, the comparisons and the fail-closed refusal all
 * still run.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import test from 'node:test';
import { ResourceGovernorService } from '../src/services/resourceGovernorService';

test('cleared, the sampler reads the real host', () => {
  ResourceGovernorService.setSamplerForTests(null);
  const sample = ResourceGovernorService.sample();
  assert.equal(sample.cpus, os.cpus().length || 1, 'the real CPU count was not read');
  const expected = os.loadavg()[0] / (os.cpus().length || 1);
  assert.ok(Math.abs(sample.loadAvgPerCpu - expected) < 0.5, `the real load was not read: ${sample.loadAvgPerCpu} vs ${expected}`);
  assert.ok(sample.freeMemMb > 0, 'the real free memory was not read');
});

test('a pinned benign sample admits, and a pinned short sample refuses by name', () => {
  try {
    ResourceGovernorService.setSamplerForTests(() => ({ cpus: 8, freeMemMb: 8192, loadAvgPerCpu: 0.25 }));
    const ok = ResourceGovernorService.admit(1);
    assert.equal(ok.admitted, true, 'a benign sample must admit');
    assert.equal(ok.maxParallel, 1);

    ResourceGovernorService.setSamplerForTests(() => ({ cpus: 8, freeMemMb: 8192, loadAvgPerCpu: 9 }));
    const loaded = ResourceGovernorService.admit(1);
    assert.equal(loaded.admitted, false, 'a loaded host must refuse');
    assert.equal(loaded.maxParallel, 0, 'a refusal grants no workers');
    assert.ok(loaded.reasons.some((reason) => reason.startsWith('LOAD:')), `the refusal did not name LOAD: ${loaded.reasons.join('; ')}`);

    ResourceGovernorService.setSamplerForTests(() => ({ cpus: 8, freeMemMb: 64, loadAvgPerCpu: 0 }));
    const starved = ResourceGovernorService.admit(1);
    assert.equal(starved.admitted, false, 'a starved host must refuse');
    assert.ok(starved.reasons.some((reason) => reason.startsWith('MEMORY:')), `the refusal did not name MEMORY: ${starved.reasons.join('; ')}`);
  } finally {
    ResourceGovernorService.setSamplerForTests(null);
  }
});

test('a pinned short sample makes assertAdmitted throw, not warn', () => {
  try {
    ResourceGovernorService.setSamplerForTests(() => ({ cpus: 8, freeMemMb: 64, loadAvgPerCpu: 9 }));
    assert.throws(() => ResourceGovernorService.assertAdmitted(1), /^Error: RESOURCE_EXHAUSTED:/, 'the short host was not refused by throw');
  } finally {
    ResourceGovernorService.setSamplerForTests(null);
  }
});
