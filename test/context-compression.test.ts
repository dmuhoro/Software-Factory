/**
 * Context compression tests (Layer 7 Interface, headroom steal).
 *
 * Proves:
 *  - CC-1  a log is reduced and every evidence marker survives byte for byte
 *  - CC-2  the reduction is measured, not asserted
 *  - CC-3  the collector accumulates what a run saved
 *  - CC-4  source code is never compressed: the model still sees the file exactly
 *  - CC-5  the same input always yields the same reduction (deterministic)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  collectorTotals,
  compressDiff,
  compressLog,
  createCollector,
} from '../src/services/contextCompressionService';
import { buildPrompts } from '../src/services/implementerService';

const LOG = [
  'verify: npm run lint',
  '',
  'src/services/loopGates.ts:127: gate refused',
  'exit 1',
  '',
  'ERROR: verification failed',
  '   ',
  'GATE_REFUSED:verify:ground-truth',
  '',
].join('\n');

test('CC-1: a log is reduced and every evidence marker survives byte for byte', () => {
  const result = compressLog(LOG);
  assert.ok(result.compressedBytes < result.originalBytes, 'the log was not reduced');
  assert.ok(result.ratio > 0);
  for (const marker of [
    'src/services/loopGates.ts:127',
    'exit 1',
    'ERROR',
    'GATE_REFUSED:verify:ground-truth',
  ]) {
    assert.ok(result.text.includes(marker), `the evidence marker was lost: ${marker}`);
  }
  assert.ok(result.evidencePreserved >= 4, 'the protected markers were not counted');
});

test('CC-2: the reduction is measured, not asserted', () => {
  const result = compressLog(LOG);
  assert.equal(result.originalBytes, Buffer.byteLength(LOG, 'utf8'));
  assert.equal(result.compressedBytes, Buffer.byteLength(result.text, 'utf8'));
  assert.ok(Math.abs(result.ratio - (1 - result.compressedBytes / result.originalBytes)) < 1e-9);
});

test('CC-3: the collector accumulates what a run saved', () => {
  const collector = createCollector();
  compressLog(LOG, collector);
  compressDiff('diff --git a/x b/x\n\n+added\n\n', collector);
  const totals = collectorTotals(collector);
  assert.equal(totals.segments, 2);
  assert.ok(totals.originalBytes > totals.compressedBytes);
  assert.ok(totals.ratio > 0);
  assert.ok(totals.evidencePreserved > 0);
});

test('CC-4: source code is never compressed: the model still sees the file exactly', () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-cc-'));
  const repo = path.join(state, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const source = 'export function keep(): string {\n\n  return "exactly this";\n\n}\n';
  fs.writeFileSync(path.join(repo, 'keep.ts'), source);

  const unit = {
    id: 'U-1',
    title: 'Keep',
    milestoneId: 'M-1',
    type: 'feature',
    status: 'pending',
    criteria: [{ id: 'C-1', text: 'keep.ts is unchanged', check: 'cat keep.ts' }],
    verify: 'cat keep.ts',
    dependsOn: [],
  } as never;
  const request = {
    tenantId: 'tenant',
    repo,
    unit,
    document: { id: 'T-1', title: 'Task', goal: 'Goal', constraints: [], milestones: [], models: {}, sourceHash: 'hash' },
    assignment: { providerId: 'p', model: 'm' },
    doctrineLines: [],
    isolation: {} as never,
    timeoutMs: 1000,
  } as never;

  const collector = createCollector();
  const prompt = buildPrompts(request, { enabled: false, block: '' }, undefined, collector);
  assert.ok(prompt.task.includes(source), 'the file content was altered on the way to the model');
  assert.equal(collector.segments, 0, 'source content is not a compression target');
});

test('CC-5: the same input always yields the same reduction (deterministic)', () => {
  const first = compressLog(LOG);
  for (let i = 0; i < 25; i += 1) {
    const repeated = compressLog(LOG);
    assert.equal(repeated.text, first.text);
    assert.equal(repeated.originalBytes, first.originalBytes);
    assert.equal(repeated.compressedBytes, first.compressedBytes);
    assert.equal(repeated.evidencePreserved, first.evidencePreserved);
  }
});
