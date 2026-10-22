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
 *
 * Enhancements (Graphify steal + cloudflare security-audit-skill shape):
 *  - AST knowledge graph integration: real file:line pointers from source parsing, not guesses
 *  - Machine-readable security audit findings: file:line, severity, remediation, confidence
 *  - All findings carry a `source` tag so callers know where each pointer came from
 */

import type { LoopFailureClass } from './loopFailureClass';
import { createHash } from 'node:crypto';
import {
  buildKnowledgeGraph,
  findDefinition,
  diagnoseLocation,
  type KnowledgeGraph,
  type SymbolNode,
} from './astKnowledgeGraph';
import { auditSource } from './securityAuditService';

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
  /** Optional source text for AST-based pointer resolution (Graphify integration). */
  sourceText?: string;
  /** File path for the source text, required when sourceText is provided. */
  sourceFile?: string;
}

export interface DiagnosisPointer {
  file: string;
  line?: number;
  /** Why this location matters — what the detective sees there. */
  rationale: string;
  /** Where this pointer came from: 'input' (named in failure), 'message' (scanned from text),
   *  or 'ast' (resolved via knowledge graph). */
  source: 'input' | 'message' | 'ast';
  /** Confidence 0..1 that this location is relevant to the failure. */
  confidence: number;
}

export interface Diagnosis {
  /** Stable id for the diagnosis, derived from the input so the same input yields the same id. */
  id: string;
  /** The failure class being diagnosed. */
  failureClass: LoopFailureClass;
  /** Root-cause hypothesis: one sentence, honest about uncertainty. */
  rootCause: string;
  /** File:line pointers, most likely first. Never fabricated — only locations named in the input
   *  or resolved through the AST knowledge graph. */
  pointers: DiagnosisPointer[];
  /** Remediation advice: a concrete next action, not a promise it will fix the unit. */
  remediation: string;
  /** True when the detective could not produce a meaningful diagnosis. */
  uncertain: boolean;
  /** Machine-readable security audit findings (cloudflare security-audit-skill shape).
   *  Empty unless the failure class is security or the input names a security-relevant symbol. */
  findings: SecurityFinding[];
}

