/**
 * AST knowledge graph (Layer 2/5/5/7 shared utility).
 *
 * Deterministic AST parsing of TypeScript/JavaScript source into a
 * queryable knowledge graph: nodes are symbols (functions, classes,
 * variables, imports, exports), edges are references and definitions.
 * No vector store, no ML, no clock, no I/O beyond parsing the text
 * handed to it. The same source always yields the same graph.
 *
 * This is the Graphify steal, adapted to SF constraints: TypeScript
 * compiler API (already a dependency), local-first, deterministic,
 * bounded to one file at a time. Editors and layers query the graph;
 * nothing here writes to a target tree.
 */

import * as ts from 'typescript';

export interface SymbolNode {
  id: string;           // stable: filePath#symbolName#kind
  file: string;
  name: string;
  kind: 'function' | 'class' | 'variable' | 'import' | 'export' | 'interface' | 'type';
  line: number;
  column?: number;
  signature?: string;   // truncated declaration text, for evidence
  /** Module specifier for imports (e.g. './other', 'react', 'node:fs'). Undefined for non-imports. */
  moduleSpec?: string;
}

export interface GraphEdge {
  from: string;   // symbol id
  to: string;     // symbol id or external reference string
  kind: 'calls' | 'imports' | 'defines' | 'references' | 'exports';
}

export interface KnowledgeGraph {
  file: string;
  symbols: SymbolNode[];
  edges: GraphEdge[];
  /** Symbols indexed by name for fast lookup. */
  byName: Map<string, SymbolNode[]>;
  /** Symbols indexed by id. */
  byId: Map<string, SymbolNode>;
}

