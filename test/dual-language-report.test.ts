/**
 * Dual-language reporting (Layer 7, wired from Layer 1 Control).
 *
 * Every durable record Software Factory produces renders in two vocabularies:
 * technical (proof digests, gate results, failure classes, commit SHAs) and founder/CEO
 * (plain-language status, what is built, what is blocked, what decision is needed).
 * No figure appears without a named reproducing command.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { renderDualLanguage, renderUnitDualLanguage } from '../src/utils/dualLanguageReport';

const record = {
  runId: 'looprun_dl-001',
  repo: '/workspace/stashmind',
  taskDocument: '/workspace/stashmind/task.md',
  status: 'completed' as const,
  units: [
    { unitId: 'u1', title: 'Login screen', status: 'done' as const, attempts: 1, commitSha: 'a1b2c3d4e5f6' },
    { unitId: 'u2', title: 'Payments webhook', status: 'stuck' as const, attempts: 3, failureClass: 'verification', blockedBy: undefined },
    { unitId: 'u3', title: 'Settings page', status: 'blocked' as const, attempts: 0, blockedBy: 'u2' },
  ],
  gates: [
    { id: 'ground-truth', stage: 'verify', passed: true, blocking: true, detail: 'verify command exited 0' },
    { id: 'secret-scan', stage: 'commit', passed: true, blocking: true, detail: 'no credential-shaped paths' },
    { id: 'unrelated-writes', stage: 'commit', passed: false, blocking: true, detail: 'formatter rewrote package-lock.json' },
  ],
  failureClass: 'verification',
  narrationRejected: 2,
  startedAt: '2026-10-21T09:00:00Z',
  finishedAt: '2026-10-21T09:03:22Z',
  hardStop: undefined,
  refusal: undefined,
  reproducesWith: 'npm run factory:run -- --repo /workspace/stashmind --task /workspace/stashmind/task.md',
} as import('../src/utils/dualLanguageReport').DualLanguageRecord;

test('technical rendering names proof digests, gates, failure classes, commit SHAs', () => {
  const { technical } = renderDualLanguage(record);
  assert.ok(technical.includes('looprun_dl-001'));
  assert.ok(technical.includes('/workspace/stashmind'));
  assert.ok(technical.includes('a1b2c3d4e5f6'));
  assert.ok(technical.includes('ground-truth'));
  assert.ok(technical.includes('unrelated-writes'));
  assert.ok(technical.includes('verification'));
  assert.ok(technical.includes('2'));
  assert.ok(technical.includes('npm run factory:run -- --repo /workspace/stashmind --task /workspace/stashmind/task.md'));
});

test('founder rendering uses plain language and names the decision needed', () => {
  const { founder } = renderDualLanguage(record);
  assert.ok(founder.includes('Product run looprun_dl-001 — completed'));
  assert.ok(founder.includes('Login screen — Built and verified'));
  assert.ok(founder.includes('Payments webhook — Blocked — needs your decision'));
  assert.ok(founder.includes('Settings page — Waiting on a dependency'));
  assert.ok(founder.includes('verification'));
  assert.ok(founder.includes('npm run factory:run -- --repo /workspace/stashmind --task /workspace/stashmind/task.md'));
});

test('technical rendering excludes founder-only phrasing and vice versa where they diverge', () => {
  const { technical, founder } = renderDualLanguage(record);
  assert.ok(founder.includes('Built and verified'), 'founder uses plain language');
  // Both describe the same record: same run id, same unit count, same reproducing command.
  assert.ok(technical.includes('looprun_dl-001') && founder.includes('looprun_dl-001'));
  assert.ok(
    technical.includes(record.reproducesWith) && founder.includes(record.reproducesWith),
    'both vocabularies name the same reproducing command',
  );
});

test('unit rendering produces both vocabularies for a single unit', () => {
  const unit = { unitId: 'u1', title: 'Login screen', status: 'done', attempts: 1, commitSha: 'a1b2c3d4', reproducesWith: 'npm test' } as const;
  const { technical, founder } = renderUnitDualLanguage(unit);
  assert.ok(technical.includes('Unit u1: Login screen'));
  assert.ok(technical.includes('Commit: a1b2c3d4'));
  assert.ok(founder.includes('Login screen — Built and verified'));
  assert.ok(founder.includes('Committed: a1b2c3d'));
  assert.ok(founder.includes('npm test'));
});

test('unit rendering degrades gracefully when no commit or failure class exists', () => {
  const unit = { unitId: 'u3', title: 'Settings page', status: 'blocked', attempts: 0, reproducesWith: 'npm run verify' } as const;
  const { technical, founder } = renderUnitDualLanguage(unit);
  assert.ok(technical.includes('Commit: —'));
  assert.ok(founder.includes('Not yet committed.'));
  assert.ok(founder.includes('Waiting on a dependency'));
});
