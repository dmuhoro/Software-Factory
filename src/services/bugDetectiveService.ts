/**
 * Bug detective (Layer 5 Diagnostic).
 *
 * Advisory, bounded, fail-closed. Given an observed failure — an error message, a file:line
 * location, the stage the loop was in — it produces a diagnosis: a root-cause hypothesis,
 * file:line pointers, and remediation advice.
 *
 * It never writes to a target tree. It never edits code. Any fix it suggests still runs
 * VERIFY → REVIEW → COMMIT through L2 gates. If it cannot produce a diagnosis it says so
 * explicitly rather than guessing; a wrong diagnosis is worse than no diagnosis.
 *
 * Pure: no clock, no model, no I/O beyond reading the input. The same input always yields the
 * same diagnosis, so a diagnosis is reproducible evidence, not a vibe.
 */

import type { LoopFailureClass } from './loopFailureClass';
import { createHash } from 'node:crypto';

export interface DiagnosisInput {
  /** The failure class the loop already assigned (e.g. 'defect', 'verification', 'review'). */
  failureClass: LoopFailureClass;
  /** The refusal reason / error code, if any. */
  reason?: string;
  /** The full error or refusal message, if any. */
  message?: string;
  /** The stage the loop was in when the failure occurred. */
  stage?: string;
  /** A file:line pointer observed in the failure, if any. */
  location?: string;
}

export interface DiagnosisPointer {
  file: string;
  line?: number;
  /** Why this location matters — what the detective sees there. */
  rationale: string;
}

export interface Diagnosis {
  /** Stable id for the diagnosis, derived from the input so the same input yields the same id. */
  id: string;
  /** The failure class being diagnosed. */
  failureClass: LoopFailureClass;
  /** Root-cause hypothesis: one sentence, honest about uncertainty. */
  rootCause: string;
  /** File:line pointers, most likely first. Never fabricated — only locations named in the input. */
  pointers: DiagnosisPointer[];
  /** Remediation advice: a concrete next action, not a promise it will fix the unit. */
  remediation: string;
  /** True when the detective could not produce a meaningful diagnosis. */
  uncertain: boolean;
}

/** Does the input carry any recognisable signal (reason code, message marker, or location)? */
function hasRecognisableSignal(input: DiagnosisInput): boolean {
  if (input.location) return true;
  const reason = input.reason ?? '';
  const message = input.message ?? '';
  const known = [
    /^(DEFECT_|BUG_)/,
    /TARGET_DOCTRINE_LEAKED_INTO_RUN/,
    /SECRET_/,
    /DOCTRINE_MANIFEST_MISMATCH/,
    /GROUND_TRUTH_/,
    /REVIEW_/,
    /^(MODEL_|MODEL_PROVIDER_)/,
    /^(IMPLEMENTER_)/,
    /^(SANDBOX_|GIT_|WORKTREE_|DOCTRINE_ROOT_)/,
    /^merge-conflict/,
    /^NOTHING_STAGED/,
    /^(REPO_NOT_CLEAN|LOOP_|TASK_DOCUMENT_|TARGET_REPOSITORY_|GATE_REFUSED|GATE_NOT_IMPLEMENTED)/,
    /exit 1/,
    /non-zero exit/,
  ];
  return known.some((pattern) => pattern.test(reason) || pattern.test(message));
}

/** One sentence, honest about uncertainty. */
function honestRootCause(input: DiagnosisInput): string {
  const { failureClass, reason, message, stage } = input;
  const msg = message ?? '';
  if (reason && /^(DEFECT_|BUG_)/.test(reason)) {
    return `A ${failureClass} defect was reported at ${stage ?? 'an unknown stage'}: ${reason}.`;
  }
  if (msg.includes('exit 1') || msg.includes('non-zero exit')) {
    return `A ${failureClass} failure at ${stage ?? 'an unknown stage'} exited non-zero; the command output names the line to inspect.`;
  }
  if (msg.includes('TARGET_DOCTRINE_LEAKED_INTO_RUN')) {
    return `A security halt at ${stage ?? 'an unknown stage'}: a quarantined instruction file reached a run payload.`;
  }
  if (msg.includes('SECRET_')) {
    return `A security refusal at ${stage ?? 'an unknown stage'}: staged content matched a credential pattern.`;
  }
  if (msg.includes('REVIEW_') || stage === 'review') {
    return `A review refusal at ${stage ?? 'an unknown stage'}: the reviewer objected to the change on one or more axes.`;
  }
  if (msg.includes('VERIFY_') || msg.includes('GROUND_TRUTH_') || stage === 'verify') {
    return `A verification failure at ${stage ?? 'an unknown stage'}: the declared check did not pass on the produced tree.`;
  }
  if (msg.includes('MODEL_') || stage === 'implement') {
    return `A model fault at ${stage ?? 'an unknown stage'}: the implementer returned output the loop could not use.`;
  }
  return `A ${failureClass} failure at ${stage ?? 'an unknown stage'} with no recognised signal in the refusal; inspect the raw attempt detail before acting.`;
}

