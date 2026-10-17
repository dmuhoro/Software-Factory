#!/usr/bin/env tsx
/**
 * `npx tsx scripts/bench-fixtures.ts`        # (re)generate the benchmark fixtures
 * `npx tsx scripts/bench-fixtures.ts --check` # verify they are current (exit 1 on drift)
 *
 * The skills benchmark (WP-4; extended in Sprint 34, WP-2) needs canned tasks with a single,
 * mechanically checkable acceptance criterion so an on/off comparison measures the skill, not the
 * reviewer's taste. Sixteen synthetic fixture tasks live under `test/fixtures/bench/`, one directory
 * each, holding the seed files and a task document. They are generated from this script so the set
 * is reproducible and reviewable as a diff, rather than hand-maintained copies that drift.
 *
 * Two kinds of fixture, because a benchmark of one shape measures one shape:
 *
 *   - **bench-01 … bench-12: single-file writes.** A one-line task (`write bench.txt with the
 *     token`) that a stub can satisfy, so the dry pass exercises the whole harness.
 *   - **bench-13 … bench-16: multi-file features.** Each seed is a three-module pipeline whose test
 *     **fails first**; the task is to make it pass, which requires editing three source files. These
 *     are the shape of real work — a change that spans modules — and they resist a model that only
 *     ever writes one file. The seed and the corrected files are both produced here, so a test can
 *     prove the failing-first property and the fix deterministically.
 *
 * A fixture directory is a *seed*, not a git repository: the harness copies it to a temp directory
 * and `git init`s it, so no nested repository is committed.
 *
 * The task document carries the literal `__MODEL__` where the model spec goes; the harness
 * substitutes the arm's model (a stub for the dry pass, a real provider/model for a real run).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BENCH_DIR = path.join(ROOT, 'test', 'fixtures', 'bench');
export const SINGLE_FIXTURE_COUNT = 12;
export const MULTI_FIXTURE_COUNT = 4;
export const FIXTURE_COUNT = SINGLE_FIXTURE_COUNT + MULTI_FIXTURE_COUNT;

function fixtureName(index: number): string {
  return `bench-${String(index).padStart(2, '0')}`;
}

function token(index: number): string {
  return `bench-token-${String(index).padStart(2, '0')}`;
}

// ── single-file fixtures (bench-01 … bench-12) ──────────────────────────────

function checkScript(index: number): string {
  return [
    "const fs = require('node:fs');",
    `const expected = ${JSON.stringify(token(index))};`,
    "const ok = fs.existsSync('bench.txt') && fs.readFileSync('bench.txt', 'utf8').includes(expected);",
    "if (!ok) { console.error('bench.txt missing or wrong content, expected ' + expected); process.exit(1); }",
    "console.log('ok');",
    '',
  ].join('\n');
}

function readme(index: number): string {
  return `# bench fixture ${String(index).padStart(2, '0')}\n\nA synthetic target for the skills benchmark (Sprint 33, WP-4).\n`;
}

function taskDocument(index: number): string {
  return [
    `# Task: ${fixtureName(index)} single-file write`,
    '',
    '## Goal',
    `Write bench.txt so it contains the token ${token(index)}.`,
    '',
    '## Constraints',
    '- No new dependencies',
    '- Touch only bench.txt',
    '',
    '## Models',
    'models.implementer: __MODEL__',
    'models.reviewer: __MODEL__',
    '',
    '## Milestones',
    `### M1: Write the token`,
    'type: feat',
    'verify: node check.cjs',
    `- [ ] bench.txt exists and contains ${token(index)}`,
    '',
  ].join('\n');
}

function singleFixture(index: number): Record<string, string> {
  return {
    'check.cjs': checkScript(index),
    'README.md': readme(index),
    'task.md': taskDocument(index),
  };
}

// ── multi-file fixtures (bench-13 … bench-16) ───────────────────────────────

/**
 * The three-module pipeline for one multi-file fixture.
 *
 * `lib/units.js` scales an input, `lib/label.js` prefixes it, `lib/format.js` appends a suffix, and
 * `lib/index.js` composes them. The seed has the wrong constant in each of the three leaf modules,
 * so the test fails; the corrected constants are returned alongside the seed so the failing-first
 * property and the fix can both be proven without re-deriving them.
 */
function multiParts(index: number): { input: number; corrected: { factor: number; prefix: string; suffix: string }; seeded: { factor: number; prefix: string; suffix: string } } {
  const input = index - 10; // 3, 4, 5, 6
  const factor = 10;
  return {
    input,
    corrected: { factor, prefix: `#${input * factor}:`, suffix: '!' },
    seeded: { factor: factor + 1, prefix: `#${input}:`, suffix: '.' },
  };
}

function unitsModule(factor: number): string {
  return [
    '/** Scales a raw count. The factor is the fixture\'s single source of truth for scaling. */',
    `const FACTOR = ${factor};`,
    'function scale(n) {',
    '  return n * FACTOR;',
    '}',
    'module.exports = { scale };',
    '',
  ].join('\n');
}

function labelModule(prefix: string): string {
  return [
    '/** Prefixes a scaled count for display. */',
    `const PREFIX = ${JSON.stringify(prefix)};`,
    'function tag(s) {',
    "  return PREFIX + s;",
    '}',
    'module.exports = { tag };',
    '',
  ].join('\n');
}

