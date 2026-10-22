/**
 * AST knowledge graph (Layer 2/5/7 shared utility).
 *
 * Deterministic AST parsing of TypeScript/JavaScript source into a
 * queryable knowledge graph: nodes are symbols (functions, classes,
 * variables, imports, exports, parameters), edges are calls, imports and
 * definitions. No vector store, no ML, no clock, no I/O beyond parsing the
 * text handed to it. The same source always yields the same graph.
 *
 * This is the Graphify steal, adapted to SF constraints: TypeScript
 * compiler API (already a dependency), local-first, deterministic,
 * bounded to one file at a time. Editors and layers query the graph;
 * nothing here writes to a target tree.
 *
 * Two properties matter more than breadth, because a structural check that
 * cries wolf is worse than no structural check:
 *
 *  - A call edge distinguishes a *direct* call (`loadConfig()`) from a
 *    *method* call (`fs.readFileSync()`). Only a direct call to a name that
 *    is nowhere defined is a defect; a method call names a property, and a
 *    property is not a symbol in the file.
 *  - An import is recorded once per binding, with the module specifier it
 *    came from, so a caller can ask "does that module actually export this
 *    name?" instead of guessing.
 */

import * as ts from 'typescript';

export type SymbolKind =
  | 'function'
  | 'class'
  | 'variable'
  | 'import'
  | 'export'
  | 'interface'
  | 'type'
  | 'parameter';

export interface SymbolNode {
  id: string;           // stable: filePath#symbolName#kind
  file: string;
  name: string;
  kind: SymbolKind;
  line: number;
  column?: number;
  signature?: string;   // truncated declaration text, for evidence
  /** Module specifier for imports (e.g. './other', 'react', 'node:fs'). Undefined for non-imports. */
  moduleSpec?: string;
  /** How the binding was imported: default, namespace, or named. */
  importForm?: 'default' | 'namespace' | 'named';
  /** How many times the binding is used in the file outside its own declaration. */
  usages?: number;
}

export interface GraphEdge {
  from: string;   // symbol id
  to: string;     // symbol id or external reference string
  kind: 'calls' | 'calls-method' | 'imports' | 'defines' | 'references' | 'exports';
  /** Line of the construct that produced the edge. */
  line?: number;
}

