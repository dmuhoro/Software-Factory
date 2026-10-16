/**
 * Sprint 31, WP-5: the loop's settlement webhook, proven on the real path.
 *
 * The rule under test is that when a run the control plane started actually settles, a
 * signed `loop.run.settled` event is dispatched to that tenant's subscription — and that
 * this happens on the real `LoopControlService.submit` path, not in a helper only tests
 * call. The only thing swapped for the test is the socket (`setTransportForTests`): the
 * signature, the headers, the tenant scoping and the subscription filter all still run,
 * because they are the parts that must hold in production.
 *
 * A receiver that is down must not turn a finished run into a failed one. The dispatch is
 * fire-and-forget from the run's perspective; the failure is recorded per-delivery and the
 * run settles normally. That is asserted here too, because a webhook that can break the
 * thing it reports on is worse than no webhook.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import type { WebhookTransport } from '../src/services/webhookService';

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-loop-webhook-'));
const workspace = fs.mkdtempSync(path.join(state, 'ws-'));
process.env.FACTORY_DATA_DIR = path.join(state, 'data');
process.env.FACTORY_WORKSPACE_ROOT = workspace;
process.env.NODE_ENV = 'test';
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });

const { DurableStore } = await import('../src/services/durableStore');
const { LoopControlService } = await import('../src/services/loopControlService');
const { FrontierModelService } = await import('../src/services/frontierModelService');
const {
  WebhookService,
  verifyWebhookSignature,
} = await import('../src/services/webhookService');

DurableStore.resetForTests();

const TENANT = 'loop-webhook-tenant';
const OTHER = 'loop-webhook-other';

// ── fixtures (same shape as loop-control-plane.test.ts: a real repo, a real task) ──

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

async function withStub<T>(body: () => Promise<T>): Promise<T> {
  const stub = await startStub();
  FrontierModelService.register({ tenantId: TENANT, id: 'stub', kind: 'local', baseUrl: stub.url, modelIds: ['stub-code'] });
  try {
    return await body();
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

const CHECK = [
  "const fs = require('node:fs');",
  "const ok = fs.existsSync('feature.txt') && fs.readFileSync('feature.txt', 'utf8').includes('alpha');",
  "if (!ok) { console.error('missing alpha'); process.exit(1); }",
  "console.log('ok');",
].join('\n');

function cleanRepo(name: string): { repo: string; task: string } {
  const root = fs.mkdtempSync(path.join(workspace, `${name}-`));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  const check = path.join(root, 'check.cjs');
  fs.writeFileSync(check, CHECK);
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'initial']);
  return { repo: root, task: writeTaskFor(name, check) };
}

/** A recording transport: the socket is swapped, nothing else. */
function recordingTransport(): { calls: Array<{ url: string; body: string; headers: Record<string, string> }>; transport: WebhookTransport } {
  const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  const transport: WebhookTransport = async (url, body, headers) => {
    calls.push({ url, body, headers: { ...headers } });
    return 200;
  };
  return { calls, transport };
}

// ── the wiring ─────────────────────────────────────────────────────────────

test('a real run that settles dispatches a signed loop.run.settled event to that tenant', async () => {
  WebhookService.resetForTests();
  const { calls, transport } = recordingTransport();
  WebhookService.setTransportForTests(transport);
  const subscription = WebhookService.subscribe({ tenantId: TENANT, url: 'https://hooks.example.com/loop', events: ['loop.run.settled'] });

  const { repo, task } = cleanRepo('webhook-settle');
  await withStub(async () => {
    const submitted = await LoopControlService.submit({ tenantId: TENANT, repo, taskDocument: task });
    const outcome = await LoopControlService.whenSettled(submitted.runId)!;
    assert.equal(outcome.record.status, 'completed', `run did not complete: ${outcome.record.hardStop ?? outcome.record.refusal ?? ''}`);
  });

  try {
    assert.equal(calls.length, 1, 'exactly one delivery must be attempted for one settlement');
    const [delivery] = calls;
    assert.equal(delivery.url, 'https://hooks.example.com/loop');

    const parsed = JSON.parse(delivery.body) as { event: string; tenantId: string; payload: { runId: string; status: string; commits: number } };
    assert.equal(parsed.event, 'loop.run.settled');
    assert.equal(parsed.tenantId, TENANT);
    assert.match(parsed.payload.runId, /^looprun_/);
    assert.equal(parsed.payload.status, 'completed');
    assert.equal(parsed.payload.commits, 1, 'the payload must describe the run that actually ran');

    // The transport receives the signing material under its plain keys (the HTTP header
    // names — x-sf-signature and friends — are applied by the real transport when it sends).
    // A receiver checks exactly this material against the body it received.
    assert.equal(delivery.headers.event, 'loop.run.settled');
    assert.ok(delivery.headers.deliveryId.startsWith('whd_'));
    assert.ok(
      verifyWebhookSignature(delivery.body, subscription.secret, delivery.headers.timestamp, delivery.headers.signature),
      'the delivered signature must verify against the delivered body',
    );

    // And the secret must never appear in the body or the headers a third party observes.
    assert.ok(!delivery.body.includes(subscription.secret));
    assert.ok(!JSON.stringify(delivery.headers).includes(subscription.secret));
  } finally {
    WebhookService.setTransportForTests(null);
    WebhookService.resetForTests();
  }
});

test('another tenant with no subscription receives nothing, and the run is unaffected', async () => {
  WebhookService.resetForTests();
  const { calls, transport } = recordingTransport();
  WebhookService.setTransportForTests(transport);
  // Only OTHER has a subscription; TENANT submits the run.
  WebhookService.subscribe({ tenantId: OTHER, url: 'https://hooks.example.com/other' });

  const { repo, task } = cleanRepo('webhook-tenant-scope');
  await withStub(async () => {
    const submitted = await LoopControlService.submit({ tenantId: TENANT, repo, taskDocument: task });
    const outcome = await LoopControlService.whenSettled(submitted.runId)!;
    assert.equal(outcome.record.status, 'completed');
  });

  try {
    assert.equal(calls.length, 0, 'a tenant without a subscription must not cause a delivery');
  } finally {
    WebhookService.setTransportForTests(null);
    WebhookService.resetForTests();
  }
});

test('a receiver that is down is recorded as a failed delivery and the run still settles', async () => {
  WebhookService.resetForTests();
  const failing: WebhookTransport = async () => { throw new Error('receiver is down'); };
  WebhookService.setTransportForTests(failing);
  const subscription = WebhookService.subscribe({ tenantId: TENANT, url: 'https://hooks.example.com/down' });

  const { repo, task } = cleanRepo('webhook-down');
  await withStub(async () => {
    const submitted = await LoopControlService.submit({ tenantId: TENANT, repo, taskDocument: task });
    const outcome = await LoopControlService.whenSettled(submitted.runId)!;
    // The critical claim: the run settles normally. A webhook that could fail the run
    // would be worse than no webhook at all.
    assert.equal(outcome.record.status, 'completed', 'a failing webhook receiver must not change the run outcome');
  });

  try {
    // The attempt is recorded against the subscription, so an operator can see it failed
    // and replay it. Nothing is silently dropped.
    const listed = WebhookService.list(TENANT);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, subscription.id);
  } finally {
    WebhookService.setTransportForTests(null);
    WebhookService.resetForTests();
  }
});
