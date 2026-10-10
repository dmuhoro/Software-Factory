/**
 * Product evaluation: a pure, 0-100 score over a generated product's real signals.
 *
 * The factory already persisted a score (`FactoryJobService.recordLaunchQuality`), but it was
 * derived from the *presence* of job metadata -- a security evidence entry, a preview object,
 * a brief -- rather than from what the product actually did. A product whose verification
 * failed but whose job carried a security record still scored the security points. The score
 * looked measured and was not.
 *
 * This module is the evaluator that presence-based scorer should have been: a pure function of
 * observable signals. It fails closed (an unobserved dimension scores 0, never full marks),
 * and it names every deduction in `reasons` so a score can be argued with rather than trusted.
 *
 * The five dimensions and their weights are unchanged from the existing rubric
 * (verification 25, security 20, evidence 20, operability 15, productDiscipline 20), so
 * baselines and history remain comparable.
 */

import type { FailureClass } from './verificationProfileService';

export interface ProductSignals {
  /** Did the product's own verification command pass? */
  verificationPassed: boolean;
  /** If verification failed, its classified reason. */
  failureClass?: FailureClass;
  /** Result of a real `QualityGateService.scan`. Absent means "not observed", which fails closed. */
  securityStatus?: 'PASSED' | 'BLOCKED';
  highSeverityFindings: number;
  /** Adversarial review verdict. Absent means "not reviewed". */
  reviewApproved?: boolean;
  reviewFindings: number;
  changedFiles: number;
  evidenceKinds: string[];
  hasRepositoryRun: boolean;
  hasPreview: boolean;
  hasProductBrief: boolean;
  hasImplementationPlan: boolean;
  unitsStuck?: number;
}

export interface ProductDimensions {
  verification: number;
  security: number;
  evidence: number;
  operability: number;
  productDiscipline: number;
}

export interface ProductEvaluation {
  score: number;
  dimensions: ProductDimensions;
  /** Named deductions, in the order applied. Empty only for a clean product. */
  reasons: string[];
}

const WEIGHTS = { verification: 25, security: 20, evidence: 20, operability: 15, productDiscipline: 20 } as const;

/** A product must be observed before it can score. Nothing observed is a zero, not a pass. */
export function evaluateProduct(signals: ProductSignals): ProductEvaluation {
  const reasons: string[] = [];

  // Verification: 25 only for a clean pass. A pass carrying a failure class is contradictory,
  // so it is treated as a failure rather than trusted.
  let verification = 0;
  if (signals.verificationPassed && !signals.failureClass) {
    verification = WEIGHTS.verification;
  } else if (signals.failureClass) {
    reasons.push(`verification failed (${signals.failureClass})`);
  } else {
    reasons.push('verification did not pass');
  }

  // Security: fail closed. Only an observed PASSED scan earns points; an unobserved or BLOCKED
  // scan earns none. HIGH findings deduct further, floored at zero.
  let security = 0;
  if (signals.securityStatus === 'PASSED') {
    security = Math.max(0, WEIGHTS.security - signals.highSeverityFindings * 5);
    if (security < WEIGHTS.security) reasons.push(`security scan passed with ${signals.highSeverityFindings} high-severity finding(s)`);
  } else if (signals.securityStatus === 'BLOCKED') {
    reasons.push('security scan blocked the product');
  } else {
    reasons.push('no security scan was observed');
  }

  // Evidence: 5 points per recorded evidence kind, capped.
  const evidence = Math.min(WEIGHTS.evidence, signals.evidenceKinds.length * 5);
  if (evidence === 0) reasons.push('no evidence was recorded');

  // Operability: the product must be built, changed something, be previewable, and have no stuck units.
  let operability = 0;
  const stuck = signals.unitsStuck ?? 0;
  if (signals.hasRepositoryRun && signals.hasPreview && stuck === 0 && signals.changedFiles > 0) {
    operability = WEIGHTS.operability;
  } else if (stuck > 0) {
    reasons.push(`${stuck} unit(s) did not complete`);
  } else if (!signals.hasRepositoryRun) {
    reasons.push('the product was never built into a repository');
  } else if (signals.changedFiles === 0) {
    reasons.push('the product changed no files');
  } else {
    reasons.push('the product has no preview artifact');
  }

  // Product discipline: brief + plan must exist, and adversarial review must not have rejected
  // it. Findings deduct 5 each, floored at zero.
  let productDiscipline = 0;
  if (signals.hasProductBrief && signals.hasImplementationPlan) {
    if (signals.reviewApproved === false) {
      reasons.push('adversarial review rejected the product');
    } else {
      productDiscipline = Math.max(0, WEIGHTS.productDiscipline - signals.reviewFindings * 5);
      if (productDiscipline < WEIGHTS.productDiscipline) reasons.push(`adversarial review raised ${signals.reviewFindings} finding(s)`);
    }
  } else {
    reasons.push('the product has no brief or no implementation plan');
  }

  const dimensions: ProductDimensions = { verification, security, evidence, operability, productDiscipline };
  const score = dimensions.verification + dimensions.security + dimensions.evidence + dimensions.operability + dimensions.productDiscipline;
  return { score, dimensions, reasons };
}