/** Extract file:line pointers only from locations named in the input — never guess. */
function extractPointers(input: DiagnosisInput): DiagnosisPointer[] {
  const pointers: DiagnosisPointer[] = [];
  if (input.location) {
    const match = input.location.match(/^([^:]+):(\d+)(?::(\d+))?$/);
    if (match) {
      pointers.push({
        file: match[1],
        line: match[2] ? Number(match[2]) : undefined,
        rationale: 'Named in the failure input as the observed location.',
      });
    } else {
      pointers.push({
        file: input.location,
        rationale: 'Named in the failure input; no line could be parsed from it.',
      });
    }
  }
  // Also scan the message for file:line patterns, but only emit ones that look real.
  const message = input.message ?? '';
  const seen = new Set<string>();
  for (const m of message.matchAll(/([A-Za-z0-9_./-]+\.(?:ts|js|json|md|txt|py|go|rs|java|rb|cs|php|c|h|cpp|hpp|yaml|yml|toml|ini|cfg|conf)):(\d+)/g)) {
    const file = m[1];
    const line = Number(m[2]);
    if (file && line > 0 && line < 100000 && !seen.has(file)) {
      seen.add(file);
      pointers.push({ file, line, rationale: 'Observed in the failure message as a file:line location.' });
    }
  }
  return pointers;
}

/** Concrete, class-specific remediation advice. Never a promise; always a first move. */
function remediationFor(input: DiagnosisInput): string {
  const { failureClass } = input;
  switch (failureClass) {
    case 'security':
      return 'Do not retry unattended: inspect the secret-scan or doctrine-integrity refusal, remove the offending content, and only then re-submit.';
    case 'verification':
      return 'Reproduce the failing command by hand in the repository, fix the implementation (or the declared check if it is wrong), then re-submit only once verification passes.';
    case 'review':
      return 'Read the reviewer findings on each axis, address the specific objection, and re-submit; a repeated review refusal usually means ambiguous acceptance criteria.';
    case 'model':
      return 'Check the provider is registered and enabled and that the model follows the JSON file-manifest contract, then re-submit.';
    case 'environment':
      return 'Run `npm run verify:host` on the executor host and clear the repository state before re-submitting.';
    case 'defect':
      return 'Read the diagnosis above, reproduce the defect by hand, implement the fix under VERIFY → REVIEW → COMMIT, and re-submit only once verification passes.';
    case 'policy':
      return 'Read which loop rule fired and change the design so the unit does real, claimed work.';
    case 'unknown':
    default:
      return 'Read the attempt reason and detail verbatim in the unit report and diagnose from the raw refusal; if it recurs, it needs a new class in loopFailureClass.ts.';
  }
}

/**
 * Diagnose one observed failure. Total: always returns a diagnosis. When the input carries no
 * recognisable signal, `uncertain` is true and the remediation says to read the raw refusal.
 */
export function diagnose(input: DiagnosisInput): Diagnosis {
  const pointers = extractPointers(input);
  const rootCause = honestRootCause(input);
  const uncertain = pointers.length === 0 && !hasRecognisableSignal(input);

  return {
    id: `diagnosis-${cryptoHash(JSON.stringify(input))}`,
    failureClass: input.failureClass,
    rootCause,
    pointers,
    remediation: remediationFor(input),
    uncertain,
  };
}

function cryptoHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

export interface BugDetectiveService {
  diagnose(input: DiagnosisInput): Diagnosis;
}

export class BugDetectiveServiceImpl implements BugDetectiveService {
  diagnose(input: DiagnosisInput): Diagnosis {
    return diagnose(input);
  }
}

export const bugDetectiveService = new BugDetectiveServiceImpl();
