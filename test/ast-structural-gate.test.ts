/**
 * The AST structural verification gate, driven through the registry (Layer 2 Agency).
 *
 * The gate runs inside the unattended loop (`doctrine/hooks/hooks.json`, `verify.after`), so it
 * is exercised here the way the loop exercises it: through `runGate`, with a real repository on
 * disk and a real proof. A unit test of the adapter alone would not prove that the gate the loop
 * runs is the adapter.
 *
 * Proves:
 *  - ASG-1  a legitimate changed file passes the gate (no false refusal)
 *  - ASG-2  a changed file that calls a name defined nowhere is refused, with file:line
 *  - ASG-3  a changed file importing an unchanged module passes (no false refusal)
 *  - ASG-4  a changed file with no TypeScript/JavaScript files is not applicable
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runGate } from '../src/services/loopGates';
import type { GroundTruthProof } from '../src/services/groundTruthService';
import type { GateContext } from '../src/services/loopGates';

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-ast-gate-'));
const repo = path.join(state, 'repo');
fs.mkdirSync(repo, { recursive: true });

function proofFor(files: string[]): GroundTruthProof {
  return {
    passed: true,
    repo,
    head: 'HEAD',
    checks: [],
    claimedFiles: files,
    observedFiles: files,
    rejectedNarration: [],
    recordedAt: new Date().toISOString(),
  };
}

function context(files: string[]): GateContext {
  return {
    stage: 'verify',
    timing: 'after',
    repo,
    isolation: {} as GateContext['isolation'],
    run: {} as GateContext['run'],
    proof: proofFor(files),
  };
}

test('ASG-1: a legitimate changed file passes the gate', () => {
  fs.writeFileSync(path.join(repo, 'service.ts'), [
    "import fs from 'node:fs';",
    '',
    'export function readConfig(dir: string): string {',
    "  const raw = fs.readFileSync(`${dir}/config.json`, 'utf8');",
    '  return raw.trim();',
    '}',
  ].join('\n'));

  const result = runGate('ast-structural-verification', context(['service.ts']));
  assert.ok(result.passed, `the gate refused a legitimate file: ${result.detail}`);
  assert.equal(result.blocking, true, 'the gate is blocking by doctrine default');
  assert.match(result.detail, /no blocking issues/);
});

test('ASG-2: a changed file that calls a name defined nowhere is refused, with file:line', () => {
  fs.writeFileSync(path.join(repo, 'broken.ts'), [
    'export function go(): void {',
    '  missingHelper();',
    '}',
  ].join('\n'));

  const result = runGate('ast-structural-verification', context(['broken.ts']));
  assert.equal(result.passed, false, 'the gate refuses a provable structural defect');
  assert.match(result.detail, /broken\.ts:2/);
  assert.match(result.detail, /missingHelper/);
});

test('ASG-3: a changed file importing an unchanged module passes', () => {
  fs.writeFileSync(path.join(repo, 'existing.ts'), 'export const EXISTING = 1;\n');
  fs.writeFileSync(path.join(repo, 'consumer.ts'), [
    "import { EXISTING } from './existing';",
    'export const doubled = EXISTING * 2;',
  ].join('\n'));

  const result = runGate('ast-structural-verification', context(['consumer.ts']));
  assert.ok(result.passed, `the gate refused an import of an unchanged module: ${result.detail}`);
});

test('ASG-4: a unit that changed no TypeScript/JavaScript file is not applicable', () => {
  fs.writeFileSync(path.join(repo, 'notes.md'), '# notes\n');
  const result = runGate('ast-structural-verification', context(['notes.md']));
  assert.ok(result.passed);
  assert.match(result.detail, /not applicable/);
});
