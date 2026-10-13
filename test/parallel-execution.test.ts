/**
 * The worktree-parallel driver (sprint 28, WP-3): independent units run at once, a dependent
 * unit waits, and the merged line only ever carries verified, reviewed, committed work.
 *
 * This is the same `ExecutionLoopService.run` the CLI uses, driven against real git repositories
 * under a doctrine whose `execution` is `worktree-parallel`. Nothing here reaches a helper only
 * tests use: the run creates real worktrees, real branches, and real `--no-ff` merges; the model
 * is a stub HTTP port whose only job is to act as a barrier and prove overlap.
 *
 * The three properties this layer promises, each worth its own case:
 *  1. two independent units genuinely run at once (the stub sees two implementer calls in flight
 *     together) and a dependent unit does not start until its dependency is *merged*;
 *  2. a unit whose verification fails never reaches the target branch — the worktree stays a
 *     branch, the run reports the unit stuck, and nothing silently half-ships;
 *  3. a merge git cannot resolve is never auto-resolved: the run halts, the target branch stays
 *     at the last good merge, and the conflict is named.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-parallel-'));
process.env.FACTORY_DATA_DIR = path.join(state, 'data');
process.env.FACTORY_WORKSPACE_ROOT = path.join(state, 'ws');
process.env.FACTORY_WORKTREE_ROOT = path.join(state, 'worktrees');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.FACTORY_WORKSPACE_ROOT, { recursive: true });
fs.mkdirSync(process.env.FACTORY_WORKTREE_ROOT, { recursive: true });

const { DurableStore } = await import('../src/services/durableStore');
const { ExecutionLoopService } = await import('../src/services/executionLoopService');
const { FrontierModelService } = await import('../src/services/frontierModelService');
const { DoctrineService } = await import('../src/services/doctrineService');

DurableStore.resetForTests();

const TENANT = 'parallel-tenant';
const DOCTRINE_SRC = path.resolve(import.meta.dirname ?? __dirname, '..', 'doctrine');

// ── fixtures ───────────────────────────────────────────────────────────────

function checkFor(feature: string, needle: string): string {
  return `const fs = require('node:fs');
const ok = fs.existsSync('${feature}') && fs.readFileSync('${feature}', 'utf8').includes('${needle}');
if (!ok) { console.error('${feature} is missing or wrong'); process.exit(1); }
console.log('${feature} passed');
`;
}

function makeTarget(name: string, extraChecks = true): string {
  const root = fs.mkdtempSync(path.join(state, `repo-${name}-`));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'loop@example.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Loop Fixture']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  if (extraChecks) {
    fs.writeFileSync(path.join(root, 'check-a.cjs'), checkFor('feature-a.txt', 'alpha'));
    fs.writeFileSync(path.join(root, 'check-b.cjs'), checkFor('feature-b.txt', 'beta'));
    fs.writeFileSync(path.join(root, 'check-c.cjs'), checkFor('feature-c.txt', 'charlie'));
  } else {
    fs.writeFileSync(path.join(root, 'check-fail.cjs'), "console.error('always refuses'); process.exit(1);\n");
  }
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'initial']);
  return root;
}

function writeTask(name: string, milestones: string): string {
  const file = path.join(state, `${name}-task.md`);
  fs.writeFileSync(file, [
    '# Task: Ship the features',
    '',
    '## Goal',
    'Commit several independently verified features without an operator present.',
    '',
    '## Constraints',
    '- No new dependencies',
    '',
    '## Models',
    'models.implementer: stub/stub-code',
    'models.reviewer: stub/stub-code',
    '',
    '## Milestones',
    milestones,
    '',
  ].join('\n'), 'utf8');
  return file;
}

const MILESTONES_ABC = [
  '### M1: Feature alpha',
  'type: feat',
  'verify: node check-a.cjs',
  '- [ ] feature-a.txt exists and contains alpha',
  '',
  '### M2: Feature beta',
  'depends: M1',
  'type: feat',
  'verify: node check-b.cjs',
  '- [ ] feature-b.txt exists and contains beta',
  '',
  '### M3: Feature charlie',
  'type: feat',
  'verify: node check-c.cjs',
  '- [ ] feature-c.txt exists and contains charlie',
  '',
].join('\n');

function gitLines(repo: string, args: string[]): string[] {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
}

function porcelain(repo: string): string {
  return execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
}

function commitBody(repo: string, sha: string): string {
  return execFileSync('git', ['-C', repo, 'show', '-s', '--format=%B', sha], { encoding: 'utf8' });
}

// ── a private doctrine copy whose manifest stays pinned ────────────────────

const COVERED = ['README.md', 'DOCTRINE.md', 'loop.json', 'agents/models.json', 'rules/rules.json', 'hooks/hooks.json'].sort();

function doctrineCopy(name: string, mutate: (root: string) => void): string {
  const root = path.join(state, `doctrine-${name}`);
  fs.cpSync(DOCTRINE_SRC, root, { recursive: true });
  mutate(root);
  const files: Record<string, string> = {};
  for (const rel of COVERED) {
    files[rel] = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex')}`;
  }
  fs.writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify({ version: 1, files }, null, 2)}\n`, 'utf8');
  return root;
}

const PARALLEL_DOCTRINE = doctrineCopy('parallel', (root) => {
  const file = path.join(root, 'loop.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8')) as { concurrency: Record<string, unknown> };
  config.concurrency.execution = 'worktree-parallel';
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
});

async function withParallelDoctrine<T>(body: () => Promise<T>): Promise<T> {
  const previous = process.env.FACTORY_DOCTRINE_ROOT;
  process.env.FACTORY_DOCTRINE_ROOT = PARALLEL_DOCTRINE;
  DoctrineService.clearCache();
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.FACTORY_DOCTRINE_ROOT;
    else process.env.FACTORY_DOCTRINE_ROOT = previous;
    DoctrineService.clearCache();
  }
}

// ── the model port: a barrier that proves two units are airborne together ──

const REVIEW_MARKER = 'You are the reviewer for an unattended software delivery loop.';

interface BarrierStub {
  url: string;
  maxConcurrentImplementer: () => number;
  prompts: string[];
  close: () => Promise<void>;
}

const FILES: Record<string, Array<{ path: string; content: string }>> = {
  M1: [{ path: 'feature-a.txt', content: 'alpha\n' }],
  M2: [{ path: 'feature-b.txt', content: 'beta\n' }],
  M3: [{ path: 'feature-c.txt', content: 'charlie\n' }],
};

async function startBarrierStub(files: (unit: string) => Array<{ path: string; content: string }> = (unit) => FILES[unit] ?? FILES.M1): Promise<BarrierStub> {
  const prompts: string[] = [];
  let implementerInFlight = 0;
  let maxImplementerInFlight = 0;
  let held: Array<{ prompt: string; reply: (files: Array<{ path: string; content: string }>) => void }> = [];

  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}') as { messages?: Array<{ content?: string }> };
        const prompt = (parsed.messages ?? []).map((message) => message.content ?? '').join('\n');
        prompts.push(prompt);
        const write = (content: string): void => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ choices: [{ message: { content } }] }));
        };
        if (prompt.includes(REVIEW_MARKER)) {
          write(['```json', JSON.stringify({ approved: true, findings: [] }), '```'].join('\n'));
          return;
        }
        implementerInFlight += 1;
        maxImplementerInFlight = Math.max(maxImplementerInFlight, implementerInFlight);
        const unit = /Unit: (M\d)/.exec(prompt)?.[1] ?? 'M1';
        held.push({ prompt, reply: (files) => write(['```json', JSON.stringify({ files, notes: unit }), '```'].join('\n')) });
        // Release the first pair together so the two independent units provably overlap; hold
        // until two are airborne. Any later, lone implementer call is released straight away,
        // because by then the barrier already witnessed the overlap.
        if (maxImplementerInFlight >= 2 || held.length >= 2) {
          const batch = held;
          held = [];
          implementerInFlight = Math.max(0, implementerInFlight - batch.length);
          for (const item of batch) item.reply(files(/Unit: (M\d)/.exec(item.prompt)?.[1] as string));
        }
      } catch (error) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: String(error) }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    maxConcurrentImplementer: () => maxImplementerInFlight,
    prompts,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function withBarrierStub<T>(
  files: ((unit: string) => Array<{ path: string; content: string }>) | undefined,
  body: (stub: BarrierStub) => Promise<T>,
): Promise<T> {
  const stub = await startBarrierStub(files);
  FrontierModelService.register({ tenantId: TENANT, id: 'stub', kind: 'local', baseUrl: stub.url, modelIds: ['stub-code'] });
  try {
    return await body(stub);
  } finally {
    await stub.close();
  }
}

// ── the proofs ─────────────────────────────────────────────────────────────

test('two independent units run at once and a dependent unit waits for the merged dependency', async () => {
  const repo = makeTarget('concurrent');
  const task = writeTask('concurrent', MILESTONES_ABC);

  await withParallelDoctrine(async () => {
    await withBarrierStub(undefined, async (stub) => {
      const outcome = await ExecutionLoopService.run({ repo, taskDocument: task, tenantId: TENANT });
      const { record } = outcome;

      assert.equal(outcome.exitCode, 0, `expected a clean run, got ${outcome.exitCode}: ${record.hardStop ?? record.refusal ?? ''}`);
      assert.equal(record.status, 'completed');
      assert.equal(record.execution, 'worktree-parallel');
      assert.deepEqual(record.units.map((unit) => unit.status), ['done', 'done', 'done']);
      assert.equal(record.commits.length, 3, 'one feature commit per worktree branch');
      assert.equal(record.merges?.length, 3, 'every worktree was folded onto the target branch');

      // Property 1a: two units were genuinely in flight at the same time, not serialized.
      assert.ok(stub.maxConcurrentImplementer() >= 2, `two independent units never overlapped (max in-flight ${stub.maxConcurrentImplementer()})`);

      // Property 1b: the dependent unit's first move came only after its dependency was merged.
      const m1Merge = record.events.findIndex((entry) => entry.message.includes('unit M1 merged onto'));
      const m2Start = record.events.findIndex((entry) => entry.message.startsWith('unit M2 attempt 1/'));
      assert.ok(m1Merge !== -1, 'no merge event for M1 was recorded');
      assert.ok(m2Start !== -1, 'M2 never started');
      assert.ok(m1Merge < m2Start, `M2 started (event ${m2Start}) before M1 was merged (event ${m1Merge})`);

      // The merged line carries every unit's evidence, exactly like a sequential commit.
      for (const commit of record.commits) {
        const body = commitBody(repo, commit.sha);
        assert.match(body, /Proof: sha256:/, `unit ${commit.unitId} commit lacks its Proof digest`);
        assert.match(body, /Verified: node check-[abc]\.cjs \(exit 0\)/, `unit ${commit.unitId} commit lacks its verify proof`);
        assert.match(body, /AI-Assisted:/, `unit ${commit.unitId} commit lacks its provenance footer`);
      }
      assert.equal(fs.readFileSync(path.join(repo, 'feature-a.txt'), 'utf8'), 'alpha\n');
      assert.equal(fs.readFileSync(path.join(repo, 'feature-b.txt'), 'utf8'), 'beta\n');
      assert.equal(fs.readFileSync(path.join(repo, 'feature-c.txt'), 'utf8'), 'charlie\n');
      assert.equal(porcelain(repo), '', 'worktrees left residue on the target branch');
    });
  });
});

test('a unit whose verification fails never merges; the run reports it stuck and the branch is kept', async () => {
  const repo = makeTarget('stuck', false);
  const task = writeTask('stuck', [
    '### M1: A feature that can never verify',
    'type: feat',
    'verify: node check-fail.cjs',
    '- [ ] the impossible file exists',
    '',
  ].join('\n'));

  await withParallelDoctrine(async () => {
    await withBarrierStub(undefined, async () => {
      const outcome = await ExecutionLoopService.run({ repo, taskDocument: task, tenantId: TENANT });
      const { record } = outcome;

      assert.equal(outcome.exitCode, 2, `expected a stuck run, got ${outcome.exitCode}`);
      assert.equal(record.status, 'completed', 'a stuck unit is reported, not a hard stop');
      assert.equal(record.units[0].status, 'stuck');
      assert.equal(record.units[0].attempts.length, 3, 'the unit used its full attempt cap');
      assert.equal(record.commits.length, 0, 'an unverified unit committed nowhere');
      assert.equal((record.merges ?? []).length, 0, 'an unverified unit merged nowhere');
      assert.equal(gitLines(repo, ['rev-list', '--count', 'HEAD'])[0], '1', 'the target branch moved');
      assert.equal(porcelain(repo), '', 'the failed attempt left residue');
      // The worktree branch is evidence, kept for the operator, not folded silently.
      assert.equal(gitLines(repo, ['branch', '--list', 'factory/*']).length, 1, 'the failed unit branch was discarded');
    });
  });
});

test('a merge the target cannot resolve halts the run and never auto-resolves', async () => {
  const repo = makeTarget('conflict');
  const milestones = [
    '### M1: Feature alpha',
    'type: feat',
    'verify: node check-a.cjs',
    '- [ ] feature-a.txt exists and contains alpha',
    '- [ ] the README says alpha first',
    '',
    '### M3: Feature charlie',
    'type: feat',
    'verify: node check-c.cjs',
    '- [ ] feature-c.txt exists and contains charlie',
    '- [ ] the README says charlie first',
    '',
  ].join('\n');
  const task = writeTask('conflict', milestones);

  await withParallelDoctrine(async () => {
    await withBarrierStub((unit) =>
      unit === 'M1'
        ? [{ path: 'feature-a.txt', content: 'alpha\n' }, { path: 'README.md', content: '# fixture\n- alpha first\n' }]
        : [{ path: 'feature-c.txt', content: 'charlie\n' }, { path: 'README.md', content: '# fixture\n- charlie first\n' }],
    async () => {
      // Both units touch README.md differently; whichever merges second cannot resolve by git.
      const out = await ExecutionLoopService.run({ repo, taskDocument: task, tenantId: TENANT });
      const { record } = out;

      assert.equal(out.exitCode, 3, `expected a halted run, got ${out.exitCode}`);
      assert.equal(record.status, 'halted');
      assert.match(record.hardStop ?? '', /merge-conflict/, `the conflict was not named: ${record.hardStop}`);
      assert.equal(record.merges?.length, 1, 'only the first unit reached the target branch');
      assert.equal(record.commits.length, 2, 'both units committed inside their own worktrees');
      const unmerged = record.units.filter((unit) => unit.mergeSha === undefined).length;
      assert.equal(unmerged, 1, 'one unit is undone only in the sense that its merge was refused');
      // The target branch is at the last good merge: base + the winner's feature commit + one
      // merge commit, and only the winner's files are reachable.
      assert.equal(gitLines(repo, ['rev-list', '--count', 'HEAD'])[0], '3', 'the failed merge contaminated the target branch');
      assert.equal(porcelain(repo), '', 'the failed merge left the target branch dirty');
      const mergedFeatures = ['feature-a.txt', 'feature-c.txt'].filter((file) => fs.existsSync(path.join(repo, file)));
      assert.equal(mergedFeatures.length, 1, `exactly one unit's work may reach the target branch, got ${mergedFeatures.join(', ')}`);
    });
  });
});

test('a worktree-parallel run cannot be resumed from a checkpoint', async () => {
  const repo = makeTarget('resume');
  const task = writeTask('resume', MILESTONES_ABC);

  await withParallelDoctrine(async () => {
    await withBarrierStub(undefined, async () => {
      const outcome = await ExecutionLoopService.run({ repo, taskDocument: task, tenantId: TENANT });
      assert.equal(outcome.exitCode, 0);

      // A real halt would leave the record ready to resume; this driver refuses honestly.
      const checkpointed = outcome.record;
      checkpointed.status = 'halted';
      checkpointed.hardStop = 'test: simulated interruption';
      DurableStore.upsert('factoryLoopRuns', checkpointed.runId, checkpointed as unknown as Record<string, unknown>);

      await assert.rejects(
        () => ExecutionLoopService.run({ repo, taskDocument: task, tenantId: TENANT, resumeRunId: checkpointed.runId }),
        /worktree-parallel runs cannot be resumed/,
      );
    });
  });
});