/**
 * The two-axis review (part of the frontier review stage).
 *
 * A single reviewer reading answers two questions at once — "does this fit the repository?" and
 * "does this actually do what the unit asked?" — and model attention trades one off against the
 * other. So the review runs them as two independent model reads, each with its own system prompt,
 * and the change is approved only when BOTH approve. This file pins that: the axes ask different
 * questions, a refusal on either axis refuses the whole review, and both axes are actually dialled.
 *
 * The model is a stub HTTP server speaking the provider contract, because the subject under test
 * is the review's treatment of a model, not the model.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'review-two-axis-'));
process.env.FACTORY_DATA_DIR = path.join(state, 'data');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });

const { DurableStore } = await import('../src/services/durableStore');
const { FrontierModelService } = await import('../src/services/frontierModelService');
const { ReviewService, buildReviewPrompts } = await import('../src/services/reviewService');
import type { ReviewRequest } from '../src/services/reviewService';

DurableStore.resetForTests();

const TENANT = 'review-two-axis';
const REVIEW_MARKER = 'You are the reviewer for an unattended software delivery loop.';

interface Verdict { approved: boolean; findings: string[] }
interface Stub { url: string; prompts: string[]; close: () => Promise<void> }

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(state, 'repo-'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'loop@test.local']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Loop Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# x\n');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'initial']);
  fs.writeFileSync(path.join(dir, 'feature.txt'), 'alpha\n');
  return dir;
}

function requestFor(repo: string): ReviewRequest {
  return {
    tenantId: TENANT,
    repo,
    unit: {
      id: 'm1',
      milestoneId: 'M1',
      title: 'Feature alpha',
      criteria: [{ id: 'c1', text: 'feature-a.txt exists and contains alpha', check: 'node check-a.cjs' }],
      dependsOn: [],
      type: 'feat',
      verify: 'node check-a.cjs',
    },
    document: { title: 'Ship one feature', goal: 'Commit one verified feature', constraints: [], models: {}, milestones: [], sourceHash: 'sha256:doc' },
    assignment: { role: 'reviewer', tier: 'frontier', providerId: 'stub', model: 'stub-code', source: 'task-document' },
    doctrineLines: ['R-13-REVIEW-APPROVAL: nothing commits without review approval'],
    isolation: { doctrineRoot: '/d', doctrineDigest: 'sha256:deadbeef', targetRepo: repo, quarantine: [], childEnv: {}, stagedAt: 'now', readStrategy: 'sequential' as const },
    proof: {
      passed: true,
      repo,
      head: 'HEAD',
      checks: [{ id: 'cmd:c', kind: 'command', command: 'node check-a.cjs', exitCode: 0, passed: true, outputDigest: 'deadbeef', outputTail: 'ok', startedAt: 'now', completedAt: 'now' }],
      claimedFiles: [],
      observedFiles: [],
      rejectedNarration: [],
      recordedAt: 'now',
    },
    timeoutMs: 60_000,
  };
}

async function startStub(respond: (prompt: string) => Verdict): Promise<Stub> {
  const prompts: string[] = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}') as { messages?: Array<{ content?: string }> };
        const prompt = (parsed.messages ?? []).map((message) => message.content ?? '').join('\n');
        prompts.push(prompt);
        const content = ['```json', JSON.stringify(respond(prompt)), '```'].join('\n');
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content } }] }));
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
    prompts,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function withReview(respond: (prompt: string) => Verdict, body: (stub: Stub) => Promise<void>): Promise<void> {
  const repo = makeRepo();
  const stub = await startStub(respond);
  FrontierModelService.register({ tenantId: TENANT, id: 'stub', kind: 'local', baseUrl: stub.url, modelIds: ['stub-code'] });
  try {
    await body(stub);
    assert.ok(repo, 'fixture repo exists');
  } finally {
    await stub.close();
  }
}

test('the two axes ask two different questions, each named in its own system prompt', () => {
  const repo = makeRepo();
  const standards = buildReviewPrompts(requestFor(repo), 'standards');
  const spec = buildReviewPrompts(requestFor(repo), 'spec');

  assert.match(standards.system, /Review axis: standards/);
  assert.match(spec.system, /Review axis: spec/);
  assert.notEqual(standards.system, spec.system, 'the axes must not share a system prompt');

  assert.match(standards.system, /contradicts the repository's stated architecture/, 'the standards axis owns architecture fit');
  assert.doesNotMatch(standards.system, /an acceptance criterion is met only by the test itself/);
  assert.match(spec.system, /an acceptance criterion is met only by the test itself/, 'the spec axis owns criterion truth');
  assert.doesNotMatch(spec.system, /contradicts the repository's stated architecture/);

  assert.match(standards.task, /Review axis: standards/);
  assert.match(spec.task, /Review axis: spec/);
});

test('a change that passes standards but fails spec is refused, and the refusal names the spec axis', async () => {
  await withReview((prompt) => (prompt.includes('Review axis: spec')
    ? { approved: false, findings: ['criterion c1 is met only by the test that reads feature.txt'] }
    : { approved: true, findings: [] }), async (stub) => {
    const result = await ReviewService.review(requestFor(makeRepo()));

    assert.equal(result.axes.length, 2, 'both axes must be recorded');
    assert.deepEqual(result.axes.map((axis) => axis.axis), ['standards', 'spec']);
    assert.equal(result.approved, false, 'one axis refusing must refuse the whole review');
    assert.ok(result.findings.some((finding) => finding.startsWith('[spec]')), `findings must name the refusing axis: ${JSON.stringify(result.findings)}`);

    const reviewPrompts = stub.prompts.filter((prompt) => prompt.includes(REVIEW_MARKER));
    assert.equal(reviewPrompts.length, 2, 'each axis must be dialled exactly once');
    assert.ok(reviewPrompts.some((prompt) => prompt.includes('Review axis: standards')));
    assert.ok(reviewPrompts.some((prompt) => prompt.includes('Review axis: spec')));
  });
});

test('a change refused by the standards axis is refused even when the spec axis approves', async () => {
  await withReview((prompt) => (prompt.includes('Review axis: standards')
    ? { approved: false, findings: ['duplicates an existing util instead of reusing it'] }
    : { approved: true, findings: [] }), async () => {
    const result = await ReviewService.review(requestFor(makeRepo()));

    assert.equal(result.approved, false);
    assert.ok(result.findings.some((finding) => finding.startsWith('[standards]')), `findings must name the refusing axis: ${JSON.stringify(result.findings)}`);
  });
});

test('a change both axes approve is approved, with no findings', async () => {
  await withReview(() => ({ approved: true, findings: [] }), async (stub) => {
    const result = await ReviewService.review(requestFor(makeRepo()));

    assert.equal(result.axes.length, 2);
    assert.deepEqual(result.axes.map((axis) => axis.approved), [true, true]);
    assert.equal(result.approved, true);
    assert.deepEqual(result.findings, []);
    assert.equal(stub.prompts.filter((prompt) => prompt.includes(REVIEW_MARKER)).length, 2);
  });
});