function formatModule(suffix: string): string {
  return [
    '/** Appends the display suffix. */',
    `const SUFFIX = ${JSON.stringify(suffix)};`,
    'function wrap(s) {',
    '  return s + SUFFIX;',
    '}',
    'module.exports = { wrap };',
    '',
  ].join('\n');
}

const INDEX_MODULE = [
  "const { scale } = require('./units');",
  "const { tag } = require('./label');",
  "const { wrap } = require('./format');",
  '/** Renders a raw count through the whole pipeline. */',
  'function render(n) {',
  '  return wrap(tag(scale(n)));',
  '}',
  'module.exports = { render };',
  '',
].join('\n');

function multiTest(input: number, expected: string): string {
  return [
    "const assert = require('node:assert/strict');",
    "const { render } = require('./lib/index');",
    `assert.strictEqual(render(${input}), ${JSON.stringify(expected)});`,
    "console.log('ok');",
    '',
  ].join('\n');
}

/** Runs the fixture's own test as the acceptance check: it throws (non-zero) while the seed is wrong. */
function multiCheck(): string {
  return [
    "require('./test.js');",
    '',
  ].join('\n');
}

function multiTask(index: number, input: number, expected: string): string {
  return [
    `# Task: ${fixtureName(index)} multi-file pipeline`,
    '',
    '## Goal',
    `Make \`node check.cjs\` pass. The pipeline in \`lib/\` renders a raw count, and it currently`,
    `renders the wrong string: \`render(${input})\` must equal ${JSON.stringify(expected)}.`,
    'The three leaf modules (`lib/units.js`, `lib/label.js`, `lib/format.js`) each carry a constant',
    'that does not match the goal; correct them so the composed result is right.',
    '',
    '## Constraints',
    '- No new dependencies (node built-ins only)',
    '- Do not change test.js or check.cjs; fix the implementation',
    '- Keep the module boundaries: the scaling stays in units.js, the prefix in label.js, the suffix in format.js',
    '',
    '## Models',
    'models.implementer: __MODEL__',
    'models.reviewer: __MODEL__',
    '',
    '## Milestones',
    `### M1: Render the count correctly`,
    'type: feat',
    'verify: node check.cjs',
    `- [ ] node check.cjs passes`,
    `- [ ] render(${input}) equals ${JSON.stringify(expected)}`,
    '',
  ].join('\n');
}

export interface MultiFixture {
  /** The files as committed (the failing seed). */
  seed: Record<string, string>;
  /** The same files with the three constants corrected (the fix). */
  fixed: Record<string, string>;
}

export function multiFixture(index: number): MultiFixture {
  const { input, corrected, seeded } = multiParts(index);
  const expected = corrected.prefix + input * corrected.factor + corrected.suffix;
  const base: Record<string, string> = {
    'lib/index.js': INDEX_MODULE,
    'test.js': multiTest(input, expected),
    'check.cjs': multiCheck(),
    'task.md': multiTask(index, input, expected),
    'README.md': `# bench fixture ${String(index).padStart(2, '0')}\n\nA synthetic multi-file pipeline for the skills benchmark (Sprint 34, WP-2).\n`,
  };
  return {
    seed: {
      ...base,
      'lib/units.js': unitsModule(seeded.factor),
      'lib/label.js': labelModule(seeded.prefix),
      'lib/format.js': formatModule(seeded.suffix),
    },
    fixed: {
      ...base,
      'lib/units.js': unitsModule(corrected.factor),
      'lib/label.js': labelModule(corrected.prefix),
      'lib/format.js': formatModule(corrected.suffix),
    },
  };
}

/** The files committed for a fixture: the single-file seed or the multi-file seed. */
export function benchFixtureFiles(index: number): Record<string, string> {
  return index <= SINGLE_FIXTURE_COUNT ? singleFixture(index) : multiFixture(index).seed;
}

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
}

function main(): void {
  const check = process.argv.includes('--check');
  let drift = 0;

  for (let index = 1; index <= FIXTURE_COUNT; index += 1) {
    const dir = path.join(BENCH_DIR, fixtureName(index));
    for (const [name, content] of Object.entries(benchFixtureFiles(index))) {
      const full = path.join(dir, name);
      if (check) {
        const actual = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
        if (actual !== content) {
          console.error(`bench fixture drift: ${path.relative(ROOT, full)}`);
          drift += 1;
        }
      } else {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, 'utf8');
      }
    }
  }

  if (check) {
    if (drift) {
      console.error(`bench: ${drift} fixture file(s) drifted; run \`npx tsx scripts/bench-fixtures.ts\``);
      process.exit(1);
    }
    console.log(`bench: ${FIXTURE_COUNT} fixtures verified (${SINGLE_FIXTURE_COUNT} single-file, ${MULTI_FIXTURE_COUNT} multi-file)`);
    return;
  }
  console.log(`bench: wrote ${FIXTURE_COUNT} fixtures into test/fixtures/bench (${SINGLE_FIXTURE_COUNT} single-file, ${MULTI_FIXTURE_COUNT} multi-file)`);
}

// Run only when executed directly, so a test can import the definitions.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
