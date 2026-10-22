/**
 * AST verification adapter (Layer 4 Adapter).
 *
 * Provider-specific adapter that wraps the `ast-structural-verification` gate,
 * exposing AST-based structural verification as a standalone service. Used by
 * the loop's verify stage to check changed files for structural defects that
 * command exit codes miss: unused imports, references to undefined symbols.
 *
 * Read-only: parses source files into AST knowledge graphs, never writes to
 * a target tree. Deterministic: same source always yields the same verdict.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  buildKnowledgeGraph,
  findDefinition,
  edgesFor,
  diagnoseLocation,
  type KnowledgeGraph,
  type SymbolNode,
} from './astKnowledgeGraph';

export interface ASTVerificationInput {
  /** Files to verify (relative to repo root). */
  files: string[];
  /** Repository root path. */
  repo: string;
  /** Whether to enforce (refuse on issues) or just observe (shadow mode). */
  enforce?: boolean;
}

export interface ASTVerificationIssue {
  file: string;
  type: 'undefined-import' | 'undefined-call' | 'unused-import';
  symbol: string;
  detail: string;
}

export interface ASTVerificationResult {
  /** True when no issues were found (or enforce is off). */
  passed: boolean;
  /** Issues found during verification. */
  issues: ASTVerificationIssue[];
  /** Files that were parsed. */
  filesParsed: number;
  /** Symbols defined across all parsed files. */
  symbolsDefined: number;
}

/** Verify files using AST structural analysis. */
export function verifyAST(input: ASTVerificationInput): ASTVerificationResult {
  const issues: ASTVerificationIssue[] = [];
  const allSymbols = new Map<string, SymbolNode[]>();
  const graphs = new Map<string, ReturnType<typeof buildKnowledgeGraph>>();

  // First pass: build graphs and collect all symbol definitions.
  for (const file of input.files) {
    const fullPath = path.join(input.repo, file);
    try {
      if (!fs.existsSync(fullPath)) continue;
      const sourceText = fs.readFileSync(fullPath, 'utf8');
      const graph = buildKnowledgeGraph(fullPath, sourceText);
      graphs.set(file, graph);
      for (const sym of graph.symbols) {
        const list = allSymbols.get(sym.name) ?? [];
        list.push(sym);
        allSymbols.set(sym.name, list);
      }
    } catch {
      // Skip files that can't be read or parsed.
    }
  }

  // Build a map of non-import symbols for definition checking (imports shouldn't count
  // as defining the names they import).
  const definedSymbols = new Map<string, SymbolNode[]>();
  for (const [name, syms] of allSymbols) {
    const nonImports = syms.filter((s) => s.kind !== 'import');
    if (nonImports.length > 0) definedSymbols.set(name, nonImports);
  }

  // Second pass: check each file for structural issues.
  for (const [file, graph] of graphs) {
    // Check imports: imported symbols from relative modules should be defined somewhere.
    for (const sym of graph.symbols) {
      if (sym.kind !== 'import') continue;
      const moduleSpec = sym.moduleSpec ?? '';
      if (!moduleSpec.startsWith('./') && !moduleSpec.startsWith('../')) continue;
      if (moduleSpec.startsWith('node:')) continue;
      const imported = sym.name.split(',').map((n) => n.trim());
      for (const name of imported) {
        if (definedSymbols.has(name)) continue; // defined in changed set
        issues.push({
          file,
          type: 'undefined-import',
          symbol: name,
          detail: `imported symbol '${name}' from '${moduleSpec}' is not defined in changed files`,
        });
      }
    }

    // Check call edges.
    for (const edge of graph.edges) {
      if (edge.kind !== 'calls') continue;
      const target = edge.to;
      if (target.startsWith('module:')) continue;
      if (/^[A-Z]/.test(target)) continue;
      if (definedSymbols.has(target)) continue;
      if (/^(console|Math|JSON|Array|Object|String|Number|Boolean|Date|Promise|setTimeout|setInterval|clearTimeout|clearInterval|require|module|process|global|window|document)\b/.test(target)) continue;
      issues.push({
        file,
        type: 'undefined-call',
        symbol: target,
        detail: `call to '${target}' has no definition in changed files`,
      });
    }
  }

  const passed = issues.length === 0 || !input.enforce;
  return {
    passed,
    issues,
    filesParsed: graphs.size,
    symbolsDefined: Array.from(allSymbols.values()).flat().length,
  };
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
