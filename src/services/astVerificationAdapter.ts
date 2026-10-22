/**
 * AST verification adapter (Layer 4 Adapter).
 *
 * Provider-specific adapter that wraps the `ast-structural-verification` gate,
 * exposing AST-based structural verification as a standalone service. Used by
 * the loop's verify stage to check changed files for structural defects that
 * command exit codes miss: imports that cannot be resolved, imports of names a
 * module does not export, calls to names that are defined nowhere, and imports
 * that are never used.
 *
 * Read-only: parses source files into AST knowledge graphs, never writes to
 * a target tree. Deterministic: same source always yields the same verdict.
 *
 * **Severity is the contract.** A finding that is *provable* — a call to a name
 * that is defined nowhere in the repository and is not a global — blocks when
 * the file is TypeScript and the repository scan was complete. Everything else
 * is advisory: a forward reference to a file a later unit will create, an
 * import a later unit will satisfy, an unused import. A gate that blocks a
 * legitimate run is a gate operators learn to bypass, and a gate that never
 * blocks anything is a comment. This one states which is which.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  buildImportClosure,
  resolveRelativeModule,
  scanRepositorySources,
} from './repoKnowledgeIndex';
import type { SymbolNode } from './astKnowledgeGraph';

export type ASTIssueType =
  | 'undefined-import'
  | 'undefined-call'
  | 'unused-import';

export type ASTIssueSeverity = 'blocking' | 'advisory';

export interface ASTVerificationInput {
  /** Files to verify (relative to repo root). */
  files: string[];
  /** Repository root path. */
  repo: string;
  /** Whether to enforce (refuse on blocking issues) or just observe (shadow mode). */
  enforce?: boolean;
}

export interface ASTVerificationIssue {
  file: string;
  type: ASTIssueType;
  severity: ASTIssueSeverity;
  symbol: string;
  detail: string;
  /** Line of the offending construct, when the graph resolved it. */
  line?: number;
}

export interface ASTVerificationResult {
  /** True when there is no blocking issue (or enforce is off). */
  passed: boolean;
  /** All issues, blocking first. */
  issues: ASTVerificationIssue[];
  /** How many issues block. */
  blockingIssues: number;
  /** Files that were parsed. */
  filesParsed: number;
  /** Files in the import closure that were parsed to resolve definitions. */
  filesResolved: number;
  /** Symbols defined across the parsed closure. */
  symbolsDefined: number;
  /** True when the repository scan hit a ceiling and did not see everything. */
  truncated: boolean;
}

/**
 * Names that a runtime or an ambient type package provides without an import.
 *
 * The list is deliberately generous: a name wrongly believed to be undefined
 * would refuse a legitimate unit, and a name wrongly believed to be defined
 * costs one advisory finding. When in doubt, assume the runtime provides it.
 */
const AMBIENT_GLOBALS = new Set([
  // ECMAScript
  'Array', 'ArrayBuffer', 'BigInt', 'Boolean', 'Date', 'Error', 'EvalError', 'Function', 'Infinity',
  'Intl', 'JSON', 'Map', 'NaN', 'Number', 'Object', 'Promise', 'Proxy', 'RangeError', 'ReferenceError',
  'Reflect', 'RegExp', 'Set', 'String', 'Symbol', 'SyntaxError', 'TypeError', 'URIError', 'WeakMap',
  'WeakRef', 'WeakSet', 'BigInt64Array', 'BigUint64Array', 'Float32Array', 'Float64Array', 'Int8Array',
  'Int16Array', 'Int32Array', 'Uint8Array', 'Uint8ClampedArray', 'Uint16Array', 'Uint32Array', 'FinalizationRegistry',
  'SharedArrayBuffer', 'Atomics', 'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent',
  'escape', 'eval', 'globalThis', 'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'undefined', 'unescape',
  // Node
  'Buffer', '__dirname', '__filename', 'clearImmediate', 'clearInterval', 'clearTimeout', 'console', 'crypto',
  'exports', 'global', 'module', 'process', 'queueMicrotask', 'require', 'setImmediate', 'setInterval',
  'setTimeout', 'structuredClone', 'TextDecoder', 'TextEncoder', 'URL', 'URLSearchParams', 'AbortController',
  'AbortSignal', 'performance', 'fetch', 'Headers', 'Request', 'Response', 'FormData', 'Blob', 'BroadcastChannel',
  'Event', 'EventTarget', 'CustomEvent', 'DOMException', 'MessageChannel', 'MessagePort', 'Worker', 'WebSocket',
  // Browser / DOM
  'alert', 'cancelAnimationFrame', 'confirm', 'document', 'frames', 'getComputedStyle', 'history', 'localStorage',
  'location', 'matchMedia', 'navigator', 'parent', 'prompt', 'requestAnimationFrame', 'screen', 'self',
  'sessionStorage', 'top', 'window', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver',
  // Test runners, typically provided by ambient types
  'after', 'afterAll', 'afterEach', 'before', 'beforeAll', 'beforeEach', 'context', 'describe', 'expect', 'fit',
  'fdescribe', 'it', 'jest', 'should', 'specify', 'suite', 'test', 'vi', 'xit', 'xdescribe',
]);

