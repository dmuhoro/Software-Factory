/**
 * AST verification adapter tests (Layer 4 Adapter).
 *
 * Proves:
 *  - AVA-1  adapter verifies TypeScript files and reports structural issues
 *  - AVA-2  undefined imports are detected
 *  - AVA-3  undefined calls are detected
 *  - AVA-4  no issues when all symbols are defined
 *  - AVA-5  enforce=false still reports issues but passes
 *  - AVA-6  empty file list yields no issues
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { astVerificationAdapter, type ASTVerificationInput } from '../src/services/astVerificationAdapter';

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-ava-'));
const repo = path.join(state, 'repo');
fs.mkdirSync(repo, { recursive: true });

test('AVA-1: adapter verifies TypeScript files and reports structural issues', () => {
  fs.writeFileSync(path.join(repo, 'a.ts'), `export const VERSION = '1.0.0';\n`);
  fs.writeFileSync(path.join(repo, 'b.ts'), `import { VERSION } from './a';\nexport function getVersion(): string { return VERSION; }\n`);

  const result = astVerificationAdapter.verify({
    files: ['a.ts', 'b.ts'],
    repo,
    enforce: true,
  });
  assert.equal(result.filesParsed, 2);
  assert.ok(result.symbolsDefined > 0);
  assert.equal(result.issues.length, 0, 'no issues when all symbols are defined');
  assert.ok(result.passed);
});

test('AVA-2: undefined imports are detected', () => {
  fs.writeFileSync(path.join(repo, 'only.ts'), `import { doesNotExist } from './other';\nexport const x = 1;\n`);

  const result = astVerificationAdapter.verify({
    files: ['only.ts'],
    repo,
    enforce: true,
  });
  const undefinedImports = result.issues.filter((i) => i.type === 'undefined-import');
  assert.ok(undefinedImports.length > 0, 'undefined import detected');
  assert.ok(result.passed === false || result.issues.length > 0);
});

test('AVA-3: undefined calls are detected', () => {
  fs.writeFileSync(path.join(repo, 'calls.ts'), `export function foo() { return bar(); }\n`);

  const result = astVerificationAdapter.verify({
    files: ['calls.ts'],
    repo,
    enforce: true,
  });
  const undefinedCalls = result.issues.filter((i) => i.type === 'undefined-call');
  assert.ok(undefinedCalls.length > 0, 'undefined call detected');
});

test('AVA-4: no issues when all symbols are defined across files', () => {
  fs.writeFileSync(path.join(repo, 'defs.ts'), `export const VALUE = 42;\nexport function useValue(v: number) { return v; }\n`);
  fs.writeFileSync(path.join(repo, 'user.ts'), `import { VALUE, useValue } from './defs';\nexport const result = useValue(VALUE);\n`);

  const result = astVerificationAdapter.verify({
    files: ['defs.ts', 'user.ts'],
    repo,
    enforce: true,
  });
  assert.equal(result.issues.length, 0, 'no cross-file issues');
  assert.ok(result.passed);
});

test('AVA-5: enforce=false reports issues but passes', () => {
  fs.writeFileSync(path.join(repo, 'broken.ts'), `import { missing } from './nowhere';\n`);

  const result = astVerificationAdapter.verify({
    files: ['broken.ts'],
    repo,
    enforce: false,
  });
  assert.ok(result.issues.length > 0, 'issues still reported');
  assert.ok(result.passed, 'passes even with issues when enforce is off');
});

test('AVA-6: empty file list yields no issues', () => {
  const result = astVerificationAdapter.verify({
    files: [],
    repo,
    enforce: true,
  });
  assert.equal(result.filesParsed, 0);
  assert.equal(result.issues.length, 0);
  assert.ok(result.passed);
});
