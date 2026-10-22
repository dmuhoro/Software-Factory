/**
 * Security audit (Layer 5 Diagnostic).
 *
 * The cloudflare security-audit-skill shape, adapted to SF constraints: a machine-readable
 * finding per issue, each with a file, a line, a severity, a remediation, a confidence, and the
 * evidence that produced it.
 *
 * Three properties this service holds to:
 *
 *  - **Advisory.** It reports; it never blocks, never edits, and never writes to a target tree.
 *    A finding is a claim about code, and the code is still judged by the L2 gates.
 *  - **Evidence, not vibes.** Every finding points at a real line of real source, and the
 *    evidence is the matched construct — never a paraphrase of it.
 *  - **No secret in the evidence.** A finding that quotes a hardcoded credential would copy the
 *    credential into the ledger, the API response, and (through them) into a commit. Secret
 *    values are masked: the first three characters and the length, nothing else.
 *
 * Deterministic: the same source always yields the same findings, in the same order.
 */

import * as ts from 'typescript';

export type SecuritySeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface SecurityFinding {
  /** Stable id for the finding. */
  id: string;
  /** The rule that fired. */
  rule: string;
  /** Severity of the finding. */
  severity: SecuritySeverity;
  /** What the finding says. */
  description: string;
  /** The file, repository-relative. */
  file: string;
  /** The line the finding points at. */
  line?: number;
  /** What to do about it. */
  remediation: string;
  /** How sure the service is that this is a real issue. */
  confidence: number;
  /** The construct that produced the finding. Secret values are masked. */
  evidence: string;
  /** The enclosing function or class, when there is one. */
  symbol?: string;
  /** How the location was resolved: 'ast' (a parsed construct) or 'text' (a matched literal). */
  source: 'ast' | 'text';
}

export interface AuditFile {
  /** Repository-relative path. */
  path: string;
  /** The file's source. */
  content: string;
}

export interface SecurityAuditResult {
  /** Findings, most severe first, then by file and line. */
  findings: SecurityFinding[];
  /** How many files were audited. */
  filesScanned: number;
  /** The rules this service can fire. */
  rules: string[];
}

/** Mask a secret so a finding can quote it without copying it. */
function maskSecret(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 4) return `${trimmed.slice(0, 1)}*** (${trimmed.length} chars)`;
  return `${trimmed.slice(0, 3)}*** (${trimmed.length} chars)`;
}

/** Secret shapes that are unmistakably credentials when they appear as a literal. */
const SECRET_LITERAL_PATTERNS: Array<{ pattern: RegExp; rule: string; severity: SecuritySeverity; description: string; remediation: string }> = [
  { pattern: /^AKIA[0-9A-Z]{16}$/, rule: 'hardcoded-secret', severity: 'critical', description: 'AWS access key id hardcoded in source', remediation: 'Move the key to the secret manager and reference it through an allowlisted secret reference.' },
  { pattern: /^sk-[A-Za-z0-9]{20,}$/, rule: 'hardcoded-secret', severity: 'critical', description: 'API key hardcoded in source', remediation: 'Move the key to the secret manager and reference it through an allowlisted secret reference.' },
  { pattern: /^gh[pousr]_[A-Za-z0-9]{36,}$/, rule: 'hardcoded-secret', severity: 'critical', description: 'GitHub token hardcoded in source', remediation: 'Revoke the token, then read it from the secret manager at runtime.' },
  { pattern: /^-----BEGIN [A-Z ]*PRIVATE KEY-----/, rule: 'hardcoded-private-key', severity: 'critical', description: 'Private key material hardcoded in source', remediation: 'Revoke the key pair and store the private key in the secret manager.' },
];

/** Names that make a string literal a credential. */
const SECRET_NAME_PATTERN = /(password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?key|token|credential|private[_-]?key)/i;

/** Names that make a logged value a credential. */
const SECRET_LOG_NAME_PATTERN = /(password|passwd|secret|token|api[_-]?key|apikey|credential|private[_-]?key)/i;

/** The calls that run a shell. */
const SHELL_CALLS = new Set(['exec', 'execSync', 'spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']);

/** The calls that read or write a path. */
const PATH_CALLS = new Set(['readFile', 'readFileSync', 'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createReadStream', 'createWriteStream', 'unlink', 'unlinkSync', 'rm', 'rmSync']);

/** The calls that execute code the parser did not see. */
const DYNAMIC_EXECUTION_CALLS = new Set(['eval', 'Function']);

