/**
 * Tool-agnostic boundary tests (Layer 7 Interface).
 *
 * Proves:
 *  - TAB-1  boundary query returns knowledge graph with symbol and edge counts
 *  - TAB-2  symbol lookup returns definition, callers, and references
 *  - TAB-3  dual-language rendering works through the boundary
 *  - TAB-4  unit rendering works through the boundary
 *  - TAB-5  LLM compression works through the boundary
 *  - TAB-6  frontend compression works through the boundary
 *  - TAB-7  same input always yields same boundary response (deterministic)
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  queryBoundary,
  renderRunRecord,
  renderUnit,
  compressForLLMBoundary,
  compressForFrontendBoundary,
  type BoundaryQuery,
} from '../src/services/toolAgnosticBoundary';
import type { DualLanguageRecord } from '../src/utils/dualLanguageReport';

const SOURCE = `import { readFileSync } from 'node:fs';
export const CONFIG_PATH = join(__dirname, 'config.json');
export function loadConfig(): unknown {
  return readFileSync(CONFIG_PATH, 'utf8');
}`;

const QUERY: BoundaryQuery = {
  file: '/repo/src/config.ts',
  sourceText: SOURCE,
  symbol: 'loadConfig',
  compression: 'medium',
};

test('TAB-1: boundary query returns knowledge graph with symbol and edge counts', () => {
  const response = queryBoundary(QUERY);
  assert.ok(response.graph.symbolCount > 0, 'graph has symbols');
  assert.ok(response.graph.edgeCount > 0, 'graph has edges');
  assert.ok(Array.isArray(response.graph.symbols), 'symbols is an array');
});

test('TAB-2: symbol lookup returns definition, callers, and references', () => {
  const response = queryBoundary(QUERY);
  assert.ok(response.lookup, 'lookup is present when symbol requested');
  assert.ok(response.lookup!.symbol, 'definition found');
  assert.equal(response.lookup!.symbol!.name, 'loadConfig');
  assert.ok(Array.isArray(response.lookup!.callers), 'callers is an array');
  assert.ok(Array.isArray(response.lookup!.references), 'references is an array');
});

test('TAB-2b: unknown symbol returns no definition', () => {
  const response = queryBoundary({ ...QUERY, symbol: 'doesNotExist' });
  assert.ok(response.lookup, 'lookup is present');
  assert.equal(response.lookup!.symbol, undefined, 'no definition for unknown symbol');
});

test('TAB-3: dual-language rendering works through the boundary', () => {
  const record: DualLanguageRecord = {
    runId: 'run-1',
    repo: '/repo',
    taskDocument: '/repo/task.md',
    status: 'completed',
    units: [
      { unitId: 'u1', title: 'Feature alpha', status: 'done', attempts: 1, commitSha: 'abc123' },
    ],
    gates: [{ id: 'ground-truth', stage: 'verify', passed: true, blocking: true, detail: 'check passed' }],
    failureClass: undefined,
    narrationRejected: 0,
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T00:05:00Z',
    reproducesWith: 'npm test',
  };
  const { technical, founder } = renderRunRecord(record);
  assert.ok(technical.length > 0, 'technical rendering non-empty');
  assert.ok(founder.length > 0, 'founder rendering non-empty');
  assert.ok(technical.includes('run-1'), 'technical includes runId');
  assert.ok(founder.includes('Feature alpha'), 'founder includes unit title');
});

test('TAB-4: unit rendering works through the boundary', () => {
  const { technical, founder } = renderUnit({
    unitId: 'u1',
    title: 'Feature alpha',
    status: 'done',
    attempts: 1,
    commitSha: 'abc123def456',
    reproducesWith: 'npm test',
  });
  assert.ok(technical.includes('u1'), 'technical includes unitId');
  assert.ok(technical.includes('abc123def456'), 'technical includes commitSha');
  assert.ok(founder.includes('Feature alpha'), 'founder includes title');
});

test('TAB-5: LLM compression works through the boundary', () => {
  const result = compressForLLMBoundary('some verbose text that should be compressed');
  assert.ok(result.compressed.length > 0, 'compressed output non-empty');
  assert.equal(result.level, 'aggressive', 'LLM compression uses aggressive level');
  assert.ok(result.originalBytes > 0);
  assert.ok(result.compressedBytes > 0);
});

test('TAB-6: frontend compression works through the boundary', () => {
  const result = compressForFrontendBoundary('some verbose text that should be compressed');
  assert.ok(result.compressed.length > 0, 'compressed output non-empty');
  assert.equal(result.level, 'medium', 'frontend compression uses medium level');
});

test('TAB-7: same input always yields same boundary response (deterministic)', () => {
  const first = queryBoundary(QUERY);
  for (let i = 0; i < 10; i += 1) {
    const repeated = queryBoundary(QUERY);
    assert.equal(repeated.graph.symbolCount, first.graph.symbolCount);
    assert.equal(repeated.graph.edgeCount, first.graph.edgeCount);
    assert.equal(repeated.graph.symbols.length, first.graph.symbols.length);
  }
});