/** True when the file is one TypeScript would type-check. */
function isTypeScriptFile(file: string): boolean {
  return /\.(ts|tsx|mts|cts)$/.test(file);
}

/** Verify files using AST structural analysis. */
export function verifyAST(input: ASTVerificationInput): ASTVerificationResult {
  const repo = path.resolve(input.repo);
  const seedFiles = input.files
    .map((file) => path.normalize(file))
    .filter((file) => /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(file))
    .filter((file) => {
      const absolute = path.resolve(repo, file);
      return fs.existsSync(absolute);
    });

  const issues: ASTVerificationIssue[] = [];

  if (!seedFiles.length) {
    return {
      passed: true,
      issues,
      blockingIssues: 0,
      filesParsed: 0,
      filesResolved: 0,
      symbolsDefined: 0,
      truncated: false,
    };
  }

  // The import closure is what makes "undefined" an honest word: a symbol
  // defined in a file this unit did not touch is still defined.
  const closure = buildImportClosure(repo, seedFiles);
  const blockingEnabled = input.enforce !== false;

  for (const file of seedFiles) {
    const graph = closure.graphs.get(file);
    if (!graph) continue;

    const imports = closure.importsByFile.get(file) ?? new Map<string, string>();

    for (const symbol of graph.symbols) {
      if (symbol.kind !== 'import' || !symbol.moduleSpec) continue;
      const moduleSpec = symbol.moduleSpec;
      const isRelative = moduleSpec.startsWith('./') || moduleSpec.startsWith('../');

      if (!isRelative) continue;

      const resolved = resolveRelativeModule(repo, file, moduleSpec);
      if (!resolved) {
        // The module does not exist in the repository yet. A later unit may
        // create it, so this is advisory — never a refusal.
        issues.push({
          file,
          type: 'undefined-import',
          severity: 'advisory',
          symbol: symbol.name,
          detail: `import of '${symbol.name}' from '${moduleSpec}' cannot be resolved to a file in the repository`,
          line: symbol.line,
        });
        continue;
      }

      const targetExports = closure.exportsByFile.get(resolved);
      if (!targetExports) continue;
      if (targetExports.has('*')) continue;
      if (targetExports.has(symbol.name)) continue;
      issues.push({
        file,
        type: 'undefined-import',
        severity: 'advisory',
        symbol: symbol.name,
        detail: `'${resolved}' does not export '${symbol.name}'`,
        line: symbol.line,
      });
    }

    for (const symbol of graph.symbols) {
      if (symbol.kind !== 'import') continue;
      if ((symbol.usages ?? 0) > 0) continue;
      issues.push({
        file,
        type: 'unused-import',
        severity: 'advisory',
        symbol: symbol.name,
        detail: `'${symbol.name}' is imported but never used in this file`,
        line: symbol.line,
      });
    }

    for (const edge of graph.edges) {
      if (edge.kind !== 'calls') continue;
      const target = edge.to;
      if (!target) continue;
      if (AMBIENT_GLOBALS.has(target)) continue;
      // Defined in this file.
      const local = graph.byName.get(target)?.some((candidate: SymbolNode) => candidate.kind !== 'import');
      if (local) continue;
      // Imported in this file: the module may be a forward reference to work a
      // later unit creates, so this is never a refusal.
      if (imports.has(target)) continue;
      // Defined anywhere in the import closure.
      if (closure.definedNames.has(target)) continue;

      const blocking = blockingEnabled && isTypeScriptFile(file) && !closure.truncated;
      issues.push({
        file,
        type: 'undefined-call',
        severity: blocking ? 'blocking' : 'advisory',
        symbol: target,
        detail: `'${target}' is called but is not defined, imported, or provided by the runtime`,
        line: edge.line,
      });
    }
  }

  const blockingIssues = issues.filter((issue) => issue.severity === 'blocking');
  const order = { blocking: 0, advisory: 1 } as const;
  issues.sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));

  return {
    passed: blockingIssues.length === 0,
    issues,
    blockingIssues: blockingIssues.length,
    filesParsed: closure.graphs.size,
    filesResolved: closure.graphs.size,
    symbolsDefined: closure.definedNames.size,
    truncated: closure.truncated,
  };
}

/** Scan a repository for source files without verifying anything (used by the L7 repo query). */
export function listRepositorySources(repo: string, maxFiles?: number): { files: string[]; truncated: boolean } {
  const scan = scanRepositorySources(repo, maxFiles ? { maxFiles } : {});
  return { files: scan.files, truncated: scan.truncated };
}

export interface ASTVerificationAdapter {
  verify(input: ASTVerificationInput): ASTVerificationResult;
}

export class ASTVerificationAdapterImpl implements ASTVerificationAdapter {
  verify(input: ASTVerificationInput): ASTVerificationResult {
    return verifyAST(input);
  }
}

export const astVerificationAdapter = new ASTVerificationAdapterImpl();
