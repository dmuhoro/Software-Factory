#!/usr/bin/env tsx
/**
 * `npx tsx scripts/bench-fixtures.ts`        # (re)generate the benchmark fixtures
 * `npx tsx scripts/bench-fixtures.ts --check` # verify they are current (exit 1 on drift)
 *
 * The skills benchmark (WP-4) needs canned tasks with a single, mechanically checkable acceptance
 * criterion so an on/off comparison measures the skill, not the reviewer's taste. Twelve synthetic
 * fixture tasks live under `test/fixtures/bench/`, one directory each, holding the seed files and a
 * task document. They are generated from this script so the set is reproducible and reviewable as a
 * diff, rather than twelve hand-maintained copies that drift.
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
const COUNT = 12;

function fixtureName(index: number): string {
  return `bench-${String(index).padStart(2, '0')}`;
}

function token(index: number): string {
  return `bench-token-${String(index).padStart(2, '0')}`;
}

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

function expectedFiles(index: number): Record<string, string> {
  return {
    'check.cjs': checkScript(index),
    'README.md': readme(index),
    'task.md': taskDocument(index),
  };
}

function main(): void {
  const check = process.argv.includes('--check');
  let drift = 0;

  for (let index = 1; index <= COUNT; index += 1) {
    const dir = path.join(BENCH_DIR, fixtureName(index));
    for (const [name, content] of Object.entries(expectedFiles(index))) {
      const full = path.join(dir, name);
      if (check) {
        const actual = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
        if (actual !== content) {
          console.error(`bench fixture drift: ${path.relative(ROOT, full)}`);
          drift += 1;
        }
      } else {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(full, content, 'utf8');
      }
    }
  }

  if (check) {
    if (drift) {
      console.error(`bench: ${drift} fixture file(s) drifted; run \`npx tsx scripts/bench-fixtures.ts\``);
      process.exit(1);
    }
    console.log(`bench: ${COUNT} fixtures verified`);
    return;
  }
  console.log(`bench: wrote ${COUNT} fixtures into test/fixtures/bench`);
}

main();
