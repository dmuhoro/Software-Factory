/**
 * NC-3: exactly one package manager, and the shipped image is built from the tested tree.
 *
 * This repository tracked `package-lock.json` and `bun.lock` at the same time. That is not
 * tidiness. CI ran `npm ci` and every test under npm, while the Dockerfile ran
 * `bun install --frozen-lockfile` and shipped the result. The two lockfiles disagree on the
 * resolved version of 63 of their 313 shared packages, so the image that ran in production
 * was assembled from a dependency set that no test in this repository had ever executed.
 *
 * The pipeline was green. It was green about a build nobody would deploy.
 *
 * These tests exist because the condition is easy to reintroduce: adding a lockfile is one
 * command, and nothing in a test suite objects. A guard is cheaper than the defect.
 */

import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';

const ROOT = process.cwd();

/**
 * Lockfiles that would create a second source of truth for dependency versions.
 *
 * Both bun spellings are listed. The file that caused this defect was `bun.lock`; a
 * negative control that reintroduced it initially PASSED, because the guard listed only
 * `bun.lockb` -- the binary variant. A guard that names the wrong filename is worse than no
 * guard, because it is a green check standing in front of the defect it claims to prevent.
 */
const FOREIGN_LOCKFILES = ['bun.lock', 'bun.lockb', 'yarn.lock', 'pnpm-lock.yaml'];

test('NC-3: exactly one lockfile is tracked, and it is package-lock.json', () => {
  assert.ok(
    existsSync(join(ROOT, 'package-lock.json')),
    'package-lock.json must exist; npm is the canonical package manager',
  );

  // Enumerated from a known list rather than by globbing, so a lockfile added later cannot
  // slip through by having an unexpected name. If a new manager is ever adopted, it is
  // added here as an explicit decision rather than arriving by accident.
  const present = FOREIGN_LOCKFILES.filter((name) => existsSync(join(ROOT, name)));
  assert.deepEqual(
    present,
    [],
    `a second lockfile is present (${present.join(', ')}). Two lockfiles mean two dependency ` +
      'trees, and the one that ships may not be the one that was tested. If a package ' +
      'manager change is intended, retire the old lockfile in the same change and add the ' +
      'replacement to this list.',
  );
});

/**
 * A Dockerfile's comments are prose about the build; its instructions are the build.
 *
 * This helper exists because the first version of the test below scanned the raw file and
 * failed on the comment that documents why bun was removed -- it matched the string
 * `bun install` in a sentence explaining the defect it was checking for. A test that reads
 * the prose as the configuration will eventually forbid the explanation of its own subject.
 */
function dockerInstructions(): string {
  return readFileSync(join(ROOT, 'Dockerfile'), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

test('NC-3: the Dockerfile installs from package-lock.json, not a foreign lockfile', () => {
  const dockerfile = dockerInstructions();

  // This is the assertion that matters most. The original Dockerfile built the shipped
  // artifact from bun.lock while CI tested package-lock.json, so a green pipeline attested
  // to a build that was never verified. If this ever regresses, the image and the test
  // evidence describe different software again.
  assert.equal(
    /bun\s+install/.test(dockerfile),
    false,
    'the image must not install with bun; CI tests the npm tree, so the image must be built ' +
      'from the npm tree or the test evidence does not apply to what ships',
  );
  assert.ok(
    /npm ci/.test(dockerfile),
    'the image must install with `npm ci`, which honours the lockfile exactly and fails if ' +
      'package.json and package-lock.json have drifted apart',
  );
  assert.ok(
    /COPY package\.json package-lock\.json/.test(dockerfile),
    'the build must copy the lockfile; caching on package.json alone would resolve fresh ' +
      'versions on every build and make images non-reproducible',
  );
});

test('NC-3: the runtime image installs production dependencies only', () => {
  const dockerfile = dockerInstructions();
  assert.ok(
    /npm ci --omit=dev/.test(dockerfile),
    'the runtime stage must exclude devDependencies. The build stage needs vite, esbuild ' +
      'and tsc; none of them belong in a running image, and their presence widens the ' +
      'attack surface for no functional benefit.',
  );
});

test('NC-3: the lockfile in the repository agrees with package.json', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));

  assert.equal(
    lock.version,
    pkg.version,
    'package-lock.json records the root version; a mismatch means the lockfile was not ' +
      'regenerated after a version bump',
  );

  // The root entry of `packages` is the empty path, and it carries the declared ranges.
  // If it disagrees with package.json, `npm ci` will refuse, but only when someone runs
  // `npm ci` -- and the point of this test is to fail before an image build does.
  const root = lock.packages[''];
  assert.ok(root, 'package-lock.json has no root package entry, so it is not a v2/v3 lockfile');

  for (const field of ['dependencies', 'devDependencies'] as const) {
    const declared = pkg[field] ?? {};
    const locked = root[field] ?? {};
    for (const [name, range] of Object.entries(declared)) {
      assert.equal(
        locked[name],
        range,
        `${field}.${name} is "${range}" in package.json but "${locked[name]}" in the ` +
          'lockfile; `npm ci` will refuse until the lockfile is regenerated',
      );
    }
  }
});

test('NC-3: every CI job installs with npm, so the tested tree is the shipped tree', () => {
  const workflow = readFileSync(join(ROOT, '.github/workflows/verify.yml'), 'utf8');

  assert.ok(
    /npm ci/.test(workflow),
    'CI must use `npm ci` so the tested tree is exactly the locked tree',
  );
  for (const other of ['bun install', 'yarn install', 'pnpm install']) {
    assert.equal(
      workflow.includes(other),
      false,
      `CI installs with "${other}" while the repository canonicalises npm. Every gate would ` +
        'then attest to a tree that is not the one an image build produces.',
    );
  }
});
