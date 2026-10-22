/**
 * Repository knowledge index (Layer 2/5/7).
 *
 * The per-file graph in `astKnowledgeGraph.ts` answers "what is in this file".
 * This module answers the two questions the per-file graph cannot:
 *
 *  - "Does the module this file imports from actually exist, and does it export
 *    that name?" — resolved by walking the import closure, so a symbol defined
 *    in an unchanged file is not reported as undefined.
 *  - "Where in this repository is that symbol defined?" — a repo-scoped query
 *    for the L7 interface (editors and CLI clients ask the same question).
 *
 * Read-only by construction: it reads files and parses them. It never writes
 * to a target tree. Deterministic: the same tree yields the same index, with
 * files visited in sorted order. Bounded: every scan has a file ceiling and a
 * depth ceiling, and a truncated scan says it was truncated rather than
 * pretending it saw everything.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  buildKnowledgeGraph,
  GRAPH_SOURCE_EXTENSIONS,
  type KnowledgeGraph,
  type SymbolNode,
} from './astKnowledgeGraph';

/** Directories never worth indexing: dependencies, build output, and our own ledgers. */
export const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'target',
  '.data',
  '.factory-worktrees',
  '.next',
  '.cache',
]);

export interface RepositoryScanOptions {
  /** Maximum number of files to index. Defaults to 1500. */
  maxFiles?: number;
  /** Maximum depth below the repository root. Defaults to 12. */
  maxDepth?: number;
  /** File extensions to index. Defaults to the graph's source extensions. */
  extensions?: string[];
  /** Explicit relative files to index instead of a repository scan. */
  files?: string[];
}

export interface RepositoryScan {
  /** Repository root, resolved. */
  repo: string;
  /** Relative paths, sorted. */
  files: string[];
  /** True when the scan stopped at its ceiling and did not see every source file. */
  truncated: boolean;
  /** Files that could not be read. */
  unreadable: string[];
}

export interface KnowledgeClosure {
  repo: string;
  /** Parsed graphs, keyed by repository-relative path. */
  graphs: Map<string, KnowledgeGraph>;
  /** Every name defined anywhere in the closure. */
  definedNames: Set<string>;
  /** Names exported by each file in the closure. */
  exportsByFile: Map<string, Set<string>>;
  /** Import bindings per file: name -> module specifier. */
  importsByFile: Map<string, Map<string, string>>;
  /** Relative module specifiers that could not be resolved to a file in the repository. */
  unresolvedModules: string[];
  /** True when the closure stopped at its file ceiling. */
  truncated: boolean;
}

export interface SymbolSearchResult {
  /** Symbol definitions found, sorted by file then line. */
  matches: SymbolNode[];
  /** Files scanned. */
  filesScanned: number;
  /** True when the scan stopped at its ceiling. */
  truncated: boolean;
}

const DEFAULT_MAX_FILES = 1500;
const DEFAULT_MAX_DEPTH = 12;

