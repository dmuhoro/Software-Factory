/**
 * The interactive intake — the "grill session" (Sprint 33, WP-2).
 *
 * A grill session asks the operator one clarifying question at a time and, when the operator is
 * done answering, drafts a task document through the SAME parse-or-refuse path the goal and issue
 * bridges use. These cases pin the four things the sprint promised: the hard cap, tenant isolation,
 * durability across a restart, and a refused malformed draft. The question source is a scripted
 * asker (the service's test seam, mirroring `WebhookService.setTransportForTests`); the draft, for
 * the refusal case, is produced by the real `draftTaskDocument` against a loopback model stub.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import express from 'express';

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'grill-session-'));
process.env.FACTORY_DATA_DIR = path.join(state, 'data');
process.env.FACTORY_WORKSPACE_ROOT = path.join(state, 'ws');
process.env.NODE_ENV = 'test';
process.env.FACTORY_API_KEY = 'test-platform-key-0123456789abcdef';
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.FACTORY_WORKSPACE_ROOT, { recursive: true });

const { DurableStore } = await import('../src/services/durableStore');
const { GrillSessionService } = await import('../src/services/grillSessionService');
const { FrontierModelService } = await import('../src/services/frontierModelService');
const { TenantService } = await import('../src/services/tenantService');
const { resetRateLimiterForTests } = await import('../src/api/middleware/rateLimiter');
const { apiRouter } = await import('../src/api');
const { IndustryNiche, TenantStatus, TenantSubscriptionTier } = await import('../src/models/tenant');

DurableStore.resetForTests();

const ROOT = process.env.FACTORY_WORKSPACE_ROOT as string;
const TENANT = 'grill-a';
const OTHER = 'grill-b';

function cleanRepo(name: string): string {
  const repo = fs.mkdtempSync(path.join(ROOT, `${name}-`));
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', repo, 'config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'initial']);
  return repo;
}

function scripted(questions: string[]): import('../src/services/grillSessionService').GrillAsker {
  let index = 0;
  return async () => (index < questions.length ? { question: questions[index++], done: false } : { question: '', done: true });
}

interface Stub { url: string; close: () => Promise<void> }

async function startModelStub(content: string): Promise<Stub> {
  const server = http.createServer((request, response) => {
    request.on('data', () => {});
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/v1`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

// ── the hard cap ────────────────────────────────────────────────────────────

test('WP-2: the hard cap stops the session, however eager the asker', async () => {
  process.env.FACTORY_GRILL_MAX_QUESTIONS = '2';
  try {
    const repo = cleanRepo('cap');
    GrillSessionService.setAskerForTests(scripted(['q1', 'q2', 'q3', 'q4']));
    const started = await GrillSessionService.start({ tenantId: TENANT, repo, goal: 'Ship it', providerId: 'stub', model: 'stub-code' });
    assert.equal(started.cap, 2);
    assert.equal(started.question, 'q1');

    const first = await GrillSessionService.answer({ tenantId: TENANT, sessionId: started.sessionId, answer: 'one' });
    assert.equal(first.question, 'q2');
    assert.equal(first.done, false);

    const second = await GrillSessionService.answer({ tenantId: TENANT, sessionId: started.sessionId, answer: 'two' });
    assert.equal(second.done, true, 'the session must stop at the cap, not ask q3');

    const session = GrillSessionService.get(TENANT, started.sessionId);
    assert.equal(session?.turns.length, 2, 'exactly the cap number of questions were asked');
    assert.equal(session?.status, 'ready');
  } finally {
    delete process.env.FACTORY_GRILL_MAX_QUESTIONS;
  }
});

// ── tenant isolation ────────────────────────────────────────────────────────

test('WP-2: a session belongs to its tenant; a foreign id is a miss, not a leak', async () => {
  const repo = cleanRepo('isolation');
  GrillSessionService.setAskerForTests(scripted(['q1', 'q2']));
  const started = await GrillSessionService.start({ tenantId: TENANT, repo, goal: 'g', providerId: 'stub', model: 'stub-code' });

  assert.equal(GrillSessionService.get(OTHER, started.sessionId), undefined, 'another tenant must not read the session');
  await assert.rejects(
    () => GrillSessionService.answer({ tenantId: OTHER, sessionId: started.sessionId, answer: 'x' }),
    /LOOP_GRILL_NOT_FOUND/,
  );
  await assert.rejects(
    () => GrillSessionService.finish({ tenantId: OTHER, sessionId: started.sessionId }),
    /LOOP_GRILL_NOT_FOUND/,
  );
  assert.ok(GrillSessionService.get(TENANT, started.sessionId), 'the owner still sees it');
});

// ── durability across a restart ─────────────────────────────────────────────

test('WP-2: a session survives a restart and resumes where it stopped', async () => {
  const repo = cleanRepo('resume');
  GrillSessionService.setAskerForTests(scripted(['q1', 'q2']));
  const started = await GrillSessionService.start({ tenantId: TENANT, repo, goal: 'g', providerId: 'stub', model: 'stub-code' });
  const first = await GrillSessionService.answer({ tenantId: TENANT, sessionId: started.sessionId, answer: 'one' });
  assert.equal(first.question, 'q2');

  // Simulate a process restart: drop the in-memory ledger copy; the next read reloads from disk.
  DurableStore.resetForTests();

  const reloaded = GrillSessionService.get(TENANT, started.sessionId);
  assert.ok(reloaded, 'the session must reload from the durable ledger after a restart');
  assert.equal(reloaded.turns.length, 2);
  assert.equal(reloaded.turns[0].answer, 'one', 'the recorded answer survived');
  assert.equal(reloaded.turns[1].question, 'q2', 'the outstanding question survived');

  const second = await GrillSessionService.answer({ tenantId: TENANT, sessionId: started.sessionId, answer: 'two' });
  assert.equal(second.done, true, 'a resumed session can still be answered and finished');
});

// ── the parse-or-refuse path ────────────────────────────────────────────────

test('WP-2: finish drafts through the loop parser and refuses a malformed document', async () => {
  const repo = cleanRepo('draft');
  const stub = await startModelStub('# Not a task document\n\nThis prose has no Goal or Milestones section.');
  FrontierModelService.register({ tenantId: TENANT, id: 'stub', kind: 'local', baseUrl: stub.url, modelIds: ['stub-code'] });
  GrillSessionService.setAskerForTests(scripted(['q1']));
  try {
    const started = await GrillSessionService.start({ tenantId: TENANT, repo, goal: 'g', providerId: 'stub', model: 'stub-code' });
    await assert.rejects(
      () => GrillSessionService.finish({ tenantId: TENANT, sessionId: started.sessionId }),
      /LOOP_GRILL_DRAFT_INVALID/,
      'a draft the loop parser rejects is a refusal, never a returned file',
    );
    const session = GrillSessionService.get(TENANT, started.sessionId);
    assert.notEqual(session?.status, 'drafted', 'a refused draft must not mark the session drafted');
    assert.equal(session?.taskDocument, undefined);
  } finally {
    GrillSessionService.setAskerForTests(null);
    await stub.close();
  }
});

// ── through the control plane ───────────────────────────────────────────────

test('WP-2: the grill routes require a credential and scope to the caller', async () => {
  TenantService.registerTenant({
    id: TENANT, name: 'Grill tenant', niche: IndustryNiche.CUSTOM_B2B,
    tier: TenantSubscriptionTier.PROFESSIONAL, status: TenantStatus.ACTIVE, apiKeyHash: '',
    quota: { maxRequestsPerMinute: 10_000, maxDailyAiTokens: 10_000_000, burstCapacity: 100, storageLimitMb: 1000 },
    customGuardrails: [], encryptionKeyId: 'test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  TenantService.registerTenant({
    id: OTHER, name: 'Other tenant', niche: IndustryNiche.CUSTOM_B2B,
    tier: TenantSubscriptionTier.PROFESSIONAL, status: TenantStatus.ACTIVE, apiKeyHash: '',
    quota: { maxRequestsPerMinute: 10_000, maxDailyAiTokens: 10_000_000, burstCapacity: 100, storageLimitMb: 1000 },
    customGuardrails: [], encryptionKeyId: 'test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const owner = await TenantService.provisionCredential(TENANT);
  const other = await TenantService.provisionCredential(OTHER);
  resetRateLimiterForTests();

  const repo = cleanRepo('route');
  GrillSessionService.setAskerForTests(scripted(['q1', 'q2']));

  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const anonymous = await fetch(`${base}/api/loop/grills`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    assert.equal(anonymous.status, 401, 'the grill plane must not be served to an unauthenticated caller');

    const started = await fetch(`${base}/api/loop/grills`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': owner.apiKey, 'x-tenant-id': TENANT },
      body: JSON.stringify({ repo, goal: 'Ship it', providerId: 'stub', model: 'stub-code' }),
    });
    assert.equal(started.status, 201);
    const body = (await started.json()) as { sessionId: string; question: string };
    assert.equal(body.question, 'q1');

    const foreign = await fetch(`${base}/api/loop/grills/${body.sessionId}`, { headers: { 'x-api-key': other.apiKey, 'x-tenant-id': OTHER } });
    assert.equal(foreign.status, 404, 'a foreign session id is a miss');

    const mine = await fetch(`${base}/api/loop/grills/${body.sessionId}`, { headers: { 'x-api-key': owner.apiKey, 'x-tenant-id': TENANT } });
    assert.equal(mine.status, 200);
  } finally {
    GrillSessionService.setAskerForTests(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
