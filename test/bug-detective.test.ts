/**
 * Bug detective (Layer 5 Diagnostic).
 *
 * Advisory, bounded, fail-closed. These tests prove:
 *
 *  - BD-1  a recognised failure class yields a diagnosis with root cause, pointers, remediation
 *  - BD-2  an unrecognised input yields uncertain=true and an honest remediation
 *  - BD-3  file:line pointers are only taken from the input, never guessed
 *  - BD-4  the same input always yields the same diagnosis (deterministic)
 *  - BD-5  the bug detective never refuses — it always returns a diagnosis
 *  - BD-6  the defect failure class has a distinct next step
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { bugDetectiveService, type DiagnosisInput } from '../src/services/bugDetectiveService';
import { nextStepForFailureClass } from '../src/services/stuckReportService';
import type { LoopFailureClass } from '../src/services/loopFailureClass';

const base: DiagnosisInput = {
  failureClass: 'defect' as LoopFailureClass,
  reason: 'DEFECT_DETECTED',
  message: 'src/utils/apiError.ts:42: unrecognised error code leaks internal path',
  stage: 'verify',
};

test('BD-1: a recognised failure class yields a diagnosis with root cause, pointers, remediation', () => {
  const d = bugDetectiveService.diagnose(base);
  assert.ok(d.id.length > 0, 'diagnosis must carry a stable id');
  assert.equal(d.failureClass, 'defect');
  assert.ok(d.rootCause.length > 0, 'root cause must be non-empty');
  assert.ok(d.remediation.length > 0, 'remediation must be non-empty');
  assert.ok(!d.uncertain, 'a recognised input must not be uncertain');
});

test('BD-2: an unrecognised input yields uncertain=true and an honest remediation', () => {
  const d = bugDetectiveService.diagnose({
    failureClass: 'unknown' as LoopFailureClass,
    reason: 'SOMETHING_WE_HAVE_NEVER_SEEN',
  });
  assert.ok(d.uncertain, 'an unrecognised input must be uncertain');
  assert.ok(d.rootCause.length > 0, 'root cause must still be present');
  assert.ok(d.remediation.length > 0, 'remediation must still be present');
  assert.equal(d.pointers.length, 0, 'no pointers when nothing is named');
});

test('BD-3: file:line pointers are only taken from the input, never guessed', () => {
  const d = bugDetectiveService.diagnose({
    ...base,
    location: 'src/services/loopGates.ts:127',
    message: 'a defect was detected during verification',
  });
  assert.equal(d.pointers.length, 1);
  assert.equal(d.pointers[0].file, 'src/services/loopGates.ts');
  assert.equal(d.pointers[0].line, 127);
  assert.ok(d.pointers[0].rationale.length > 0, 'pointer must carry a rationale');
});

test('BD-3b: pointers are also extracted from file:line patterns inside the message', () => {
  const d = bugDetectiveService.diagnose({
    failureClass: 'verification' as LoopFailureClass,
    message: 'src/utils/apiError.ts:42: unrecognised error code; src/services/loopGates.ts:127: gate missing',
  });
  const files = d.pointers.map((p) => p.file);
  assert.ok(files.includes('src/utils/apiError.ts'), 'must extract file:line from message');
  assert.ok(files.includes('src/services/loopGates.ts'), 'must extract multiple file:line from message');
});

test('BD-4: the same input always yields the same diagnosis (deterministic)', () => {
  const first = bugDetectiveService.diagnose(base);
  for (let i = 0; i < 50; i += 1) {
    const repeated = bugDetectiveService.diagnose(base);
    assert.equal(repeated.id, first.id, 'diagnosis id must be deterministic');
    assert.equal(repeated.rootCause, first.rootCause);
    assert.equal(repeated.remediation, first.remediation);
  }
});

test('BD-5: the bug detective never refuses — it always returns a diagnosis', () => {
  for (const failureClass of ['security', 'verification', 'review', 'model', 'defect', 'environment', 'policy', 'unknown'] as const) {
    const d = bugDetectiveService.diagnose({ failureClass });
    assert.ok(d.id.length > 0, `${failureClass} must yield an id`);
    assert.ok(d.rootCause.length > 0, `${failureClass} must yield a root cause`);
    assert.ok(d.remediation.length > 0, `${failureClass} must yield remediation`);
    assert.ok(Array.isArray(d.pointers), `${failureClass} must yield pointers array`);
  }
});

test('BD-6: the defect failure class has a distinct next step', () => {
  const step = nextStepForFailureClass('defect' as LoopFailureClass);
  assert.ok(step.length > 0, 'defect must have a next step');
  assert.ok(step.includes('VERIFY'), 'defect remediation must reference the verify gates');
  const classes: LoopFailureClass[] = ['security', 'verification', 'review', 'model', 'defect', 'environment', 'policy', 'unknown'];
  const steps = classes.map((c) => nextStepForFailureClass(c));
  assert.equal(new Set(steps).size, classes.length, 'each class must give its own next step');
});
