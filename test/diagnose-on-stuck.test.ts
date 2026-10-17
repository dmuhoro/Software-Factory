/**
 * Sprint 33, WP-3: diagnose on stuck.
 *
 * Two claims, each proven where it actually runs:
 *
 *  1. **The diagnose advisory is conditional on the attempt.** A unit's *first* attempt gets the
 *     `implementer` skills only; from the *second* attempt — once the model has a `feedback` string
 *     describing a real refusal — the `implementer-stuck` role adds the `diagnosing-bugs` block. The
 *     block must be present **only** at attempt ≥ 2 and **only** when injection is on, exactly like
 *     every other advisory (ADR-013: off is a byte-identical prompt). This is asserted on the real
 *     `buildPrompts` builder, not a helper.
 *
 *  2. **A STUCK unit's report reaches the settlement webhook.** When a unit exhausts its attempts and
 *     the run settles, the signed `loop.run.settled` payload carries a `stuckUnits` entry naming the
 *     failure class, what was tried, and a next step. Proven on the real `LoopControlService.submit`
 *     path with only the socket swapped (the same seam `loop-webhook-delivery.test.ts` uses), so the
 *     payload assembly, tenant scoping and signature all still run.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import type { WebhookTransport } from '../src/services/webhookService';

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-stuck-'));
const workspace = fs.mkdtempSync(path.join(state, 'ws-'));
process.env.FACTORY_DATA_DIR = path.join(state, 'data');
process.env.FACTORY_WORKSPACE_ROOT = workspace;
process.env.NODE_ENV = 'test';
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });

const { DurableStore } = await import('../src/services/durableStore');
const { LoopControlService } = await import('../src/services/loopControlService');
const { FrontierModelService } = await import('../src/services/frontierModelService');
const { WebhookService } = await import('../src/services/webhookService');
const { resolveImplementerAdvisory } = await import('../src/services/skillInjectionService');
const { buildStuckReports, nextStepForFailureClass } = await import('../src/services/stuckReportService');
const { buildPrompts } = await import('../src/services/implementerService');

DurableStore.resetForTests();

const TENANT = 'stuck-report-tenant';

// ── part 1: the advisory is conditional on the attempt ─────────────────────

function fixtureSkill(name: string, body: string) {
  return { name, description: 'fixture', version: '1.0.0', tools: [], enabled: true, body, source: `${name}.skill.md` };
}

const SKILLS = {
  inject: true,
  byRole: { implementer: ['tdd'], 'implementer-stuck': ['diagnosing-bugs'] },
};
const LOAD = () => ({
  skills: [fixtureSkill('tdd', 'Write the failing test first.'), fixtureSkill('diagnosing-bugs', 'Reproduce, isolate, then fix.')],
  refusals: [],
});

test('WP-3: the diagnosing-bugs block is absent on attempt 1 and present from attempt 2', () => {
  const first = resolveImplementerAdvisory(SKILLS, 1, LOAD);
  const second = resolveImplementerAdvisory(SKILLS, 2, LOAD);
  const third = resolveImplementerAdvisory(SKILLS, 3, LOAD);

  assert.ok(first.block.includes('<<<SKILL: tdd>>>'), 'attempt 1 must still carry the implementer skill');
  assert.ok(!first.block.includes('diagnosing-bugs'), 'attempt 1 must NOT carry the diagnose skill');
  assert.ok(second.block.includes('<<<SKILL: diagnosing-bugs>>>'), 'attempt 2 must carry the diagnose skill');
  assert.ok(second.block.includes('<<<SKILL: tdd>>>'), 'attempt 2 keeps the base implementer skill too');
  assert.match(third.block, /<<<SKILL: diagnosing-bugs>>>/, 'the diagnose block persists on later attempts');
});

test('WP-3: the same block reaches the real implementer prompt builder at attempt 2', () => {
  const request = {
    tenantId: TENANT,
    repo: workspace,
    unit: { id: 'u1', milestoneId: 'M1', title: 'Add feature', criteria: [{ id: 'c1', text: 'feature.txt contains alpha' }], dependsOn: [], type: 'feat', verify: 'node check.cjs' },
    document: { title: 'Task', goal: 'Ship the feature.', constraints: [], models: {}, milestones: [], sourceHash: 'x' },
    assignment: { providerId: 'stub', model: 'stub-code' },
    doctrineLines: ['Fail closed.'],
    isolation: { quarantine: [], notes: [] },
    timeoutMs: 1000,
    feedback: 'attempt 1 failed: feature.txt contains alpha',
  } as unknown as import('../src/services/implementerService').ImplementRequest;

  const attempt1 = buildPrompts(request, resolveImplementerAdvisory(SKILLS, 1, LOAD)).task;
  const attempt2 = buildPrompts(request, resolveImplementerAdvisory(SKILLS, 2, LOAD)).task;
  assert.ok(!attempt1.includes('diagnosing-bugs'), 'the first prompt must carry no diagnose block');
  assert.ok(attempt2.includes('diagnosing-bugs'), 'the retry prompt must carry the diagnose block');
});

test('WP-3: with injection off, no attempt carries any block (byte-identical prompt)', () => {
  const off = { inject: false, byRole: SKILLS.byRole };
  for (const attempt of [1, 2, 3]) {
    const result = resolveImplementerAdvisory(off, attempt, LOAD);
    assert.equal(result.block, '', `attempt ${attempt} must be an empty block when injection is off`);
  }
});

test('WP-3: the loop asks for the attempt-aware advisory, not the fixed implementer role', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/services/executionLoopService.ts'), 'utf8');
  assert.match(
    source,
    /advisoryForImplementer\(\s*attempt\.attempt\s*\)/,
    'the loop must pass the attempt number so the diagnose block appears only from the second attempt',
  );
  assert.doesNotMatch(
    source,
    /advisoryForRole\(\s*'implementer'\s*\)/,
    'the loop must not use the attempt-blind implementer role, which would never surface the diagnose skill',
  );
});

// ── part 2: the STUCK report ───────────────────────────────────────────────

function stuckRecord(overrides: Partial<import('../src/services/loopTypes').UnitRecord> = {}): import('../src/services/loopTypes').LoopRunRecord {
  return {
    runId: 'looprun_test',
    tenantId: TENANT,
    status: 'halted',
    stage: 'report',
    units: [{
      unitId: 'u1',
      title: 'Add feature',
      status: 'stuck',
      failureClass: 'verification',
      attempts: [
        { attempt: 1, stage: 'verify', reason: 'verification-failed', detail: 'expected alpha, found gamma', passed: false },
        { attempt: 2, stage: 'verify', reason: 'verification-failed', detail: 'expected alpha, found gamma again', passed: false },
      ],
      commits: 0,
      ...overrides,
    }],
  } as unknown as import('../src/services/loopTypes').LoopRunRecord;
}

test('WP-3: a stuck unit report names the failure class, what was tried, and a next step', () => {
  const [report] = buildStuckReports(stuckRecord());
  assert.equal(report.unitId, 'u1');
  assert.equal(report.failureClass, 'verification');
  assert.equal(report.whatWasTried.length, 2, 'every failed attempt must be listed');
  assert.equal(report.whatWasTried[0].stage, 'verify');
  assert.match(report.whatWasTried[1].detail, /gamma again/);
  assert.equal(report.nextStep, nextStepForFailureClass('verification'));
  assert.ok(report.nextStep.length > 0);
});

test('WP-3: a unit with no recorded class degrades to unknown, never a crash', () => {
  const record = stuckRecord({ failureClass: undefined });
  const [report] = buildStuckReports(record);
  assert.equal(report.failureClass, 'unknown');
  assert.equal(report.nextStep, nextStepForFailureClass('unknown'));
});

test('WP-3: a clean run yields no stuck reports (an empty list, never undefined)', () => {
  const clean = { ...stuckRecord(), units: [] } as unknown as import('../src/services/loopTypes').LoopRunRecord;
  assert.deepEqual(buildStuckReports(clean), []);
});

test('WP-3: every failure class has a distinct, non-empty next step', () => {
  const classes: Array<import('../src/services/loopFailureClass').LoopFailureClass> = ['security', 'verification', 'review', 'model', 'environment', 'policy', 'unknown'];
  const steps = classes.map((failureClass) => nextStepForFailureClass(failureClass));
  for (const step of steps) assert.ok(step.length > 0);
  assert.equal(new Set(steps).size, classes.length, 'each class must give its own next step, not a shared platitude');
});

// ── part 3: the report reaches the settlement webhook, on the real path ─────

type Reply = { files: Array<{ path: string; content: string }>; notes?: string };
const REVIEW_MARKER = 'You are the reviewer for an unattended software delivery loop.';

async function startStub(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const parsed = JSON.parse(body || '{}') as { messages?: Array<{ content?: string }> };
      const prompt = (parsed.messages ?? []).map((message) => message.content ?? '').join('\n');
      // The implementation never satisfies the check, so the unit can never pass verification and
      // must go STUCK. The reviewer is never reached.
      const reply: Reply | { approved: boolean; findings: string[] } = prompt.includes(REVIEW_MARKER)
        ? { approved: true, findings: [] }
        : { files: [{ path: 'feature.txt', content: 'gamma\n' }], notes: 'wrote the wrong thing' };
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

function cleanRepo(name: string): { repo: string; task: string } {
  const root = fs.mkdtempSync(path.join(workspace, `${name}-`));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  const check = path.join(root, 'check.cjs');
  fs.writeFileSync(check, [
    "const fs = require('node:fs');",
    "const ok = fs.existsSync('feature.txt') && fs.readFileSync('feature.txt', 'utf8').includes('alpha');",
    "if (!ok) { console.error('missing alpha'); process.exit(1); }",
    "console.log('ok');",
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'initial']);

  const task = path.join(workspace, `${name}-task.md`);
  fs.writeFileSync(task, [
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
    `verify: node ${check}`,
    '- [ ] feature.txt exists and contains alpha',
    '',
  ].join('\n'), 'utf8');
  return { repo: root, task };
}

test('WP-3: when a run settles with a stuck unit, the signed settlement payload carries its report', async () => {
  WebhookService.resetForTests();
  const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  const transport: WebhookTransport = async (url, body, headers) => { calls.push({ url, body, headers: { ...headers } }); return 200; };
  WebhookService.setTransportForTests(transport);
  WebhookService.subscribe({ tenantId: TENANT, url: 'https://hooks.example.com/loop', events: ['loop.run.settled'] });

  const stub = await startStub();
  FrontierModelService.register({ tenantId: TENANT, id: 'stub', kind: 'local', baseUrl: stub.url, modelIds: ['stub-code'] });
  const { repo, task } = cleanRepo('stuck-settle');
  try {
    const submitted = await LoopControlService.submit({ tenantId: TENANT, repo, taskDocument: task, attemptCap: 2 });
    const outcome = await LoopControlService.whenSettled(submitted.runId)!;
    assert.ok(outcome.record.units.some((unit) => unit.status === 'stuck'), 'the fixture must drive the unit to STUCK');
  } finally {
    await stub.close();
  }

  try {
    assert.equal(calls.length, 1, 'a settlement must attempt exactly one delivery');
    const parsed = JSON.parse(calls[0].body) as { event: string; payload: { stuckUnits: Array<{ unitId: string; failureClass: string; whatWasTried: unknown[]; nextStep: string }> } };
    assert.equal(parsed.event, 'loop.run.settled');
    assert.ok(Array.isArray(parsed.payload.stuckUnits), 'the payload must always carry a stuckUnits array');
    assert.equal(parsed.payload.stuckUnits.length, 1, 'the one stuck unit must be reported');
    const [stuck] = parsed.payload.stuckUnits;
    assert.equal(stuck.failureClass, 'verification');
    assert.ok(stuck.whatWasTried.length >= 1, 'what-was-tried must list the failed attempt(s)');
    assert.ok(stuck.nextStep.length > 0, 'a next step must always be present');
  } finally {
    WebhookService.setTransportForTests(null);
    WebhookService.resetForTests();
  }
});
