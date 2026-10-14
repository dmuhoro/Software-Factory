/**
 * WP-4: foundation readiness.
 *
 * The ledger probe already proves the store's own write path. What it does not prove is the
 * ground the store stands on: a data directory that is read-only, not creatable, or running out
 * of space. Those conditions fail the *next* whole-file ledger rewrite, not the probe that just
 * ran — so a service can report healthy and lose the ledger minutes later. This suite asserts
 * that the data directory is now its own readiness check, that a failure is `fail` (which makes
 * the whole report `unhealthy`), and that the server treats `unhealthy` as a fatal startup
 * refusal with exit 75, not a warning.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { DurableStore } = await import('../src/services/durableStore');
const { classifyReadiness, evaluateFreeSpace, MIN_FREE_BYTES } = await import('../src/services/healthService');

/** Swaps FACTORY_DATA_DIR for a probe and restores it, so no test depends on another's env. */
async function withDataDir<T>(dir: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env.FACTORY_DATA_DIR;
  process.env.FACTORY_DATA_DIR = dir;
  DurableStore.resetForTests();
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.FACTORY_DATA_DIR;
    else process.env.FACTORY_DATA_DIR = previous;
    DurableStore.resetForTests();
  }
}

function storageCheck(report: ReturnType<typeof classifyReadiness>) {
  const check = report.details.find((entry) => entry.name === 'storage');
  assert.ok(check, 'readiness must include a storage check');
  return check;
}

// ── the free-space floor is a real, unit-tested boundary ───────────────────

test('WP-4: the free-space floor refuses below the minimum and passes at it', () => {
  assert.equal(evaluateFreeSpace(MIN_FREE_BYTES - 1).state, 'fail', 'one byte below the floor must fail');
  assert.equal(evaluateFreeSpace(MIN_FREE_BYTES).state, 'pass', 'exactly at the floor must pass');
  assert.equal(evaluateFreeSpace(MIN_FREE_BYTES * 1000).state, 'pass');
  assert.equal(evaluateFreeSpace(0).state, 'fail');
  assert.equal(evaluateFreeSpace(Number.NaN).state, 'warn', 'an unmeasurable space is a warning, never a pass');
  assert.equal(evaluateFreeSpace(-1).state, 'warn');
});

// ── a healthy directory proves its own durability ──────────────────────────

test('WP-4: a writable data directory is storage-pass and leaves no probe litter behind', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-storage-ok-'));
  const report = await withDataDir(dir, async () => classifyReadiness());

  const check = storageCheck(report);
  assert.equal(check.state, 'pass', `expected a writable directory to pass, got: ${check.detail}`);
  assert.match(check.detail, /fsync-durable/, 'the storage check must name durability, not just writability');
  assert.match(check.detail, /MiB free/, 'the storage check must report the free space it measured');
  // The probe is bounded and self-cleaning: no leftover file may survive into the ledger
  // directory, where a later write would carry it.
  const leftovers = fs.readdirSync(dir).filter((name) => name.startsWith('.health-'));
  assert.deepEqual(leftovers, [], 'the storage probe must remove its own temporary file');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── fail closed: a directory the process cannot write is unhealthy ─────────

test('WP-4: a read-only data directory reports storage fail and makes the service unhealthy', async () => {
  if (process.getuid?.() === 0) {
    // Root ignores permission bits, so a chmod cannot make a directory unwritable. The
    // non-creatable arm below is the root-proof version of the same refusal.
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-storage-ro-'));
  const dir = path.join(root, 'data');
  fs.mkdirSync(dir);
  fs.chmodSync(dir, 0o500);
  try {
    const report = await withDataDir(dir, async () => classifyReadiness());
    const check = storageCheck(report);
    assert.equal(check.state, 'fail', `a read-only data directory must fail, got: ${check.detail}`);
    assert.match(check.detail, /not writable or not fsync-durable/, 'the refusal must name the real fault');
    assert.equal(report.status, 'unhealthy', 'a data directory the process cannot write is not degraded');
  } finally {
    fs.chmodSync(dir, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('WP-4: a data directory that cannot even be created is refused before any write is attempted', async () => {
  // Point FACTORY_DATA_DIR at a path whose parent is a regular file. Creating it is ENOTDIR, a
  // filesystem error rather than a permission one, so this arm is meaningful even as root.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-storage-nd-'));
  const blocker = path.join(root, 'not-a-dir');
  fs.writeFileSync(blocker, 'x');
  const dir = path.join(blocker, 'data');
  try {
    const report = await withDataDir(dir, async () => classifyReadiness());
    const check = storageCheck(report);
    assert.equal(check.state, 'fail', `an uncreatable data directory must fail, got: ${check.detail}`);
    assert.match(check.detail, /not creatable/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── the server treats unhealthy as fatal, with the documented exit code ────

test('WP-4: the server refuses to serve on unhealthy with exit 75, not a warning', async () => {
  const serverSource = fs.readFileSync(path.resolve(process.cwd(), 'server.ts'), 'utf8');

  // The unhealthy branch must refuse, not warn. Read the code, not a comment: this assertion
  // fails if someone downgrades the branch to a log line while leaving the text intact.
  const unhealthyBranch = serverSource.match(/if \(readiness\.status === 'unhealthy'\)/);
  assert.ok(unhealthyBranch, 'server.ts must branch on unhealthy');

  const refuser = serverSource.match(/function refuseWhileLedgerUnusable[\s\S]{0,400}/);
  assert.ok(refuser, 'server.ts must have a refusal helper');
  assert.match(refuser[0], /process\.exit\(75\)/, 'the refusal helper must exit 75 (EX_TEMPFAIL)');
  assert.ok(
    /readiness pre-flight failed[\s\S]{0,800}refuseWhileLedgerUnusable/.test(serverSource),
    'the unhealthy branch must reach the refusal helper',
  );
});
