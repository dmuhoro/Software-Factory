/**
 * Sprint 34, WP-2: the benchmark fixtures, and the property that makes them worth running.
 *
 * A fixture that already passes measures nothing: the on/off comparison would see two zeros. So the
 * load-bearing property of a fixture is **failing first** — its own acceptance check must fail on the
 * committed seed, and pass once the intended change is made. This test proves both, for real, by
 * running each fixture's `check.cjs` in a temp copy of the seed and again with the corrected files.
 *
 * It also asserts the single-file fixtures are failing-first (no `bench.txt` yet), that the
 * multi-file fixtures carry at least three source files so the change genuinely spans modules, and
 * that the committed fixtures equal what the generator would write (no silent drift).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import {
  SINGLE_FIXTURE_COUNT,
  MULTI_FIXTURE_COUNT,
  FIXTURE_COUNT,
  benchFixtureFiles,
  multiFixture,
} from '../scripts/bench-fixtures';

const ROOT = process.cwd();
const BENCH_DIR = path.join(ROOT, 'test', 'fixtures', 'bench');

function fixtureName(index: number): string {
  return `bench-${String(index).padStart(2, '0')}`;
}

function materialise(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-fixture-test-'));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return dir;
}

/** Runs the fixture's own acceptance check; returns true when it exits 0. */
function checkPasses(dir: string): boolean {
  try {
    execFileSync('node', ['check.cjs'], { cwd: dir, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

test('WP-2: every committed fixture matches what the generator would write (no drift)', () => {
  for (let index = 1; index <= FIXTURE_COUNT; index += 1) {
    const dir = path.join(BENCH_DIR, fixtureName(index));
    for (const [name, content] of Object.entries(benchFixtureFiles(index))) {
      const full = path.join(dir, name);
      assert.ok(fs.existsSync(full), `missing committed fixture file: ${path.relative(ROOT, full)}`);
      assert.equal(fs.readFileSync(full, 'utf8'), content, `drifted fixture file: ${path.relative(ROOT, full)}`);
    }
  }
});

test('WP-2: there are at least four multi-file fixtures', () => {
  assert.ok(MULTI_FIXTURE_COUNT >= 4, `expected >= 4 multi-file fixtures, have ${MULTI_FIXTURE_COUNT}`);
});

test('WP-2: the single-file fixtures are failing-first (no bench.txt in the seed)', () => {
  for (let index = 1; index <= SINGLE_FIXTURE_COUNT; index += 1) {
    const dir = materialise(benchFixtureFiles(index));
    try {
      assert.equal(checkPasses(dir), false, `${fixtureName(index)} must fail before the task is done`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('WP-2: each multi-file fixture spans >= 3 source files, fails first, and passes after the fix', () => {
  for (let index = SINGLE_FIXTURE_COUNT + 1; index <= FIXTURE_COUNT; index += 1) {
    const fixture = multiFixture(index);
    const sources = Object.keys(fixture.seed).filter((name) => name.startsWith('lib/'));
    assert.ok(sources.length >= 3, `${fixtureName(index)} must touch >= 3 source files, has ${sources.length}`);

    const seedDir = materialise(fixture.seed);
    const fixedDir = materialise(fixture.fixed);
    try {
      assert.equal(checkPasses(seedDir), false, `${fixtureName(index)} seed must fail its own check first`);
      assert.equal(checkPasses(fixedDir), true, `${fixtureName(index)} must pass once its three constants are corrected`);
    } finally {
      fs.rmSync(seedDir, { recursive: true, force: true });
      fs.rmSync(fixedDir, { recursive: true, force: true });
    }
  }
});

test('WP-2: the multi-file fix differs from the seed in exactly the three leaf modules', () => {
  for (let index = SINGLE_FIXTURE_COUNT + 1; index <= FIXTURE_COUNT; index += 1) {
    const { seed, fixed } = multiFixture(index);
    const changed = Object.keys(seed).filter((name) => seed[name] !== fixed[name]);
    assert.deepEqual(changed.sort(), ['lib/format.js', 'lib/label.js', 'lib/units.js'].sort(), `${fixtureName(index)} fix must be the three leaf modules`);
  }
});
