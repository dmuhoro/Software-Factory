/**
 * Tool-agnostic IDE/CLI boundary (Layer 7 Interface).
 *
 * Exposes the AST knowledge graph, dual-language reporting, and output
 * compression through a single boundary that any editor (Cursor, Cline,
 * built-in panel) or CLI can consume. Editors are clients of this boundary,
 * not authors of it — the same run record is consumable by any tool.
 *
 * Read-only: never writes to a target tree. All queries are deterministic
 * and side-effect free.
 */

import {
  buildKnowledgeGraph,
  findSymbol,
  findDefinition,
  edgesFor,
  diagnoseLocation,
  type KnowledgeGraph,
  type SymbolNode,
} from './astKnowledgeGraph';
import {
  renderDualLanguage,
  renderUnitDualLanguage,
  type DualLanguageRecord,
} from '../utils/dualLanguageReport';
import {
  compressForLLM,
  compressForFrontend,
  type CompressionResult,
} from '../utils/outputCompression';
import { searchRepositorySymbols, type SymbolSearchResult } from './repoKnowledgeIndex';

export interface BoundaryQuery {
  /** File path to analyze. */
  file: string;
  /** Source text of the file. */
  sourceText: string;
  /** Symbol name to look up (optional). */
  symbol?: string;
  /** Compression level for payload (optional). */
  compression?: 'light' | 'medium' | 'aggressive';
}

/** A repository-scoped query: where is this symbol defined? */
export interface RepositoryQuery {
  /** Repository root to search. */
  repo: string;
  /** Symbol name to look for. */
  symbol: string;
  /** Maximum number of files to scan. */
  maxFiles?: number;
}

export interface SymbolLookup {
  symbol: SymbolNode | undefined;
  callers: Array<{ from: string; to: string; kind: string }>;
  references: Array<{ from: string; to: string; kind: string }>;
}

export interface BoundaryResponse {
  /** Knowledge graph for the file. */
  graph: {
    symbolCount: number;
    edgeCount: number;
    symbols: SymbolNode[];
  };
  /** Symbol lookup results (if symbol was requested). */
  lookup?: SymbolLookup;
  /** Dual-language rendering of the run record (if provided). */
  dualLanguage?: { technical: string; founder: string };
  /** Compressed payload for LLM consumption. */
  llmPayload?: CompressionResult;
  /** Compressed payload for frontend consumption. */
  frontendPayload?: CompressionResult;
}

/** Query the tool-agnostic boundary for a file. */
export function queryBoundary(input: BoundaryQuery): BoundaryResponse {
  const graph = buildKnowledgeGraph(input.file, input.sourceText);

  const response: BoundaryResponse = {
    graph: {
      symbolCount: graph.symbols.length,
      edgeCount: graph.edges.length,
      symbols: graph.symbols,
    },
  };

  if (input.symbol) {
    const definition = findDefinition(graph, input.symbol);
    const all = definition ? edgesFor(graph, definition.id) : [];
    response.lookup = {
      symbol: definition,
      callers: all.filter((e) => e.kind === 'calls' && e.to === input.symbol),
      references: all.filter((e) => e.kind !== 'calls'),
    };
  }

  return response;
}

/**
 * Query the repository for a symbol (the L7 repo query).
 *
 * The answer carries its own honesty: `filesScanned` says how much was seen,
 * and `truncated` says whether the scan stopped at its ceiling. A caller can
 * therefore tell "defined nowhere" from "not seen yet".
 */
export function queryRepository(input: RepositoryQuery): SymbolSearchResult {
  return searchRepositorySymbols(input.repo, input.symbol, input.maxFiles ? { maxFiles: input.maxFiles } : {});
}

/** Render a run record in dual language through the boundary. */
export function renderRunRecord(record: DualLanguageRecord): { technical: string; founder: string } {
  return renderDualLanguage(record);
}

/** Render a single unit result in dual language through the boundary. */
export function renderUnit(unit: {
  unitId: string;
  title: string;
  status: 'pending' | 'running' | 'done' | 'stuck' | 'blocked';
  attempts: number;
  commitSha?: string;
  failureClass?: string;
  detail?: string;
  reproducesWith: string;
}): { technical: string; founder: string } {
  return renderUnitDualLanguage(unit);
}

/** Compress text for LLM consumption through the boundary. */
export function compressForLLMBoundary(text: string): CompressionResult {
  return compressForLLM(text);
}

/** Compress text for frontend consumption through the boundary. */
export function compressForFrontendBoundary(text: string): CompressionResult {
  return compressForFrontend(text);
}

export interface ToolAgnosticBoundaryService {
  queryBoundary(input: BoundaryQuery): BoundaryResponse;
  queryRepository(input: RepositoryQuery): SymbolSearchResult;
  renderRunRecord(record: DualLanguageRecord): { technical: string; founder: string };
  renderUnit(unit: {
    unitId: string;
    title: string;
    status: 'pending' | 'running' | 'done' | 'stuck' | 'blocked';
    attempts: number;
    commitSha?: string;
    failureClass?: string;
    detail?: string;
    reproducesWith: string;
  }): { technical: string; founder: string };
  compressForLLM(text: string): CompressionResult;
  compressForFrontend(text: string): CompressionResult;
}

export class ToolAgnosticBoundaryServiceImpl implements ToolAgnosticBoundaryService {
  queryBoundary(input: BoundaryQuery): BoundaryResponse {
    return queryBoundary(input);
  }
  queryRepository(input: RepositoryQuery): SymbolSearchResult {
    return queryRepository(input);
  }
  renderRunRecord(record: DualLanguageRecord): { technical: string; founder: string } {
    return renderRunRecord(record);
  }
  renderUnit(unit: {
    unitId: string;
    title: string;
    status: 'pending' | 'running' | 'done' | 'stuck' | 'blocked';
    attempts: number;
    commitSha?: string;
    failureClass?: string;
    detail?: string;
    reproducesWith: string;
  }): { technical: string; founder: string } {
    return renderUnit(unit);
  }
  compressForLLM(text: string): CompressionResult {
    return compressForLLMBoundary(text);
  }
  compressForFrontend(text: string): CompressionResult {
    return compressForFrontendBoundary(text);
  }
}

export const toolAgnosticBoundary = new ToolAgnosticBoundaryServiceImpl();
