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
 *  - BD-7  AST knowledge graph resolves real file:line pointers (Graphify steal)
 *  - BD-8  machine-readable security audit findings (cloudflare security-audit-skill shape)
 *  - BD-9  AST-resolved pointers carry source:'ast' and confidence
 *  - BD-10 security findings carry severity, rule, file, line, remediation, confidence, evidence
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

const SOURCE_WITH_SECRET = `import { readFileSync } from 'node:fs';

const API_KEY = 'sk-1234567890abcdef1234567890abcdef';

export function loadConfig(): unknown {
  return readFileSync(process.env.CONFIG_PATH, 'utf8');
}
`;

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

test('BD-7: AST knowledge graph resolves real file:line pointers (Graphify steal)', () => {
  const d = bugDetectiveService.diagnose({
    failureClass: 'defect' as LoopFailureClass,
    reason: 'DEFECT_DETECTED',
    message: 'loadConfig returned undefined',
    stage: 'verify',
    sourceText: SOURCE_WITH_SECRET,
    sourceFile: '/repo/src/config.ts',
  });
  const astPointers = d.pointers.filter((p) => p.source === 'ast');
  assert.ok(astPointers.length > 0, 'AST must resolve at least one pointer');
  for (const p of astPointers) {
    assert.equal(p.source, 'ast');
    assert.ok(p.confidence > 0, 'AST pointer must carry confidence');
    assert.ok(p.rationale.includes('config.ts'), 'AST pointer must reference the source file');
  }
});

test('BD-8: machine-readable security audit findings (cloudflare security-audit-skill shape)', () => {
  const d = bugDetectiveService.diagnose({
    failureClass: 'security' as LoopFailureClass,
    reason: 'SECRET_CONTENT_REFUSED',
    message: 'Staged content matched a credential pattern',
    stage: 'commit',
    sourceText: SOURCE_WITH_SECRET,
    sourceFile: '/repo/src/config.ts',
  });
  assert.ok(d.findings.length > 0, 'security diagnosis must produce findings');
  for (const f of d.findings) {
    assert.ok(f.id.length > 0, 'finding must have an id');
    assert.ok(['critical','high','medium','low','info'].includes(f.severity), 'finding must have a valid severity');
    assert.ok(f.rule.length > 0, 'finding must name a rule');
    assert.ok(f.description.length > 0, 'finding must have a description');
    assert.ok(f.file.length > 0, 'finding must name a file');
    assert.ok(f.remediation.length > 0, 'finding must have remediation');
    assert.ok(f.confidence > 0 && f.confidence <= 1, 'finding must carry confidence 0..1');
    assert.ok(f.evidence.length > 0, 'finding must carry evidence');
  }
});

test('BD-9: AST-resolved pointers carry source:ast and confidence', () => {
  const d = bugDetectiveService.diagnose({
    failureClass: 'verification' as LoopFailureClass,
    reason: 'GROUND_TRUTH_REQUIRED',
    message: 'loadConfig failed to produce valid output',
    stage: 'verify',
    sourceText: SOURCE_WITH_SECRET,
    sourceFile: '/repo/src/config.ts',
  });
  const astPointers = d.pointers.filter((p) => p.source === 'ast');
  assert.ok(astPointers.length > 0, 'must resolve AST pointers for loadConfig');
  for (const p of astPointers) {
    assert.equal(p.source, 'ast');
    assert.ok(p.confidence >= 0.5 && p.confidence <= 1, 'confidence must be 0.5..1');
  }
});

test('BD-10: security findings carry severity, rule, file, line, remediation, confidence, evidence', () => {
  const d = bugDetectiveService.diagnose({
    failureClass: 'security' as LoopFailureClass,
    reason: 'SECRET_CONTENT_REFUSED',
    message: 'staged content contains hardcoded API key',
    stage: 'commit',
    sourceText: SOURCE_WITH_SECRET,
    sourceFile: '/repo/src/config.ts',
  });
  const hardcodedFindings = d.findings.filter((f) => f.rule === 'hardcoded-secret');
  assert.ok(hardcodedFindings.length > 0, 'must detect hardcoded secret in source');
  for (const f of hardcodedFindings) {
    assert.ok(f.line !== undefined, 'hardcoded secret finding must have a line number');
    assert.ok(f.line! > 0, 'line number must be positive');
    assert.ok(f.severity === 'high' || f.severity === 'critical', 'hardcoded secret must be high or critical severity');
  }
});

