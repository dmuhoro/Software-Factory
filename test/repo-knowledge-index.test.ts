/**
 * Repository knowledge index tests (Graphify steal, adapted to SF).
 *
 * Proves:
 *  - RKI-1  a repository scan finds source files, sorted, and skips dependencies
 *  - RKI-2  a relative module specifier resolves to a real file, or to nothing
 *  - RKI-3  the import closure follows relative imports transitively
 *  - RKI-4  a repo-scoped query finds a symbol's real definition and says whether it was truncated
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildImportClosure,
  resolveRelativeModule,
  scanRepositorySources,
  searchRepositorySymbols,
} from '../src/services/repoKnowledgeIndex';

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-rki-'));
const repo = path.join(state, 'repo');
fs.mkdirSync(path.join(repo, 'src', 'lib'), { recursive: true });
fs.mkdirSync(path.join(repo, 'node_modules', 'left-pad'), { recursive: true });

fs.writeFileSync(path.join(repo, 'src', 'app.ts'), [
  "import { helper } from './lib/helper';",
  "import { INDEX } from './lib';",
  'export function run(): string { return helper(INDEX); }',
].join('\n'));
fs.writeFileSync(path.join(repo, 'src', 'lib', 'helper.ts'), [
  "export const helper = (value: string): string => value.toUpperCase();",
].join('\n'));
fs.writeFileSync(path.join(repo, 'src', 'lib', 'index.ts'), [
  "export const INDEX = 'index';",
].join('\n'));
fs.writeFileSync(path.join(repo, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');

test('RKI-1: a repository scan finds source files, sorted, and skips dependencies', () => {
  const scan = scanRepositorySources(repo);
  assert.deepEqual(scan.files, [
    path.join('src', 'app.ts'),
    path.join('src', 'lib', 'helper.ts'),
    path.join('src', 'lib', 'index.ts'),
  ]);
  assert.equal(scan.truncated, false);
});

test('RKI-2: a relative module specifier resolves to a real file, or to nothing', () => {
  assert.equal(resolveRelativeModule(repo, path.join('src', 'app.ts'), './lib/helper'), path.join('src', 'lib', 'helper.ts'));
  assert.equal(resolveRelativeModule(repo, path.join('src', 'app.ts'), './lib'), path.join('src', 'lib', 'index.ts'));
  assert.equal(resolveRelativeModule(repo, path.join('src', 'app.ts'), './missing'), undefined);
  assert.equal(resolveRelativeModule(repo, path.join('src', 'app.ts'), 'node:fs'), undefined, 'a bare specifier is not relative');
  assert.equal(resolveRelativeModule(repo, path.join('src', 'app.ts'), '../../escape'), undefined, 'an escaping path is refused');
});

test('RKI-3: the import closure follows relative imports transitively', () => {
  const closure = buildImportClosure(repo, [path.join('src', 'app.ts')]);
  assert.ok(closure.graphs.has(path.join('src', 'app.ts')));
  assert.ok(closure.graphs.has(path.join('src', 'lib', 'helper.ts')), 'the imported module is in the closure');
  assert.ok(closure.graphs.has(path.join('src', 'lib', 'index.ts')), 'the directory index is in the closure');
  assert.ok(closure.definedNames.has('helper'), 'a symbol defined in an imported module is defined');
  assert.ok(closure.exportsByFile.get(path.join('src', 'lib', 'helper.ts'))!.has('helper'));
  assert.deepEqual(closure.unresolvedModules, []);
});

test('RKI-4: a repo-scoped query finds a symbol\'s real definition and says whether it was truncated', () => {
  const result = searchRepositorySymbols(repo, 'helper');
  assert.ok(result.matches.length >= 1);
  const definition = result.matches.find((match) => match.kind === 'variable');
  assert.ok(definition, 'the definition is found');
  assert.equal(definition!.file, path.join('src', 'lib', 'helper.ts'));
  assert.equal(definition!.line, 1);
  assert.equal(result.truncated, false);
  assert.equal(result.filesScanned, 3);

  const truncated = searchRepositorySymbols(repo, 'helper', { maxFiles: 1 });
  assert.equal(truncated.truncated, true, 'a scan that hit its ceiling says so');
});