/** Resolve a repository-relative path, refusing anything that escapes the repository. */
function safeJoin(repo: string, relative: string): string | undefined {
  const resolved = path.resolve(repo, relative);
  const rel = path.relative(repo, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return resolved;
}

/**
 * Scan a repository for source files. Sorted, bounded, and honest about
 * truncation: a scan that stopped early reports it.
 */
export function scanRepositorySources(repo: string, options: RepositoryScanOptions = {}): RepositoryScan {
  const root = path.resolve(repo);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const extensions = options.extensions ?? GRAPH_SOURCE_EXTENSIONS;
  const unreadable: string[] = [];

  if (options.files) {
    const files = options.files
      .map((file) => path.normalize(file))
      .filter((file) => extensions.some((extension) => file.endsWith(extension)))
      .sort();
    for (const file of files) {
      const absolute = safeJoin(root, file);
      if (!absolute || !fs.existsSync(absolute)) unreadable.push(file);
    }
    return { repo: root, files, truncated: false, unreadable };
  }

  const found: string[] = [];
  let truncated = false;

  const walk = (dir: string, depth: number): void => {
    if (truncated) return;
    if (depth > maxDepth) {
      truncated = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      unreadable.push(path.relative(root, dir));
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (truncated) return;
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        walk(path.join(dir, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!extensions.some((extension) => entry.name.endsWith(extension))) continue;
      found.push(path.relative(root, path.join(dir, entry.name)));
      if (found.length >= maxFiles) {
        truncated = true;
        return;
      }
    }
  };

  walk(root, 0);
  return { repo: root, files: found.sort(), truncated, unreadable };
}

/**
 * Resolve a relative module specifier to a repository file.
 *
 * Returns the repository-relative path when it can be proved, and undefined
 * when it cannot — a caller must not treat "not found" as "does not exist"
 * when the file may simply be outside the index.
 */
export function resolveRelativeModule(repo: string, fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return undefined;
  const fromDir = path.dirname(path.resolve(repo, fromFile));
  const target = path.resolve(fromDir, specifier);
  const rel = path.relative(path.resolve(repo), target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;

  const candidates = [
    rel,
    ...GRAPH_SOURCE_EXTENSIONS.map((extension) => `${rel}${extension}`),
    ...GRAPH_SOURCE_EXTENSIONS.map((extension) => path.join(rel, `index${extension}`)),
  ];
  for (const candidate of candidates) {
    const absolute = safeJoin(repo, candidate);
    if (!absolute) continue;
    try {
      if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) return path.normalize(candidate);
    } catch {
      // An unreadable candidate is not a resolution.
    }
  }
  return undefined;
}

/**
 * Parse the import closure of a set of files: the files themselves, plus every
 * relative module they import, transitively.
 *
 * This is what makes "the symbol is not defined" an honest statement. A check
 * that only looked at the changed files would call every import of an
 * unchanged module undefined, and a gate that cries wolf is a gate operators
 * learn to bypass.
 */
export function buildImportClosure(repo: string, seedFiles: string[], options: RepositoryScanOptions = {}): KnowledgeClosure {
  const root = path.resolve(repo);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

  const graphs = new Map<string, KnowledgeGraph>();
  const definedNames = new Set<string>();
  const exportsByFile = new Map<string, Set<string>>();
  const importsByFile = new Map<string, Map<string, string>>();
  const unresolvedModules: string[] = [];
  const seen = new Set<string>();
  const queue: Array<{ file: string; depth: number }> = [];

  for (const file of seedFiles) {
    const normalized = path.normalize(file);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      queue.push({ file: normalized, depth: 0 });
    }
  }

  let truncated = false;

  while (queue.length > 0) {
    const next = queue.shift()!;
    const absolute = safeJoin(root, next.file);
    if (!absolute) continue;
    let sourceText: string;
    try {
      sourceText = fs.readFileSync(absolute, 'utf8');
    } catch {
      continue;
    }
    const graph = buildKnowledgeGraph(next.file, sourceText);
    graphs.set(next.file, graph);

    for (const symbol of graph.symbols) {
      if (symbol.kind !== 'import') definedNames.add(symbol.name);
    }
    exportsByFile.set(next.file, new Set(graph.exports));

    const bindings = new Map<string, string>();
    for (const symbol of graph.symbols) {
      if (symbol.kind !== 'import' || !symbol.moduleSpec) continue;
      bindings.set(symbol.name, symbol.moduleSpec);
      const resolved = resolveRelativeModule(root, next.file, symbol.moduleSpec);
      if (!resolved) {
        if (symbol.moduleSpec.startsWith('./') || symbol.moduleSpec.startsWith('../')) {
          unresolvedModules.push(`${next.file} -> ${symbol.moduleSpec}`);
        }
        continue;
      }
      if (seen.has(resolved)) continue;
      if (next.depth + 1 > maxDepth) {
        truncated = true;
        continue;
      }
      seen.add(resolved);
      queue.push({ file: resolved, depth: next.depth + 1 });
      if (graphs.size >= maxFiles) {
        truncated = true;
        break;
      }
    }
    importsByFile.set(next.file, bindings);

    if (graphs.size >= maxFiles) {
      truncated = true;
      break;
    }
  }

  return {
    repo: root,
    graphs,
    definedNames,
    exportsByFile,
    importsByFile,
    unresolvedModules: [...new Set(unresolvedModules)].sort(),
    truncated,
  };
}

/**
 * Repo-scoped symbol search (the L7 query): where is this symbol defined?
 *
 * Bounded and honest: when the scan hits its ceiling the result says so, so a
 * caller can tell "not defined anywhere" from "not seen yet".
 */
export function searchRepositorySymbols(repo: string, name: string, options: RepositoryScanOptions = {}): SymbolSearchResult {
  const scan = scanRepositorySources(repo, options);
  const matches: SymbolNode[] = [];

  for (const file of scan.files) {
    const absolute = safeJoin(scan.repo, file);
    if (!absolute) continue;
    let sourceText: string;
    try {
      sourceText = fs.readFileSync(absolute, 'utf8');
    } catch {
      continue;
    }
    const graph = buildKnowledgeGraph(file, sourceText);
    for (const symbol of graph.symbols) {
      if (symbol.name !== name) continue;
      if (symbol.kind === 'import') continue;
      matches.push(symbol);
    }
  }

  matches.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { matches, filesScanned: scan.files.length, truncated: scan.truncated };
}