interface WalkState {
  findings: Omit<SecurityFinding, 'id'>[];
  file: string;
  sourceFile: ts.SourceFile;
  counter: { n: number };
  scope: string[];
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function isStringLiteral(node: ts.Node): node is ts.StringLiteral {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

/** The literal text of a node, when it is a literal. */
function literalText(node: ts.Node): string | undefined {
  if (isStringLiteral(node)) return node.text;
  return undefined;
}

/** A short, safe excerpt of a construct. */
function excerpt(node: ts.Node, sourceFile: ts.SourceFile, limit = 160): string {
  return node.getText(sourceFile).replace(/\s+/g, ' ').slice(0, limit);
}

function pushFinding(state: WalkState, finding: Omit<SecurityFinding, 'id'>): void {
  state.counter.n += 1;
  state.findings.push(finding);
}

/** The name of the callee of a call expression, whether it is `fn()` or `a.b()`. */
function calleeName(call: ts.CallExpression): string | undefined {
  const expression = call.expression;
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

/** True when the argument is built at runtime rather than written as a literal. */
function isDynamicArgument(node: ts.Node): boolean {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return false;
  if (ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isTemplateExpression(node)) return true;
  if (ts.isIdentifier(node)) return true;
  if (ts.isBinaryExpression(node)) return true;
  if (ts.isCallExpression(node)) return true;
  return false;
}

/** Walk one file's source and collect findings. */
function auditFile(file: AuditFile): Omit<SecurityFinding, 'id'>[] {
  const sourceFile = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);
  const state: WalkState = { findings: [], file: file.path, sourceFile, counter: { n: 0 }, scope: [] };

  const visit = (node: ts.Node): void => {
    const line = lineOf(sourceFile, node);

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const literal = literalText(node.initializer);
      if (literal !== undefined) {
        for (const shape of SECRET_LITERAL_PATTERNS) {
          if (!shape.pattern.test(literal.trim())) continue;
          pushFinding(state, {
            rule: shape.rule,
            severity: shape.severity,
            description: shape.description,
            file: file.path,
            line,
            remediation: shape.remediation,
            confidence: 0.95,
            evidence: maskSecret(literal),
            symbol: state.scope[state.scope.length - 1],
            source: 'ast',
          });
        }
        if (SECRET_NAME_PATTERN.test(node.name.text) && literal.trim().length >= 8) {
          pushFinding(state, {
            rule: 'hardcoded-secret',
            severity: 'high',
            description: `A credential-shaped value is assigned to '${node.name.text}'`,
            file: file.path,
            line,
            remediation: 'Read the value from the secret manager at runtime instead of assigning it in source.',
            confidence: 0.75,
            evidence: `${node.name.text} = ${maskSecret(literal)}`,
            symbol: state.scope[state.scope.length - 1],
            source: 'ast',
          });
        }
      }
    }

    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const name = property.name.getText(state.sourceFile).replace(/['"]/g, '');
        const value = property.initializer;
        if (name === 'rejectUnauthorized' && value.kind === ts.SyntaxKind.FalseKeyword) {
          pushFinding(state, {
            rule: 'tls-verification-disabled',
            severity: 'critical',
            description: 'TLS certificate verification is disabled',
            file: file.path,
            line,
            remediation: 'Remove `rejectUnauthorized: false`. If the certificate is the problem, fix the trust store.',
            confidence: 0.95,
            evidence: excerpt(property, state.sourceFile),
            symbol: state.scope[state.scope.length - 1],
            source: 'ast',
          });
        }
        if (name === 'algorithm' && literalText(value)?.toLowerCase() === 'none') {
          pushFinding(state, {
            rule: 'jwt-algorithm-none',
            severity: 'critical',
            description: 'A token is signed or verified with the "none" algorithm',
            file: file.path,
            line,
            remediation: 'Refuse the "none" algorithm outright and pin an explicit algorithm.',
            confidence: 0.9,
            evidence: excerpt(property, state.sourceFile),
            symbol: state.scope[state.scope.length - 1],
            source: 'ast',
          });
        }
        if (name === 'shell' && value.kind === ts.SyntaxKind.TrueKeyword) {
          pushFinding(state, {
            rule: 'command-injection',
            severity: 'high',
            description: 'A child process is started through a shell',
            file: file.path,
            line,
            remediation: 'Pass an argument array without a shell, so the arguments are never re-parsed.',
            confidence: 0.85,
            evidence: excerpt(property, state.sourceFile),
            symbol: state.scope[state.scope.length - 1],
            source: 'ast',
          });
        }
      }
    }

    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') {
      pushFinding(state, {
        rule: 'dynamic-code-execution',
        severity: 'high',
        description: 'Code is built at runtime with `new Function`',
        file: file.path,
        line,
        remediation: 'Replace the dynamic function with an explicit implementation.',
        confidence: 0.9,
        evidence: excerpt(node, state.sourceFile),
        symbol: state.scope[state.scope.length - 1],
        source: 'ast',
      });
    }

    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name && DYNAMIC_EXECUTION_CALLS.has(name)) {
        pushFinding(state, {
          rule: 'dynamic-code-execution',
          severity: 'high',
          description: `Code is executed at runtime with \`${name}\``,
          file: file.path,
          line,
          remediation: 'Replace the dynamic execution with an explicit implementation.',
          confidence: 0.9,
          evidence: excerpt(node, state.sourceFile),
          symbol: state.scope[state.scope.length - 1],
          source: 'ast',
        });
      }
      if (name && SHELL_CALLS.has(name)) {
        const dynamic = node.arguments.filter((argument) => isDynamicArgument(argument));
        if (dynamic.length) {
          pushFinding(state, {
            rule: 'command-injection',
            severity: 'high',
            description: `A shell command is built from a runtime value (\`${name}\`)`,
            file: file.path,
            line,
            remediation: 'Never interpolate a runtime value into a command. Pass an argument array, and validate the value first.',
            confidence: 0.8,
            evidence: excerpt(node, state.sourceFile),
            symbol: state.scope[state.scope.length - 1],
            source: 'ast',
          });
        }
      }
      if (name && PATH_CALLS.has(name)) {
        const first = node.arguments[0];
        if (first && isDynamicArgument(first)) {
          pushFinding(state, {
            rule: 'unvalidated-path',
            severity: 'medium',
            description: `A filesystem path is taken from a runtime value (\`${name}\`)`,
            file: file.path,
            line,
            remediation: 'Resolve the path inside the repository root and refuse anything that escapes it.',
            confidence: 0.6,
            evidence: excerpt(node, state.sourceFile),
            symbol: state.scope[state.scope.length - 1],
            source: 'ast',
          });
        }
      }
      if (name && (name === 'createHash' || name === 'createHmac')) {
        const algorithm = node.arguments[0] ? literalText(node.arguments[0])?.toLowerCase() : undefined;
        if (algorithm === 'md5' || algorithm === 'sha1') {
          pushFinding(state, {
            rule: 'weak-hash',
            severity: 'medium',
            description: `A weak hash algorithm is used for security purposes (${algorithm})`,
            file: file.path,
            line,
            remediation: 'Use SHA-256 or stronger. MD5 and SHA-1 are not collision resistant.',
            confidence: 0.7,
            evidence: excerpt(node, state.sourceFile),
            symbol: state.scope[state.scope.length - 1],
            source: 'ast',
          });
        }
      }
      if (name === 'random' && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(state.sourceFile) === 'Math') {
        pushFinding(state, {
          rule: 'predictable-random',
          severity: 'low',
          description: 'A predictable random source is used',
          file: file.path,
            line,
          remediation: 'Use `crypto.randomUUID` or `crypto.randomBytes` for anything that must not be guessable.',
          confidence: 0.6,
          evidence: excerpt(node, state.sourceFile),
          symbol: state.scope[state.scope.length - 1],
          source: 'ast',
        });
      }
      if (name && (name === 'log' || name === 'info' || name === 'warn' || name === 'error' || name === 'debug')) {
        const receiver = node.expression;
        const isConsole = ts.isPropertyAccessExpression(receiver) && receiver.expression.getText(state.sourceFile) === 'console';
        if (isConsole) {
          const leaks = node.arguments.filter((argument) => {
            if (!ts.isIdentifier(argument)) return false;
            return SECRET_LOG_NAME_PATTERN.test(argument.text);
          });
          if (leaks.length) {
            pushFinding(state, {
              rule: 'secret-in-log',
              severity: 'medium',
              description: 'A credential-shaped value is written to the log',
              file: file.path,
              line,
              remediation: 'Log the identifier of the credential, never the credential.',
              confidence: 0.7,
              evidence: excerpt(node, state.sourceFile),
              symbol: state.scope[state.scope.length - 1],
              source: 'ast',
            });
          }
        }
      }
    }

    const entersScope =
      ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isClassDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node);
    if (entersScope) {
      const name = (node as ts.NamedDeclaration).name;
      state.scope.push(name && ts.isIdentifier(name) ? name.text : '<anonymous>');
    }
    ts.forEachChild(node, visit);
    if (entersScope) state.scope.pop();
  };

  visit(sourceFile);
  return state.findings;
}

const SEVERITY_ORDER: Record<SecuritySeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

/** The rules this service can fire. */
export const SECURITY_AUDIT_RULES = [
  'hardcoded-secret',
  'hardcoded-private-key',
  'dynamic-code-execution',
  'command-injection',
  'unvalidated-path',
  'tls-verification-disabled',
  'jwt-algorithm-none',
  'weak-hash',
  'predictable-random',
  'secret-in-log',
];

/**
 * Audit source files and return machine-readable findings.
 *
 * Advisory by construction: the caller decides what to do with a finding, and this service
 * never blocks, edits, or writes.
 */
export function auditSource(files: AuditFile[]): SecurityAuditResult {
  const collected: Omit<SecurityFinding, 'id'>[] = [];
  for (const file of files) {
    collected.push(...auditFile(file));
  }

  collected.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.file.localeCompare(b.file) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      a.rule.localeCompare(b.rule),
  );

  return {
    findings: collected.map((finding, index) => ({ ...finding, id: `sec-${index + 1}` })),
    filesScanned: files.length,
    rules: [...SECURITY_AUDIT_RULES],
  };
}
