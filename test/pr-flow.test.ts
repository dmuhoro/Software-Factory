/**
 * The pull-request flow adapter (sprint 28, WP-4).
 *
 * A finished run must leave a reviewable, worded change set behind instead of silence. This case
 * drives the real `prFlowService` against a real git repository: the local default drafts a durable
 * record, a rendered manifest whose every fact comes from the run, and a branch ref that points at
 * the run head. The GitHub half is the guarded path — with no allowlisted token it must refuse
 * *before* any socket, so no credential-less call can ever reach the network.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import type { LoopRunRecord } from '../src/services/loopTypes';

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-pr-'));
process.env.FACTORY_DATA_DIR = path.join(state, 'data');
process.env.FACTORY_WORKSPACE_ROOT = path.join(state, 'ws');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.FACTORY_WORKSPACE_ROOT, { recursive: true });

const { DurableStore } = await import('../src/services/durableStore');
const { prFlowService } = await import('../src/services/prFlowService');

DurableStore.resetForTests();

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function makeRepo(name: string): { repo: string; head: string } {
  const repo = fs.mkdtempSync(path.join(state, name));
  execFileSync('git', ['init', '-q', repo]);
  git(repo, ['config', 'user.name', 'test']);
  git(repo, ['config', 'user.email', 'test@test.local']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'init']);
  return { repo, head: git(repo, ['rev-parse', 'HEAD']) };
}

function makeRun(tenantId: string, runId: string, repo: string, head: string): LoopRunRecord {
  const now = new Date().toISOString();
  return {
    runId,
    status: 'completed',
    startedAt: now,
    finishedAt: now,
    repo,
    taskDocument: path.join(repo, 'task.md'),
    taskDocumentHash: 'hash',
    doctrineDigest: 'digest',
    execution: 'sequential',
    attemptCap: 1,
    tenantId,
    quarantineCount: 0,
    units: [
      {
        unitId: 'M1',
        milestoneId: 'm1',
        title: 'first unit',
        type: 'code',
        criteria: [{ id: 'c1', text: 'does the thing' }],
        dependsOn: [],
        status: 'done',
        attempts: [
          {
            attempt: 1,
            startedAt: now,
            finishedAt: now,
            stage: 'commit',
            passed: true,
            reason: 'ok',
            detail: 'ok',
            review: { approved: true, findings: [], reviewer: 'stub' },
          },
        ],
        commitSha: head,
        commitSubject: 'init',
      },
    ],
    commits: [{ unitId: 'M1', sha: head, subject: 'init' }],
    gates: [],
    events: [],
    models: [],
    narrationRejected: 0,
  };
}

test('local draft writes a durable record, a branch ref at HEAD, and a truthful manifest', () => {
  const { repo, head } = makeRepo('repo-local');
  const runId = 'looprun_local_0001';
  const run = makeRun('tenant-local', runId, repo, head);

  const pr = prFlowService.draft({ tenantId: 'tenant-local', run, repo });

  assert.equal(pr.status, 'DRAFTED');
  assert.equal(pr.flow, 'local');
  assert.equal(pr.sourceSha, head);
  assert.equal(pr.branch, prFlowService.prBranch(runId));
  assert.equal(pr.commitCount, 1);
  assert.equal(pr.mergeable, true);
  assert.match(pr.body, new RegExp(runId));
  assert.match(pr.body, /## Units/);
  assert.match(pr.body, /## Commits/);
  assert.match(pr.body, /## Merges/);

  // The branch ref is real and points at the run head.
  assert.equal(git(repo, ['rev-parse', pr.branch]), head);

  // The record is durable, not merely returned.
  const stored = prFlowService.getRecord('tenant-local', runId);
  assert.ok(stored);
  assert.equal(stored.id, pr.id);
});

test('a run that is not fully done is not advertised as mergeable', () => {
  const { repo, head } = makeRepo('repo-notdone');
  const runId = 'looprun_notdone_0001';
  const run = makeRun('tenant-notdone', runId, repo, head);
  run.status = 'halted';
  run.units[0].status = 'stuck';

  const verdict = prFlowService.mergeable(run);
  assert.equal(verdict.mergeable, false);
  assert.match(String(verdict.reason), /halted/);
});

test('opening a GitHub pull request with no allowlisted token refuses before any socket', async () => {
  const { repo, head } = makeRepo('repo-github');
  const runId = 'looprun_github_0001';
  const run = makeRun('tenant-github', runId, repo, head);

  const pr = prFlowService.draft({ tenantId: 'tenant-github', run, repo, mode: 'github' });

  let threw = false;
  let code = '';
  try {
    await prFlowService.openGithub({
      tenantId: 'tenant-github',
      run,
      repo,
      mode: 'github',
      owner: 'owner',
      repoName: 'repo',
      head: pr.branch,
      tokenSecretRef: '',
    });
  } catch (error) {
    threw = true;
    code = (error as Error).message.split(':')[0];
  }
  assert.ok(threw, 'openGithub must refuse without a token');
  assert.equal(code, 'PR_GITHUB_TOKEN_REQUIRED');
});