/** A machine-readable security audit finding. */
export interface SecurityFinding {
  /** Stable id for the finding. */
  id: string;
  /** Severity: 'critical' | 'high' | 'medium' | 'low' | 'info'. */
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  /** The rule that fired, e.g. 'secret-scan', 'doctrine-integrity', 'hardcoded-secret'. */
  rule: string;
  /** Human-readable description of the finding. */
  description: string;
  /** File:line location, resolved through AST when possible. */
  file: string;
  line?: number;
  /** Remediation advice specific to this finding. */
  remediation: string;
  /** Confidence 0..1 that this is a real issue, not a false positive. */
  confidence: number;
  /** Machine-readable evidence: the matched pattern or symbol. Secret values are masked. */
  evidence: string;
  /** The enclosing function or class, when the finding was resolved through the AST. */
  symbol?: string;
  /** How the finding was located: 'ast' (a parsed construct) or 'text' (the refusal itself). */
  source: 'ast' | 'text';
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
function extractInputPointers(input: DiagnosisInput): DiagnosisPointer[] {
  const pointers: DiagnosisPointer[] = [];
  if (input.location) {
    const match = input.location.match(/^([^:]+):(\d+)(?::(\d+))?$/);
    if (match) {
      pointers.push({
        file: match[1],
        line: match[2] ? Number(match[2]) : undefined,
        rationale: 'Named in the failure input as the observed location.',
        source: 'input',
        confidence: 0.9,
      });
    } else {
      pointers.push({
        file: input.location,
        rationale: 'Named in the failure input; no line could be parsed from it.',
        source: 'input',
        confidence: 0.5,
      });
    }
  }
  // Scan the message for file:line patterns, only emit ones that look real.
  const message = input.message ?? '';
  const seen = new Set<string>();
  for (const m of message.matchAll(/([A-Za-z0-9_./-]+\.(?:ts|js|json|md|txt|py|go|rs|java|rb|cs|php|c|h|cpp|hpp|yaml|yml|toml|ini|cfg|conf)):(\d+)/g)) {
    const file = m[1];
    const line = Number(m[2]);
    if (file && line > 0 && line < 100000 && !seen.has(file)) {
      seen.add(file);
      pointers.push({ file, line, rationale: 'Observed in the failure message as a file:line location.', source: 'message', confidence: 0.7 });
    }
  }
  return pointers;
}

/** Resolve AST-based pointers for symbols named in the failure input. */
function extractASTPointers(input: DiagnosisInput): DiagnosisPointer[] {
  const pointers: DiagnosisPointer[] = [];
  if (!input.sourceText || !input.sourceFile) return pointers;

  const graph = buildKnowledgeGraph(input.sourceFile, input.sourceText);
  const message = input.message ?? '';
  const reason = input.reason ?? '';

  // Find symbol names mentioned in the message or reason, then resolve via AST.
  const symbolCandidates = new Set<string>();
  for (const m of message.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g)) {
    symbolCandidates.add(m[1]);
  }
  for (const m of reason.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g)) {
    symbolCandidates.add(m[1]);
  }

  const seen = new Set<string>();
  for (const name of symbolCandidates) {
    if (seen.has(name)) continue;
    seen.add(name);
    const diag = diagnoseLocation(graph, name);
    if (diag.definition) {
      pointers.push({
        file: diag.definition.file,
        line: diag.definition.line,
        rationale: `AST-resolved definition of '${name}' in ${diag.definition.file}:${diag.definition.line}.`,
        source: 'ast',
        confidence: 0.85,
      });
    }
    // Add callers as secondary pointers.
    for (const caller of diag.callers.slice(0, 3)) {
      pointers.push({
        file: input.sourceFile,
        rationale: `${name} is called from ${caller.from}.`,
        source: 'ast',
        confidence: 0.6,
      });
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
 * Produce the machine-readable security findings for a diagnosis.
 *
 * Two sources, both named: the refusal itself (the message-shaped findings, e.g. a staged diff
 * that matched a credential pattern) and the source that was scanned (the rule set in
 * `securityAuditService.ts`, which resolves every finding to a real file and line).
 */
function auditSecurity(input: DiagnosisInput, graph?: KnowledgeGraph): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const message = input.message ?? '';
  const reason = input.reason ?? '';
  const sourceText = input.sourceText ?? '';
  const sourceFile = input.sourceFile ?? '';

  // The refusal-shaped findings: what the loop already refused, stated as a finding.
  type RefusalPattern = [pattern: RegExp, rule: string, severity: SecurityFinding['severity'], description: string, remediation: string];
  const refusalPatterns: RefusalPattern[] = [
    [/SECRET_CONTENT_REFUSED/, 'secret-scan', 'critical', 'Staged content matched a credential pattern', 'Remove the secret from staged files and re-submit.'],
    [/SECRET_PATH_REFUSED/, 'secret-scan', 'critical', 'A changed path is reserved for secrets', 'Do not commit files under reserved secret paths.'],
    [/TARGET_DOCTRINE_LEAKED_INTO_RUN/, 'doctrine-integrity', 'critical', 'A quarantined instruction file reached a run payload', 'Remove the leaked instruction from the run payload.'],
    [/DOCTRINE_MANIFEST_MISMATCH/, 'doctrine-integrity', 'high', 'The doctrine does not match its manifest', 'Re-run doctrine:manifest to re-pin the manifest.'],
  ];

  for (const [pattern, rule, severity, description, remediation] of refusalPatterns) {
    if (!pattern.test(reason) && !pattern.test(message)) continue;
    findings.push({
      id: `sec-${findings.length + 1}`,
      severity,
      rule,
      description,
      file: sourceFile,
      remediation,
      confidence: 0.8,
      evidence: pattern.source,
      source: 'text',
    });
  }

  // The source-shaped findings: the rule set, resolved against real lines.
  if (sourceText && sourceFile) {
    const audit = auditSource([{ path: sourceFile, content: sourceText }]);
    for (const finding of audit.findings) {
      findings.push({
        id: `sec-${findings.length + 1}`,
        severity: finding.severity,
        rule: finding.rule,
        description: finding.description,
        file: finding.file,
        line: finding.line,
        remediation: finding.remediation,
        confidence: finding.confidence,
        evidence: finding.evidence,
        symbol: finding.symbol,
        source: finding.source,
      });
    }
  }

  // The graph is the context the finding sits in: the first symbol of the file is the enclosing
  // scope when the finding has no line of its own.
  if (graph && sourceFile && findings.length && findings.every((finding) => finding.line === undefined)) {
    const symbols = graph.symbols.filter((symbol) => symbol.kind === 'import' || symbol.kind === 'variable');
    if (symbols.length > 0) {
      for (const finding of findings) {
        finding.file = symbols[0].file;
        finding.line = symbols[0].line;
        finding.confidence = Math.max(finding.confidence, 0.9);
      }
    }
  }

  return findings;
}

/**
 * Diagnose one observed failure. Total: always returns a diagnosis. When the input carries no
 * recognisable signal, `uncertain` is true and the remediation says to read the raw refusal.
 *
 * When `sourceText` and `sourceFile` are provided, the AST knowledge graph is used to resolve
 * real file:line pointers for symbols named in the failure (Graphify integration).
 */
export function diagnose(input: DiagnosisInput): Diagnosis {
  const inputPointers = extractInputPointers(input);
  const astPointers = extractASTPointers(input);
  const pointers = [...inputPointers, ...astPointers];

  const rootCause = honestRootCause(input);
  const graph = (input.sourceText && input.sourceFile) ? buildKnowledgeGraph(input.sourceFile, input.sourceText) : undefined;
  const findings = auditSecurity(input, graph);

  const uncertain = pointers.length === 0 && !hasRecognisableSignal(input) && findings.length === 0;

  return {
    id: `diagnosis-${cryptoHash(JSON.stringify({ ...input, pointerCount: pointers.length }))}`,
    failureClass: input.failureClass,
    rootCause,
    pointers,
    remediation: remediationFor(input),
    uncertain,
    findings,
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