/** Parse one source file into a knowledge graph. Pure and deterministic. */
export function buildKnowledgeGraph(filePath: string, sourceText: string): KnowledgeGraph {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const symbols: SymbolNode[] = [];
  const edges: GraphEdge[] = [];
  const symbolIdCounter = { n: 0 };

  function nextId(): string {
    symbolIdCounter.n += 1;
    return `sym-${symbolIdCounter.n}`;
  }

  function getKind(node: ts.Node): SymbolNode['kind'] | null {
    switch (node.kind) {
      case ts.SyntaxKind.FunctionDeclaration: return 'function';
      case ts.SyntaxKind.MethodDeclaration: return 'function';
      case ts.SyntaxKind.ClassDeclaration: return 'class';
      case ts.SyntaxKind.VariableDeclaration: return 'variable';
      case ts.SyntaxKind.ImportDeclaration: return 'import';
      case ts.SyntaxKind.ExportAssignment:
      case ts.SyntaxKind.ExportDeclaration: return 'export';
      case ts.SyntaxKind.InterfaceDeclaration: return 'interface';
      case ts.SyntaxKind.TypeAliasDeclaration: return 'type';
      default: return null;
    }
  }

  function getSymbolName(node: ts.Node): string | null {
    switch (node.kind) {
      case ts.SyntaxKind.FunctionDeclaration:
      case ts.SyntaxKind.MethodDeclaration:
      case ts.SyntaxKind.ClassDeclaration:
      case ts.SyntaxKind.InterfaceDeclaration:
      case ts.SyntaxKind.TypeAliasDeclaration: {
        const decl = node as ts.FunctionLikeDeclaration | ts.ClassDeclaration | ts.InterfaceDeclaration | ts.TypeAliasDeclaration;
        const nameNode = decl.name;
        if (!nameNode) return null;
        if (ts.isIdentifier(nameNode)) return nameNode.text;
        if (ts.isStringLiteral(nameNode) || ts.isNumericLiteral(nameNode)) return nameNode.text;
        return null;
      }
      case ts.SyntaxKind.VariableDeclaration: {
        const nameNode = (node as ts.VariableDeclaration).name;
        if (ts.isIdentifier(nameNode)) return nameNode.text;
        return null;
      }
      case ts.SyntaxKind.ImportDeclaration: {
        const clause = (node as ts.ImportDeclaration).importClause;
        if (clause?.name) return clause.name.text;
        const named = clause?.namedBindings;
        if (named && ts.isNamedImports(named)) {
          return named.elements.map((e) => e.name.text).join(', ');
        }
        return null;
      }
      case ts.SyntaxKind.ExportDeclaration:
      case ts.SyntaxKind.ExportAssignment:
        return 'export';
      default:
        return null;
    }
  }

  function walk(node: ts.Node, parentId: string | null = null): void {
    const kind = getKind(node);
    const name = getSymbolName(node);
    const pos = node.getStart(sourceFile);
    const lineAndCol = sourceFile.getLineAndCharacterOfPosition(pos);

    if (kind && name) {
      const id = nextId();
      const declText = sourceText.slice(pos, node.getEnd()).replace(/\s+/g, ' ').slice(0, 200);
      const symbol: SymbolNode = {
        id,
        file: filePath,
        name,
        kind,
        line: lineAndCol.line + 1,
        column: lineAndCol.character + 1,
        signature: declText,
      };
      // Capture module specifier for imports.
      if (kind === 'import' && node.kind === ts.SyntaxKind.ImportDeclaration) {
        const imp = node as ts.ImportDeclaration;
        if (ts.isStringLiteral(imp.moduleSpecifier)) {
          symbol.moduleSpec = imp.moduleSpecifier.text;
        }
      }
      symbols.push(symbol);

      if (parentId) {
        edges.push({ from: parentId, to: id, kind: 'defines' });
      }
      parentId = id;
    }

    // Call expressions: record calls to known symbols and external names.
    if (node.kind === ts.SyntaxKind.CallExpression) {
      const call = node as ts.CallExpression;
      let target: string | null = null;
      if (call.expression.kind === ts.SyntaxKind.Identifier) {
        target = (call.expression as ts.Identifier).text;
      } else if (call.expression.kind === ts.SyntaxKind.PropertyAccessExpression) {
        const prop = call.expression as ts.PropertyAccessExpression;
        target = prop.name.text;
      }
      if (target && parentId) {
        edges.push({ from: parentId, to: target, kind: 'calls' });
      }
    }

    // Import from: record module reference.
    if (node.kind === ts.SyntaxKind.ImportDeclaration && parentId) {
      const imp = node as ts.ImportDeclaration;
      let moduleSpec = '';
      if (ts.isStringLiteral(imp.moduleSpecifier)) {
        moduleSpec = imp.moduleSpecifier.text;
      }
      edges.push({ from: parentId, to: `module:${moduleSpec}`, kind: 'imports' });
    }

    ts.forEachChild(node, (child) => walk(child, parentId));
  }

  walk(sourceFile);

  const byName = new Map<string, SymbolNode[]>();
  const byId = new Map<string, SymbolNode>();
  for (const s of symbols) {
    byId.set(s.id, s);
    const list = byName.get(s.name) ?? [];
    list.push(s);
    byName.set(s.name, list);
  }

  return { file: filePath, symbols, edges, byName, byId };
}

/** Find a symbol by name across the graph. */
export function findSymbol(graph: KnowledgeGraph, name: string): SymbolNode[] {
  return graph.byName.get(name) ?? [];
}

/** Find the definition location of a symbol. */
export function findDefinition(graph: KnowledgeGraph, name: string): SymbolNode | undefined {
  const matches = graph.byName.get(name);
  if (!matches) return undefined;
  // Prefer a local definition (kind other than import) over an import.
  const local = matches.find((m) => m.kind !== 'import');
  return local ?? matches[0];
}

/** All edges touching a symbol id. */
export function edgesFor(graph: KnowledgeGraph, symbolId: string): GraphEdge[] {
  return graph.edges.filter((e) => e.from === symbolId || e.to === symbolId);
}

/** Diagnose a potential defect location: given a symbol name, return its definition
 *  and all callers, so a diagnosis can point at the real code. */
export function diagnoseLocation(graph: KnowledgeGraph, name: string): {
  definition: SymbolNode | undefined;
  callers: GraphEdge[];
  references: GraphEdge[];
} {
  const definition = findDefinition(graph, name);
  const all = edgesFor(graph, definition?.id ?? '');
  const callers = all.filter((e) => e.kind === 'calls' && e.to === name);
  const references = all.filter((e) => e.kind === 'references' || e.kind === 'imports');
  return { definition, callers, references };
}
