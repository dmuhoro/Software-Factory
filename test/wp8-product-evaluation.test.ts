/**
 * WP-8: the evaluation harness scores a product on what it did, and scores a known-bad
 * product low.
 *
 * The factory already persisted a 0-100 score (`FactoryJobService.recordLaunchQuality`), but
 * it was a function of which metadata objects existed on the job, not of the product's own
 * signals. A product whose verification failed could still collect the security points because
 * a security evidence line was present. This file puts the evaluator on trial against a
 * product that is genuinely bad and against a real scanner's verdict, not a fixture that
 * merely lacks metadata.
 *
 * Failing-first: reverting `productEvaluationService` to presence-based dimensions (or the
 * `recordLaunchQuality` delegate to the old inline rubric) makes the known-bad assertions fail;
 * the good control still passes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-wp8-ws-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-wp8-data-'));
process.env.NODE_ENV = 'test';
process.env.FACTORY_DATA_DIR = DATA_DIR;
process.env.FACTORY_WORKSPACE_ROOT = WORKSPACE;
delete process.env.ALLOW_INSECURE_LOCAL;

const { evaluateProduct } = await import('../src/services/productEvaluationService');
const { FactoryJobService } = await import('../src/services/factoryJobService');
const { ContextIndexService } = await import('../src/services/contextIndexService');
const { QualityGateService } = await import('../src/services/qualityGateService');
const { DurableStore } = await import('../src/services/durableStore');

/** A product that did everything right. */
function goodSignals() {
  return {
    verificationPassed: true,
    securityStatus: 'PASSED' as const,
    highSeverityFindings: 0,
    reviewApproved: true,
    reviewFindings: 0,
    changedFiles: 4,
    evidenceKinds: ['verification', 'security', 'review', 'preview'],
    hasRepositoryRun: true,
    hasPreview: true,
    hasProductBrief: true,
    hasImplementationPlan: true,
    unitsStuck: 0,
  };
}

/**
 * A known-bad product: it has a brief and a plan (so it *looks* disciplined), but verification
 * failed, the security scan blocked it, and it produced no preview. The old presence-based
 * scorer awarded 20 for productDiscipline and 5 for evidence and called that a pass.
 */
function knownBadSignals() {
  return {
    verificationPassed: false,
    failureClass: 'TEST' as const,
    securityStatus: 'BLOCKED' as const,
    highSeverityFindings: 2,
    reviewApproved: false,
    reviewFindings: 3,
    changedFiles: 1,
    evidenceKinds: ['verification'],
    hasRepositoryRun: true,
    hasPreview: false,
    hasProductBrief: true,
    hasImplementationPlan: true,
    unitsStuck: 0,
  };
}

test('WP-8: a clean product scores full marks with no deductions', () => {
  const evaluation = evaluateProduct(goodSignals());
  assert.equal(evaluation.score, 100);
  assert.deepEqual(evaluation.reasons, []);
});

test('WP-8: a known-bad product scores low and names every deduction', () => {
  const evaluation = evaluateProduct(knownBadSignals());
  assert.ok(evaluation.score < 40, `known-bad product scored ${evaluation.score}, expected < 40`);
  assert.equal(evaluation.dimensions.verification, 0, 'a failed verification earns no verification points');
  assert.equal(evaluation.dimensions.security, 0, 'a blocked security scan earns no security points');
  assert.equal(evaluation.dimensions.operability, 0, 'an un-previewable product is not operable');
  assert.equal(evaluation.dimensions.productDiscipline, 0, 'a review-rejected product earns no discipline points');
  assert.ok(evaluation.reasons.some((reason) => /verification failed/.test(reason)));
  assert.ok(evaluation.reasons.some((reason) => /security scan blocked/.test(reason)));
});

test('WP-8: an unobserved dimension fails closed rather than granting full marks', () => {
  const noSecurity = evaluateProduct({ ...goodSignals(), securityStatus: undefined });
  assert.equal(noSecurity.dimensions.security, 0, 'a product with no security scan cannot earn security points');
  const notReviewed = evaluateProduct({ ...goodSignals(), reviewApproved: undefined });
  assert.equal(notReviewed.dimensions.productDiscipline, 20, 'an un-reviewed but briefed product keeps its base points');
});

test('WP-8: a real scan of a real planted secret blocks the product and zeroes security', () => {
  const repo = path.join(WORKSPACE, 'known-bad-repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  // A high-severity AWS access key in source. No package-lock.json, so the network-bound
  // dependency audit is skipped and only the deterministic secret scan runs.
  fs.writeFileSync(path.join(repo, 'config.ts'), 'export const awsKey = "AKIAIOSFODNN7EXAMPLE";\n', 'utf8');

  const scan = QualityGateService.scan('tenant_wp8', repo);
  assert.equal(scan.status, 'BLOCKED', 'a planted high-severity secret must block the product');
  assert.ok(scan.findings.some((finding) => finding.rule === 'secret-pattern'));

  const evaluation = evaluateProduct({ ...knownBadSignals(), securityStatus: scan.status });
  assert.equal(evaluation.dimensions.security, 0);
  assert.ok(evaluation.score < 40);
});

test('WP-8: recordLaunchQuality persists the evaluator score for a known-bad job', () => {
  const tenantId = 'tenant_wp8_e2e';
  const job = FactoryJobService.create({ tenantId, title: 'Known bad product', problem: 'It does not work', desiredOutcome: 'It works' });
  // Give it the shape of a finished-but-bad job: a brief and a plan (so it looks disciplined),
  // a security evidence line (which the old presence-based rubric would award 20 points for),
  // but a SECURITY-class verification failure and no preview or repository run.
  const seeded = {
    ...job,
    productBrief: { problem: job.problem, audience: 'a', valueHypothesis: 'v', wedge: 'w', nonGoals: [], acceptanceCriteria: [], createdAt: new Date().toISOString() },
    implementationPlan: { objective: 'o', contextRefs: [], inheritedPatterns: [], qualityGates: [], steps: [], verificationCommand: 'npm run verify', generatedAt: new Date().toISOString() },
    evidence: [{ kind: 'security-review', description: 'a review happened', recordedAt: new Date().toISOString() }],
    verificationRun: { command: 'npm run verify', profile: { id: 'p', name: 'n', steps: [], detectedFrom: [] }, passed: false, exitCode: 1, output: 'leaked credential', failedStep: 'secret-scan', failureClass: 'SECURITY', startedAt: new Date().toISOString(), completedAt: new Date().toISOString() },
  };
  DurableStore.upsert('factoryJobs', job.id, seeded as unknown as Record<string, unknown>);

  const snapshot = FactoryJobService.recordLaunchQuality(tenantId, job.id);
  assert.ok(snapshot.score < 40, `persisted score was ${snapshot.score}, expected < 40`);
  assert.equal(snapshot.dimensions.verification, 0);
  assert.equal(snapshot.dimensions.security, 0, 'a SECURITY failure class must zero the security dimension');

  const history = ContextIndexService.qualityHistory(tenantId);
  assert.equal(history.length, 1);
  assert.equal(history[0].score, snapshot.score);
});
