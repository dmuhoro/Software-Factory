/**
 * WP-6: the unrelated-writes shadow report.
 *
 * The guard ships in shadow mode; flipping `enforce` is a decision that needs evidence. These tests
 * pin the report that produces that evidence: that it recomputes the set with the *same* function as
 * the gate (so it can never describe a guard that does not exist), that it lists every file the
 * gate's truncated detail string would drop, that it ignores units that never committed, and that it
 * is exposed as a real command.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { unrelatedWritesIn } from '../src/services/unrelatedWrites';
import { summariseUnrelatedWrites, renderUnrelatedWritesReport } from '../src/services/unrelatedWritesReportService';
import { runGate, type GateContext } from '../src/services/loopGates';
import { slimProof, type LoopRunRecord, type UnitRecord } from '../src/services/loopTypes';
import type { GroundTruthProof } from '../src/services/groundTruthService';
import type { IsolationManifest } from '../src/services/doctrineIsolationService';

function proofValue(claimedFiles: string[], observedFiles: string[]): GroundTruthProof {
  return {
    passed: true,
    repo: '/tmp/unrelated-writes-report',
    head: '0'.repeat(40),
    checks: [],
    claimedFiles,
    observedFiles,
    rejectedNarration: [],
    recordedAt: new Date(0).toISOString(),
  };
}

function unit(overrides: Partial<UnitRecord>): UnitRecord {
  return {
    unitId: 'u1',
    milestoneId: 'm1',
    title: 'a unit',
    type: 'feature',
    criteria: [],
    dependsOn: [],
    status: 'done',
    attempts: [],
    ...overrides,
  };
}

function run(overrides: Partial<LoopRunRecord>): LoopRunRecord {
  return {
    runId: 'run-1',
    status: 'completed',
    startedAt: '2026-10-17T00:00:00.000Z',
    repo: '/tmp/unrelated-writes-report',
    taskDocument: 'task.md',
    taskDocumentHash: 'h',
    doctrineDigest: 'd',
    execution: 'sequential',
    attemptCap: 3,
    tenantId: 'default',
    quarantineCount: 0,
    units: [],
    commits: [],
    gates: [],
    events: [],
    models: [],
    narrationRejected: 0,
    ...overrides,
  } as LoopRunRecord;
}

// ── the shared function: the report and the gate cannot drift ─────────────────

test('the report and the gate agree, because they call the same function', () => {
  const claimed = ['src/a.ts'];
  const observed = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
  const allow: string[] = [];
  const expected = unrelatedWritesIn(claimed, observed, allow);
  assert.deepEqual(expected, ['src/b.ts', 'src/c.ts']);

  const ctx: GateContext = {
    stage: 'commit',
    timing: 'before',
    repo: '/tmp/unrelated-writes-report',
    isolation: { quarantine: [] } as unknown as IsolationManifest,
    run: {} as LoopRunRecord,
    proof: proofValue(claimed, observed),
    unrelatedWrites: { enforce: false, allow },
  };
  const result = runGate('unrelated-writes', ctx);
  assert.match(result.detail, new RegExp(`would refuse ${expected.length} unrelated write`), 'the gate must count what the shared function returns');
  for (const file of expected) assert.match(result.detail, new RegExp(file.replace('.', '\\.')), `the gate detail did not name ${file}`);
});

test('the report lists files the gate detail truncates, so "every would-refuse" is true', () => {
  const observed = Array.from({ length: 12 }, (_, index) => `src/u${String(index + 1).padStart(2, '0')}.ts`);
  const ctx: GateContext = {
    stage: 'commit',
    timing: 'before',
    repo: '/tmp/unrelated-writes-report',
    isolation: { quarantine: [] } as unknown as IsolationManifest,
    run: {} as LoopRunRecord,
    proof: proofValue([], observed),
    unrelatedWrites: { enforce: false, allow: [] },
  };
  const detail = runGate('unrelated-writes', ctx).detail;
  assert.match(detail, /\(\+2 more\)/, `the gate detail is expected to truncate at ten: ${detail}`);
  assert.ok(!detail.includes('src/u12.ts'), 'the twelfth file is past the gate detail cut');

  const report = summariseUnrelatedWrites([run({ units: [unit({ proof: slimProof(proofValue([], observed)) })] })], []);
  assert.equal(report.totalWouldRefuse, 12);
  assert.deepEqual(report.findings[0].files, observed, 'the report must list every file, including those the detail dropped');
});

// ── the summary ──────────────────────────────────────────────────────────────

test('a done unit with an unclaimed write is a finding that lists every file', () => {
  const report = summariseUnrelatedWrites(
    [run({ runId: 'r', tenantId: 'acme', units: [unit({ unitId: 'u7', title: 'wire the sensor', proof: slimProof(proofValue(['src/a.ts'], ['src/a.ts', 'src/b.ts'])) })] })],
    [],
  );
  assert.equal(report.runsScanned, 1);
  assert.equal(report.unitsWithProof, 1);
  assert.equal(report.totalWouldRefuse, 1);
  assert.deepEqual(report.findings, [
    { runId: 'r', tenantId: 'acme', unitId: 'u7', unitTitle: 'wire the sensor', at: '2026-10-17T00:00:00.000Z', files: ['src/b.ts'] },
  ]);
});

test('an allowlisted write is not a finding', () => {
  const report = summariseUnrelatedWrites(
    [run({ units: [unit({ proof: slimProof(proofValue(['src/a.ts'], ['src/a.ts', 'dist/app.js', 'pnpm-lock.yaml'])) })] })],
    ['dist/*', 'pnpm-lock.yaml'],
  );
  assert.equal(report.findings.length, 0, 'an allowlisted file must not be reported');
  assert.equal(report.totalWouldRefuse, 0);
  assert.deepEqual(report.allowlist, ['dist/*', 'pnpm-lock.yaml'], 'the report must echo the allowlist it applied');
});

test('a unit that never committed is not judged, even if it carries a proof', () => {
  const report = summariseUnrelatedWrites(
    [run({ units: [unit({ status: 'stuck', proof: slimProof(proofValue([], ['src/b.ts'])) })] })],
    [],
  );
  assert.equal(report.unitsWithProof, 0, 'a discarded tree must not be counted');
  assert.equal(report.findings.length, 0);
});

test('a unit with no stored proof is not judged', () => {
  const report = summariseUnrelatedWrites([run({ units: [unit({})] })], []);
  assert.equal(report.unitsWithProof, 0);
  assert.equal(report.totalWouldRefuse, 0);
});

test('an empty ledger is a valid answer: nothing scanned, nothing refused', () => {
  const report = summariseUnrelatedWrites([], []);
  assert.deepEqual(report, { runsScanned: 0, unitsWithProof: 0, findings: [], totalWouldRefuse: 0, allowlist: [] });
});

// ── rendering ────────────────────────────────────────────────────────────────

test('an empty report says so rather than printing a blank table', () => {
  const markdown = renderUnrelatedWritesReport(summariseUnrelatedWrites([], []));
  assert.match(markdown, /Runs scanned: 0/);
  assert.match(markdown, /would have refused nothing/);
});

test('a non-empty report names the unit, its run, and each file', () => {
  const report = summariseUnrelatedWrites(
    [run({ runId: 'run-9', tenantId: 'acme', units: [unit({ unitId: 'u3', title: 'the sensor', proof: slimProof(proofValue(['src/a.ts'], ['src/a.ts', 'src/b.ts', 'src/c.ts'])) })] })],
    [],
  );
  const markdown = renderUnrelatedWritesReport(report);
  assert.match(markdown, /Files the guard would refuse: 2/);
  assert.match(markdown, /u3/);
  assert.match(markdown, /run-9/);
  assert.match(markdown, /src\/b\.ts/);
  assert.match(markdown, /src\/c\.ts/);
});

// ── the command exists ───────────────────────────────────────────────────────

test('the report is a real, declared command whose script uses the service', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts['unrelated-writes:report'], 'tsx scripts/unrelated-writes-report.ts', 'the npm script is not declared');
  const source = fs.readFileSync(path.join(process.cwd(), 'scripts', 'unrelated-writes-report.ts'), 'utf8');
  assert.match(source, /unrelatedWritesReportService/, 'the script must use the summariser service');
  assert.ok(!/enforce\s*=\s*true/.test(source), 'the report must never flip enforcement');
});