export interface KnowledgeGraph {
  file: string;
  symbols: SymbolNode[];
  edges: GraphEdge[];
  /** Symbols indexed by name for fast lookup. */
  byName: Map<string, SymbolNode[]>;
  /** Symbols indexed by id. */
  byId: Map<string, SymbolNode>;
  /** Names this file exports (a star re-export records `'*'`). */
  exports: string[];
  /** Module specifiers this file imports from, in source order. */
  imports: string[];
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** Parse one source file into a knowledge graph. Pure and deterministic. */
export function buildKnowledgeGraph(filePath: string, sourceText: string): KnowledgeGraph {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const symbols: SymbolNode[] = [];
  const edges: GraphEdge[] = [];
  const exportedNames = new Set<string>();
  const importedModules: string[] = [];
  let counter = 0;

  const nextId = (): string => {
    counter += 1;
    return `sym-${counter}`;
  };

  const lineOf = (node: ts.Node): number => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const addSymbol = (node: ts.Node, name: string, kind: SymbolKind, extra: Partial<SymbolNode> = {}): SymbolNode => {
    const pos = node.getStart(sourceFile);
    const lineAndCol = sourceFile.getLineAndCharacterOfPosition(pos);
    const declText = sourceText.slice(pos, node.getEnd()).replace(/\s+/g, ' ').slice(0, 200);
    const symbol: SymbolNode = {
      id: nextId(),
      file: filePath,
      name,
      kind,
      line: lineAndCol.line + 1,
      column: lineAndCol.character + 1,
      signature: declText,
      ...extra,
    };
    symbols.push(symbol);
    return symbol;
  };

  const hasExportModifier = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

  const addEdge = (from: string, to: string, kind: GraphEdge['kind'], line: number): void => {
    edges.push({ from, to, kind, line });
  };

  /** Record one import binding as its own symbol, with the module specifier. */
  const recordImport = (declaration: ts.ImportDeclaration): void => {
    const clause = declaration.importClause;
    if (!clause) return;
    const specifier = declaration.moduleSpecifier;
    const moduleSpec = ts.isStringLiteral(specifier) ? specifier.text : '';
    importedModules.push(moduleSpec);

    if (clause.name) {
      addSymbol(declaration, clause.name.text, 'import', { moduleSpec, importForm: 'default' });
    }
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      addSymbol(declaration, bindings.name.text, 'import', { moduleSpec, importForm: 'namespace' });
    } else if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        addSymbol(declaration, element.name.text, 'import', { moduleSpec, importForm: 'named' });
      }
    }
  };

  const recordExports = (node: ts.Node): void => {
    if (ts.isExportDeclaration(node)) {
      const clause = node.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) exportedNames.add(element.name.text);
      } else if (clause && ts.isNamespaceExport(clause)) {
        exportedNames.add('*');
      } else {
        // `export * from './x'` — the names are not knowable from this file.
        exportedNames.add('*');
      }
      return;
    }
    if (ts.isExportAssignment(node)) {
      exportedNames.add('default');
      return;
    }
    if (hasExportModifier(node)) {
      if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) exportedNames.add(declaration.name.text);
        }
        return;
      }
      const name = (node as ts.NamedDeclaration).name;
      if (name && ts.isIdentifier(name)) exportedNames.add(name.text);
      else exportedNames.add('default');
    }
  };

  const walk = (node: ts.Node, parentId: string | null): void => {
    const line = lineOf(node);
    let scopeId = parentId;

    if (ts.isImportDeclaration(node)) {
      recordImport(node);
    } else if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
      if (node.name && ts.isIdentifier(node.name)) {
        const symbol = addSymbol(node, node.name.text, 'function');
        if (parentId) addEdge(parentId, symbol.id, 'defines', line);
        scopeId = symbol.id;
        if (hasExportModifier(node)) exportedNames.add(node.name.text);
      }
    } else if (ts.isClassDeclaration(node)) {
      if (node.name && ts.isIdentifier(node.name)) {
        const symbol = addSymbol(node, node.name.text, 'class');
        if (parentId) addEdge(parentId, symbol.id, 'defines', line);
        scopeId = symbol.id;
        if (hasExportModifier(node)) exportedNames.add(node.name.text);
      }
    } else if (ts.isInterfaceDeclaration(node)) {
      const symbol = addSymbol(node, node.name.text, 'interface');
      if (parentId) addEdge(parentId, symbol.id, 'defines', line);
      scopeId = symbol.id;
      if (hasExportModifier(node)) exportedNames.add(node.name.text);
    } else if (ts.isTypeAliasDeclaration(node)) {
      const symbol = addSymbol(node, node.name.text, 'type');
      if (parentId) addEdge(parentId, symbol.id, 'defines', line);
      scopeId = symbol.id;
      if (hasExportModifier(node)) exportedNames.add(node.name.text);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const symbol = addSymbol(node, node.name.text, 'variable');
      if (parentId) addEdge(parentId, symbol.id, 'defines', line);
      scopeId = symbol.id;
      if (hasExportModifier(node.parent.parent)) exportedNames.add(node.name.text);
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      const symbol = addSymbol(node, node.name.text, 'parameter');
      if (parentId) addEdge(parentId, symbol.id, 'defines', line);
      scopeId = symbol.id;
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const expression = node.expression;
      if (ts.isIdentifier(expression)) {
        if (scopeId) addEdge(scopeId, expression.text, 'calls', line);
      } else if (ts.isPropertyAccessExpression(expression)) {
        // A method call names a property of a receiver, not a symbol in this file.
        if (scopeId) addEdge(scopeId, expression.name.text, 'calls-method', line);
      }
    }

    if (ts.isExportDeclaration(node) || ts.isExportAssignment(node) || hasExportModifier(node)) {
      recordExports(node);
    }

    ts.forEachChild(node, (child) => walk(child, scopeId));
  };

  walk(sourceFile, null);

  // Second pass: count how often each identifier is used outside its own declaration.
  // This is what separates "imported and used" from "imported and forgotten".
  const usages = new Map<string, number>();
  const countUsages = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const isDeclarationName =
        (ts.isVariableDeclaration(parent) && parent.name === node) ||
        (ts.isParameter(parent) && parent.name === node) ||
        (ts.isFunctionDeclaration(parent) && parent.name === node) ||
        (ts.isMethodDeclaration(parent) && parent.name === node) ||
        (ts.isClassDeclaration(parent) && parent.name === node) ||
        (ts.isInterfaceDeclaration(parent) && parent.name === node) ||
        (ts.isTypeAliasDeclaration(parent) && parent.name === node) ||
        (ts.isPropertyDeclaration(parent) && parent.name === node) ||
        (ts.isPropertySignature(parent) && parent.name === node) ||
        (ts.isMethodSignature(parent) && parent.name === node) ||
        (ts.isEnumMember(parent) && parent.name === node) ||
        (ts.isImportSpecifier(parent) && parent.name === node) ||
        (ts.isImportClause(parent) && parent.name === node) ||
        (ts.isNamespaceImport(parent) && parent.name === node) ||
        (ts.isExportSpecifier(parent) && parent.name === node);
      const isPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isQualifiedName(parent) && parent.right === node);
      if (!isDeclarationName && !isPropertyName) {
        usages.set(node.text, (usages.get(node.text) ?? 0) + 1);
      }
    }
    ts.forEachChild(node, countUsages);
  };
  countUsages(sourceFile);

  for (const symbol of symbols) {
    if (symbol.kind === 'import') symbol.usages = usages.get(symbol.name) ?? 0;
  }

  // Import edges: an import symbol imports the module it names.
  for (const symbol of symbols) {
    if (symbol.kind !== 'import' || !symbol.moduleSpec) continue;
    addEdge(symbol.id, `module:${symbol.moduleSpec}`, 'imports', symbol.line);
  }

  const byName = new Map<string, SymbolNode[]>();
  const byId = new Map<string, SymbolNode>();
  for (const symbol of symbols) {
    byId.set(symbol.id, symbol);
    const list = byName.get(symbol.name) ?? [];
    list.push(symbol);
    byName.set(symbol.name, list);
  }

  return {
    file: filePath,
    symbols,
    edges,
    byName,
    byId,
    exports: [...exportedNames].sort(),
    imports: importedModules,
  };
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

/** The source extensions the knowledge graph understands. */
export const GRAPH_SOURCE_EXTENSIONS = SOURCE_EXTENSIONS;
