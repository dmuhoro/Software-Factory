/**
 * The remote control plane: submitting and watching loop runs over HTTP.
 *
 * Before sprint 24 the loop driver was reachable only from its CLI (`scripts/run-factory-loop.ts`).
 * These cases drive the real driver through the new authenticated surface and assert on the run
 * that actually lands in the ledger and in git -- not on what the service says it did.
 *
 * The final cases boot the real API router and speak HTTP to it, so the 401-before-credential and
 * the tenant scoping are exercised through the same middleware the deployed service uses.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import express from 'express';

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-loop-control-'));
const workspace = fs.mkdtempSync(path.join(state, 'ws-'));
process.env.FACTORY_DATA_DIR = path.join(state, 'data');
process.env.FACTORY_WORKSPACE_ROOT = workspace;
process.env.NODE_ENV = 'test';
process.env.FACTORY_API_KEY = 'test-platform-key-0123456789abcdef';
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });

const { DurableStore } = await import('../src/services/durableStore');
const { LoopControlService } = await import('../src/services/loopControlService');
const { GoalIntakeService } = await import('../src/services/goalIntakeService');
const { parseTaskDocument } = await import('../src/services/taskDocumentService');
const { FrontierModelService } = await import('../src/services/frontierModelService');
const { TenantService } = await import('../src/services/tenantService');
const { resetRateLimiterForTests } = await import('../src/api/middleware/rateLimiter');
const { apiRouter } = await import('../src/api');
const { IndustryNiche, TenantStatus, TenantSubscriptionTier } = await import('../src/models/tenant');

DurableStore.resetForTests();

const TENANT = 'loop-control-tenant';
const OTHER = 'loop-control-other';
const GOAL_TENANT = 'loop-control-goal-tenant';

// ── fixtures ───────────────────────────────────────────────────────────────

type Reply = { files: Array<{ path: string; content: string }>; notes?: string };
type ReviewReply = { approved: boolean; findings: string[] };
const REVIEW_MARKER = 'You are the reviewer for an unattended software delivery loop.';

async function startStub(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const parsed = JSON.parse(body || '{}') as { messages?: Array<{ content?: string }> };
      const prompt = (parsed.messages ?? []).map((message) => message.content ?? '').join('\n');
      const reply: Reply | ReviewReply = prompt.includes(REVIEW_MARKER)
        ? { approved: true, findings: [] }
        : { files: [{ path: 'feature.txt', content: 'alpha\n' }], notes: 'wrote the feature' };
      const content = ['```json', JSON.stringify(reply), '```'].join('\n');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/v1`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function withStub<T>(body: (url: string) => Promise<T>): Promise<T> {
  const stub = await startStub();
  FrontierModelService.register({ tenantId: TENANT, id: 'stub', kind: 'local', baseUrl: stub.url, modelIds: ['stub-code'] });
  FrontierModelService.register({ tenantId: OTHER, id: 'stub', kind: 'local', baseUrl: stub.url, modelIds: ['stub-code'] });
  try {
    return await body(stub.url);
  } finally {
    await stub.close();
  }
}

function writeTaskFor(name: string, checkPath: string): string {
  const file = path.join(workspace, `${name}-task.md`);
  fs.writeFileSync(file, [
    '# Task: Ship the feature',
    '',
    '## Goal',
    'Commit one verified feature without an operator present.',
    '',
    '## Constraints',
    '- No new dependencies',
    '',
    '## Models',
    'models.implementer: stub/stub-code',
    'models.reviewer: stub/stub-code',
    '',
    '## Milestones',
    '### M1: Feature alpha',
    'type: feat',
    `verify: node ${checkPath}`,
    '- [ ] feature.txt exists and contains alpha',
    '',
  ].join('\n'), 'utf8');
  return file;
}

function cleanRepo(name: string, checkBody: string): { repo: string; task: string } {
  const root = fs.mkdtempSync(path.join(workspace, `${name}-`));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  const check = path.join(root, 'check.cjs');
  fs.writeFileSync(check, checkBody);
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'initial']);
  return { repo: root, task: writeTaskFor(name, check) };
}

const CHECK = [
  "const fs = require('node:fs');",
  "const ok = fs.existsSync('feature.txt') && fs.readFileSync('feature.txt', 'utf8').includes('alpha');",
  "if (!ok) { console.error('missing alpha'); process.exit(1); }",
  "console.log('ok');",
].join('\n');

// ── the service ────────────────────────────────────────────────────────────

test('submit refuses a repository outside the approved workspace', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-beyond-ws-'));
  execFileSync('git', ['init', '-q', outside]);
  await assert.rejects(
    () => LoopControlService.submit({ tenantId: TENANT, repo: outside, taskDocument: path.join(outside, 'x.md') }),
    /LOOP_REPO_OUTSIDE_WORKSPACE/,
  );
});

test('submit refuses a path that is not a git repository', async () => {
  const plain = fs.mkdtempSync(path.join(workspace, 'plain-'));
  const other = cleanRepo('notgit', CHECK);
  await assert.rejects(
    () => LoopControlService.submit({ tenantId: TENANT, repo: plain, taskDocument: other.task }),
    /LOOP_REPO_NOT_GIT/,
  );
});

test('a submitted run drives the real loop to completion and is scoped to its tenant', async () => {
  const { repo, task } = cleanRepo('happy', CHECK);
  await withStub(async () => {
    const submitted = await LoopControlService.submit({ tenantId: TENANT, repo, taskDocument: task });
    assert.match(submitted.runId, /^looprun_/);
    const settled = LoopControlService.whenSettled(submitted.runId);
    assert.ok(settled, 'a run this process started must be awaitable');
    const outcome = await settled;

    assert.equal(outcome.record.status, 'completed', `run did not complete: ${outcome.record.hardStop ?? outcome.record.refusal ?? ''}`);
    assert.equal(outcome.record.units[0].status, 'done');
    assert.equal(outcome.record.commits.length, 1);
    assert.match(execFileSync('git', ['-C', repo, 'log', '--pretty=%s'], { encoding: 'utf8' }), /feat\(m1\): feature-alpha/);

    // The record is durable and tenant-scoped: the owner sees it, anyone else gets a miss.
    assert.ok(LoopControlService.get(TENANT, submitted.runId));
    assert.equal(LoopControlService.get(OTHER, submitted.runId), undefined, 'a foreign tenant saw another tenant run');
    assert.ok(LoopControlService.summaries(TENANT).some((run) => run.runId === submitted.runId));
    assert.equal(LoopControlService.summaries(OTHER).some((run) => run.runId === submitted.runId), false);
    assert.equal(LoopControlService.isActive(submitted.runId), false, 'a settled run must not still read as active');
  });
});

test('a second submission for a repository with a live run is refused', async () => {
  const { repo, task } = cleanRepo('busy', CHECK);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  // A provider that blocks until we release it keeps the first run alive.
  const blocking = http.createServer((request, response) => {
    request.on('data', () => {});
    request.on('end', () => { void hold.then(() => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content: '```json\n{"files":[]}\n```' } }] })); }); });
  });
  await new Promise<void>((resolve) => blocking.listen(0, '127.0.0.1', resolve));
  const address = blocking.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  FrontierModelService.register({ tenantId: TENANT, id: 'blocking', kind: 'local', baseUrl: `http://127.0.0.1:${port}/v1`, modelIds: ['stub-code'] });
  try {
    const first = await LoopControlService.submit({ tenantId: TENANT, repo, taskDocument: task, attemptCap: 1 });
    await assert.rejects(
      () => LoopControlService.submit({ tenantId: TENANT, repo, taskDocument: task }),
      /LOOP_RUN_ALREADY_ACTIVE/,
    );
    release();
    await LoopControlService.whenSettled(first.runId);
  } finally {
    await new Promise<void>((resolve) => blocking.close(() => resolve()));
  }
});

// ── the HTTP surface ───────────────────────────────────────────────────────

// ── goal intake ────────────────────────────────────────────────────────────

const ARCHITECT_MARKER = 'You are the architect for an unattended software delivery loop.';

function validDoc(providerId: string, verify: string): string {
  return [
    '# Task: Add the feature',
    '',
    '## Goal',
    'Ship the alpha feature and prove it with a command.',
    '',
    '## Constraints',
    '- Offline only',
    '',
    '## Models',
    `models.implementer: ${providerId}/stub-code`,
    `models.reviewer: ${providerId}/stub-code`,
    '',
    '## Milestones',
    '### M1: Feature alpha',
    'type: feat',
    `verify: ${verify}`,
    '- [ ] feature.txt exists and contains alpha',
    '',
  ].join('\n');
}

/** A provider that answers the architect with a document, the reviewer with approval, else a manifest. */
async function withPipelineStub<T>(doc: string, body: (providerId: string) => Promise<T>, tenantId: string = TENANT): Promise<T> {
  const server = http.createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      const parsed = JSON.parse(raw || '{}') as { messages?: Array<{ content?: string }> };
      const prompt = (parsed.messages ?? []).map((message) => message.content ?? '').join('\n');
      const content = prompt.includes(ARCHITECT_MARKER)
        ? doc
        : prompt.includes(REVIEW_MARKER)
          ? '```json\n{"approved":true,"findings":[]}\n```'
          : '```json\n{"files":[{"path":"feature.txt","content":"alpha\\n"}],"notes":"wrote it"}\n```';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  FrontierModelService.register({ tenantId, id: 'architect', kind: 'local', baseUrl: `http://127.0.0.1:${port}/v1`, modelIds: ['stub-code'] });
  try {
    return await body('architect');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('goal intake refuses an empty goal', async () => {
  await assert.rejects(() => GoalIntakeService.draft({ tenantId: TENANT, repo: 'x', goal: '   ', providerId: 'p', model: 'm' }), /LOOP_GOAL_REQUIRED/);
  await assert.rejects(() => GoalIntakeService.draft({ tenantId: TENANT, repo: 'x', goal: 'ship it', providerId: '', model: '' }), /LOOP_GOAL_MODEL_REQUIRED/);
});

test('goal intake refuses a draft the loop parser would reject', async () => {
  const { repo } = cleanRepo('goalbaddraft', CHECK);
  await withPipelineStub('not a task document at all\n', async (providerId) => {
    await assert.rejects(
      () => GoalIntakeService.draft({ tenantId: TENANT, repo, goal: 'ship it', providerId, model: 'stub-code' }),
      /LOOP_GOAL_DRAFT_INVALID/,
    );
  });
});

test('a drafted goal round-trips: the parser accepts it and the loop runs it to completion', async () => {
  const { repo } = cleanRepo('goalhappy', CHECK);
  const verify = `node ${path.join(repo, 'check.cjs')}`;
  await withPipelineStub(validDoc('architect', verify), async (providerId) => {
    const draft = await GoalIntakeService.draft({ tenantId: TENANT, repo, goal: 'add the alpha feature', providerId, model: 'stub-code' });
    assert.ok(fs.existsSync(draft.taskDocument), 'the draft was not written to disk');
    const root = process.env.FACTORY_WORKSPACE_ROOT as string;
    assert.ok(draft.taskDocument === root || draft.taskDocument.startsWith(root + path.sep), 'the draft was written outside the approved workspace');
    assert.equal(parseTaskDocument(fs.readFileSync(draft.taskDocument, 'utf8')).milestones[0].id, 'M1');

    // The drafted document is submitted unchanged and the loop runs it to a real commit.
    const submitted = await LoopControlService.submit({ tenantId: TENANT, repo, taskDocument: draft.taskDocument });
    const outcome = await LoopControlService.whenSettled(submitted.runId);
    assert.ok(outcome);
    assert.equal(outcome.record.status, 'completed', `goal run did not complete: ${outcome.record.hardStop ?? outcome.record.refusal ?? ''}`);
    assert.equal(outcome.record.commits.length, 1, 'the goal produced exactly one verified commit');
  });
});

async function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test('the loop API is 401 without a credential and tenant-scoped with one', async () => {
  TenantService.registerTenant({
    id: TENANT, name: 'Loop control tenant', niche: IndustryNiche.CUSTOM_B2B,
    tier: TenantSubscriptionTier.PROFESSIONAL, status: TenantStatus.ACTIVE, apiKeyHash: '',
    quota: { maxRequestsPerMinute: 10_000, maxDailyAiTokens: 10_000_000, burstCapacity: 100, storageLimitMb: 1000 },
    customGuardrails: [], encryptionKeyId: 'test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  TenantService.registerTenant({
    id: OTHER, name: 'Loop control other', niche: IndustryNiche.CUSTOM_B2B,
    tier: TenantSubscriptionTier.PROFESSIONAL, status: TenantStatus.ACTIVE, apiKeyHash: '',
    quota: { maxRequestsPerMinute: 10_000, maxDailyAiTokens: 10_000_000, burstCapacity: 100, storageLimitMb: 1000 },
    customGuardrails: [], encryptionKeyId: 'test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const owner = await TenantService.provisionCredential(TENANT);
  const other = await TenantService.provisionCredential(OTHER);
  resetRateLimiterForTests();

  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = await listen(app);

  try {
    const { repo, task } = cleanRepo('http', CHECK);
    const body = JSON.stringify({ tenantId: TENANT, repo, taskDocument: task });

    const anonymous = await fetch(`${server.url}/api/loop/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(anonymous.status, 401, 'an unauthenticated submission must be refused before it can start work');

    const foreign = await fetch(`${server.url}/api/loop/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': other.apiKey },
      body,
    });
    assert.equal(foreign.status, 403, 'a credential may not act for another tenant');

    let runId: string;
    await withStub(async () => {
      const accepted = await fetch(`${server.url}/api/loop/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': owner.apiKey },
        body,
      });
      if (accepted.status !== 202) assert.fail(`expected 202, got ${accepted.status}: ${await accepted.text()}`);
      const acceptedBody = await accepted.json() as { runId: string };
      runId = acceptedBody.runId;
      assert.match(runId, /^looprun_/);

      const list = await fetch(`${server.url}/api/loop/runs?tenantId=${TENANT}`, { headers: { 'x-api-key': owner.apiKey } });
      assert.equal(list.status, 200);
      const listed = await list.json() as { runs: Array<{ runId: string }> };
      assert.ok(listed.runs.some((run) => run.runId === runId), 'the accepted run did not appear in the tenant list');

      const fetched = await fetch(`${server.url}/api/loop/runs/${runId}?tenantId=${TENANT}`, { headers: { 'x-api-key': owner.apiKey } });
      assert.equal(fetched.status, 200);

      const cross = await fetch(`${server.url}/api/loop/runs/${runId}?tenantId=${OTHER}`, { headers: { 'x-api-key': other.apiKey } });
      assert.equal(cross.status, 404, 'a foreign tenant must see a miss, not the run');

      // Watch the live stream to its terminal event.
      const stream = await fetch(`${server.url}/api/loop/runs/${runId}/events?tenantId=${TENANT}`, { headers: { 'x-api-key': owner.apiKey } });
      assert.equal(stream.status, 200);
      assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/);
      const text = await readUntilDone(stream);
      assert.match(text, /"stage":"run"/, 'the stream carried no events');
      assert.match(text, /event: done/, 'the stream did not terminate with a done event');
      assert.match(text, /"status":"completed"/, 'the run did not complete');
    });
  } finally {
    await server.close();
  }
});

test('goal intake over HTTP is 401 without a credential and 201 with one', async () => {
  TenantService.registerTenant({
    id: GOAL_TENANT, name: 'Goal intake tenant', niche: IndustryNiche.CUSTOM_B2B,
    tier: TenantSubscriptionTier.PROFESSIONAL, status: TenantStatus.ACTIVE, apiKeyHash: '',
    quota: { maxRequestsPerMinute: 10_000, maxDailyAiTokens: 10_000_000, burstCapacity: 100, storageLimitMb: 1000 },
    customGuardrails: [], encryptionKeyId: 'test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const owner = await TenantService.provisionCredential(GOAL_TENANT);
  resetRateLimiterForTests();
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = await listen(app);
  try {
    const { repo } = cleanRepo('goalhttp', CHECK);
    const verify = `node ${path.join(repo, 'check.cjs')}`;
    await withPipelineStub(validDoc('architect', verify), async (providerId) => {
      const payload = JSON.stringify({ tenantId: GOAL_TENANT, repo, goal: 'add the alpha feature', providerId, model: 'stub-code' });
      const anonymous = await fetch(`${server.url}/api/loop/goals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
      assert.equal(anonymous.status, 401, 'goal drafting must require a credential');
      const created = await fetch(`${server.url}/api/loop/goals`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': owner.apiKey }, body: payload,
      });
      assert.equal(created.status, 201, `expected 201, got ${created.status}`);
      const body = await created.json() as { taskDocument: string; milestones: Array<{ id: string }> };
      assert.equal(body.milestones[0].id, 'M1');
      assert.ok(fs.existsSync(body.taskDocument), 'the response named a draft that does not exist');
    }, GOAL_TENANT);
  } finally {
    await server.close();
  }
});

async function readUntilDone(response: Response, timeoutMs = 60_000): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (text.includes('event: done')) { await reader.cancel().catch(() => {}); return text; }
    if (Date.now() > deadline) { await reader.cancel().catch(() => {}); throw new Error(`timed out waiting for the run to finish; saw:\n${text}`); }
    const { value, done } = await reader.read();
    if (done) return text;
    text += decoder.decode(value, { stream: true });
  }
}

