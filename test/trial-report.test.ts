/**
 * The production-trial report (Sprint 34, WP-4).
 *
 * The invariant under test is the report's honesty rule: a figure it cannot derive is `null` and
 * named in `underivable`, never zero; a commit is "verified" only when it still exists and HEAD
 * contains it; a revert is read from git's own message, not guessed from a subject line; and an
 * operator note is labelled as an opinion, separate from the derived totals.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AttemptRecord, LoopRunRecord, UnitRecord } from '../src/services/loopTypes';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-trial-report-'));
process.env.FACTORY_DATA_DIR = path.join(root, 'data');
process.env.FACTORY_WORKSPACE_ROOT = path.join(root, 'ws');
process.env.NODE_ENV = 'test';
process.env.FACTORY_API_KEY = 'test-platform-key-0123456789abcdef';
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.FACTORY_WORKSPACE_ROOT, { recursive: true });

const { DurableStore } = await import('../src/services/durableStore');
const {
  assertGitRepository, appendTrialNote, buildTrialReport, collectCommitFacts, readTrialNotes, renderTrialReport,
} = await import('../src/services/trialReportService');

DurableStore.resetForTests();

const ISO_OLD = '2026-01-01T00:00:00.000Z';
const NOW = '2026-06-01T00:00:00.000Z';

function sh(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
    encoding: 'utf8',
  });
}

function repoWithHistory(): { repo: string; loopShas: string[]; reverted: string; repaired: string } {
  const repo = fs.mkdtempSync(path.join(root, 'repo-'));
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  sh(repo, 'init', '-q');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-qm', 'initial');

  fs.writeFileSync(path.join(repo, 'feature.ts'), 'export const x = 1;\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-qm', 'loop unit 1');
  const repaired = sh(repo, 'rev-parse', 'HEAD').trim();

  fs.writeFileSync(path.join(repo, 'other.ts'), 'export const y = 2;\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-qm', 'loop unit 2');
  const reverted = sh(repo, 'rev-parse', 'HEAD').trim();

  // A repair touching the first loop commit's file, then a revert of the second.
  fs.writeFileSync(path.join(repo, 'feature.ts'), 'export const x = 2;\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-qm', 'fix: correct the seed value');
  sh(repo, 'revert', '--no-edit', reverted);
  return { repo, loopShas: [repaired, reverted], reverted, repaired };
}

function run(repo: string, overrides: Partial<LoopRunRecord> = {}): LoopRunRecord {
  return {
    runId: 'run-1', status: 'completed', startedAt: '2026-05-01T00:00:00.000Z',
    finishedAt: '2026-05-01T00:10:00.000Z', repo, taskDocument: 't', taskDocumentHash: 'h',
    doctrineDigest: 'd', execution: 'sequential', attemptCap: 3, tenantId: 'tenant_a',
    quarantineCount: 0, units: [], commits: [], gates: [], events: [], models: [],
    narrationRejected: 0, ...overrides,
  };
}

function unit(id: string, status: string, attempts: AttemptRecord[]): UnitRecord {
  return { unitId: id, milestoneId: 'm', title: id, type: 'feature', criteria: [], dependsOn: [], status: status as UnitRecord['status'], attempts };
}

test('a non-git directory is refused, not reported on', () => {
  const plain = fs.mkdtempSync(path.join(root, 'plain-'));
  assert.throws(() => assertGitRepository(plain), /not a git repository/);
  assert.throws(() => assertGitRepository(path.join(plain, 'absent')), /does not exist/);
});

test('a commit is verified only when it exists and HEAD contains it', () => {
  const { repo, loopShas } = repoWithHistory();
  // A commit on an unmerged branch is not an ancestor of HEAD.
  const base = sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  sh(repo, 'checkout', '-q', '-b', 'side');
  fs.writeFileSync(path.join(repo, 'side.txt'), 's\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-qm', 'loop unit side');
  const sideSha = sh(repo, 'rev-parse', 'HEAD').trim();
  sh(repo, 'checkout', '-q', base);

  const facts = collectCommitFacts(repo, [...loopShas, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', sideSha], NOW);
  assert.equal(facts.filter((f) => f.verified).length, 2);
  assert.equal(facts.find((f) => f.sha === sideSha)?.reason, 'not-an-ancestor-of-head');
  assert.equal(
    facts.find((f) => f.sha === 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')?.reason,
    'missing-from-repository',
  );
});

test('a revert is detected from git\'s own message, and a repair from its file and subject', () => {
  const { repo, loopShas, reverted, repaired } = repoWithHistory();
  const facts = collectCommitFacts(repo, loopShas, '2020-01-01T00:00:00.000Z');
  const revertedFact = facts.find((f) => f.sha === reverted);
  const repairedFact = facts.find((f) => f.sha === repaired);
  assert.ok(revertedFact?.revertedBy, 'the reverted loop commit must name the revert commit');
  assert.ok(repairedFact?.fixedBy?.length, 'the repaired loop commit must name its repair commit');
});

test('units are counted by outcome, and an unclassified failure is counted, never labelled', () => {
  const { repo } = repoWithHistory();
  const attempts = (passed: boolean, cls?: AttemptRecord['failureClass']): AttemptRecord => ({
    attempt: 1, startedAt: ISO_OLD, finishedAt: ISO_OLD, stage: 'verify', passed, reason: 'r', detail: '',
    ...(cls ? { failureClass: cls } : {}),
  });
  const report = buildTrialReport({
    repo, since: '2026-01-01T00:00:00.000Z', usage: [], notes: [], commitFacts: [], ledger: 'x',
    now: NOW,
    runs: [run(repo, {
      units: [
        unit('u1', 'done', [attempts(false, 'verification'), attempts(true)]),
        unit('u2', 'stuck', [attempts(false, 'verification'), attempts(false)]),
        unit('u3', 'pending', []),
      ],
    })],
  });
  assert.deepEqual(report.totals.units, { attempted: 2, done: 1, stuck: 1, blocked: 0, pending: 1 });
  assert.deepEqual(report.totals.failureClasses, { verification: 2 });
  assert.equal(report.totals.unclassifiedFailedAttempts, 1);
  assert.equal(report.totals.wallTimeMs, 600_000);
});

test('tokens are null when no usage was reported, and a real sum otherwise', () => {
  const { repo } = repoWithHistory();
  const empty = buildTrialReport({
    repo, since: '2026-01-01T00:00:00.000Z', usage: [], notes: [], commitFacts: [], ledger: 'x', runs: [run(repo)], now: NOW,
  });
  assert.equal(empty.totals.tokens, null);
  assert.ok(empty.underivable.some((item) => item.startsWith('tokens')));

  const usage = [
    { id: '1', tenantId: 't', source: 'ai-transform', tokens: 10, recordedAt: '2026-05-02T00:00:00.000Z', model: 'm1' },
    { id: '2', tenantId: 't', source: 'ai-transform', tokens: 5, recordedAt: '2026-05-03T00:00:00.000Z', model: 'm1' },
    { id: '3', tenantId: 't', source: 'ai-transform', tokens: 99, recordedAt: '2025-01-01T00:00:00.000Z', model: 'old' },
  ];
  const summed = buildTrialReport({
    repo, since: '2026-01-01T00:00:00.000Z', usage, notes: [], commitFacts: [], ledger: 'x', runs: [run(repo)], now: NOW,
  });
  assert.equal(summed.totals.tokens, 15);
  assert.equal(summed.totals.costUsd, null);
  assert.deepEqual(summed.totals.models, ['m1']);
});

test('operator notes are labelled, durable, and scoped to their repository', () => {
  const ledger = path.join(root, 'data', 'software-factory.json');
  const repoA = path.join(root, 'repo-a');
  const repoB = path.join(root, 'repo-b');
  appendTrialNote(ledger, { at: NOW, repo: repoA, verdict: 'accept', notes: 'shipped cleanly', source: 'operator' });
  appendTrialNote(ledger, { at: NOW, repo: repoB, verdict: null, notes: 'other', source: 'operator' });
  const notes = readTrialNotes(ledger, repoA);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].source, 'operator');
  assert.match(renderTrialReport({
    version: 1, repo: repoA, since: NOW, generatedAt: NOW, ledger, notes,
    totals: buildTrialReport({
      repo: repoA, since: NOW, usage: [], notes, commitFacts: [], ledger, now: NOW, runs: [],
    }).totals,
    commits: [], underivable: ['tokens (none)'],
  }), /source: operator/);
});

test('the report refuses to invent a wall time for a run with no finish', () => {
  const { repo } = repoWithHistory();
  const report = buildTrialReport({
    repo, since: '2026-01-01T00:00:00.000Z', usage: [], notes: [], commitFacts: [], ledger: 'x', now: NOW,
    runs: [run(repo, { status: 'halted', finishedAt: undefined })],
  });
  assert.equal(report.totals.wallTimeMs, null);
  assert.ok(report.underivable.some((item) => item.startsWith('wallTimeMs')));
  assert.equal(report.totals.runsByStatus.halted, 1);
});

test('the CLI refuses missing arguments and refuses a directory that is not a repository', () => {
  const cli = path.join(process.cwd(), 'scripts', 'trial-report.ts');
  const env = { ...process.env, FACTORY_DATA_DIR: process.env.FACTORY_DATA_DIR! };
  const runCli = (args: string[]): { status: number; out: string } => {
    try {
      const out = execFileSync('npx', ['tsx', cli, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
      return { status: 0, out };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return { status: failure.status ?? 1, out: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
    }
  };
  const missing = runCli(['--repo', process.cwd()]);
  assert.equal(missing.status, 2);
  assert.match(missing.out, /--since is required/);
  const notRepo = runCli(['--repo', path.join(root, 'plain-'), '--since', '2026-01-01']);
  assert.equal(notRepo.status, 2);
});
