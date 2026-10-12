/**
 * The tracker bridge (sprint 28, WP-2): an issue from a tracker becomes a validated task document.
 *
 * Two sources, one trust boundary. `local` reads a file inside the approved workspace; `github`
 * reads the GitHub REST API through the guarded egress path, so the token goes only where the
 * guard permits and the adapter refuses before any socket is opened when there is no allowlisted
 * token. Then `IssueIntakeService.draft` pushes the issue through the SAME model contract and the
 * loop's own parser as goal intake, so an issue-drafted document is no more trusted than a
 * goal-drafted one.
 *
 * The GitHub adapter is real: it is driven end to end against a loopback stub server speaking the
 * real egress contract (egressJson), including the status-code and pull-request refusals. What it
 * cannot do here is talk to api.github.com, because that host is not allowlisted in this
 * environment — which is itself the point: without the operator's allowlist it fails closed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-intake-'));
process.env.FACTORY_DATA_DIR = path.join(state, 'data');
process.env.FACTORY_WORKSPACE_ROOT = path.join(state, 'ws-');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.FACTORY_WORKSPACE_ROOT, { recursive: true });

const { DurableStore } = await import('../src/services/durableStore');
const { IssueTrackerService, parseLocalIssue } = await import('../src/services/issueTrackerService');
const { IssueIntakeService } = await import('../src/services/issueIntakeService');
const { FrontierModelService } = await import('../src/services/frontierModelService');
const { parseTaskDocument } = await import('../src/services/taskDocumentService');

DurableStore.resetForTests();

const TENANT = 'issue-intake';
const ROOT = process.env.FACTORY_WORKSPACE_ROOT as string;

function cleanRepo(name: string): string {
  const root = fs.mkdtempSync(path.join(ROOT, `${name}-`));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'initial']);
  return root;
}

function validDoc(): string {
  return [
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
    'verify: node check.cjs',
    '- [ ] feature.txt exists and contains alpha',
    '',
    '### M2: Feature beta',
    'depends: M1',
    'type: feat',
    'verify: node check-b.cjs',
    '- [ ] feature-b.txt exists and contains beta',
    '',
  ].join('\n');
}

interface Stub { url: string; close: () => Promise<void> }

async function startModelStub(doc: string): Promise<Stub> {
  const server = http.createServer((request, response) => {
    request.on('data', () => {});
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: doc } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/v1`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

type GitHubReply = { status: number; body: Record<string, unknown> };

async function startGitHubStub(respond: (url: string) => GitHubReply): Promise<Stub> {
  const server = http.createServer((request, response) => {
    request.on('data', () => {});
    request.on('end', () => {
      const reply = respond(request.url ?? '');
      response.writeHead(reply.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function withGitHubToken(): string {
  const previous = process.env.FACTORY_ALLOWED_SECRET_REFS;
  process.env.FACTORY_ALLOWED_SECRET_REFS = 'ISSUE_TEST_TOKEN';
  process.env.ISSUE_TEST_TOKEN = 'ghp_fake_only_for_tests';
  return previous ?? '';
}

// ── the local source ───────────────────────────────────────────────────────

test('a local JSON issue is read inside the workspace', async () => {
  const file = path.join(ROOT, 'issue.json');
  fs.writeFileSync(file, JSON.stringify({ id: '42', title: 'Add alpha feature', body: 'feature.txt must contain alpha', labels: ['p0'] }), 'utf8');
  const issue = await IssueTrackerService.fetch({ spec: { kind: 'local', path: file } });
  assert.equal(issue.source, 'local');
  assert.equal(issue.id, '42');
  assert.equal(issue.title, 'Add alpha feature');
  assert.deepEqual(issue.labels, ['p0']);
});

test('a local markdown issue is read with the heading as the title', async () => {
  const file = path.join(ROOT, 'issue.md');
  fs.writeFileSync(file, '# Add beta feature\n\nfeature-b.txt must contain beta.\n', 'utf8');
  const issue = await IssueTrackerService.fetch({ spec: { kind: 'local', path: file } });
  assert.equal(issue.title, 'Add beta feature');
  assert.match(issue.body, /feature-b\.txt must contain beta/);
});

test('a local issue that cannot be an issue is refused, not invented', async () => {
  const empty = path.join(ROOT, 'empty.md');
  fs.writeFileSync(empty, '', 'utf8');
  await assert.rejects(IssueTrackerService.fetch({ spec: { kind: 'local', path: empty } }), /ISSUE_LOCAL_FILE_INVALID/);

  const noTitle = path.join(ROOT, 'notitle.md');
  fs.writeFileSync(noTitle, 'just prose with no heading\n', 'utf8');
  await assert.rejects(IssueTrackerService.fetch({ spec: { kind: 'local', path: noTitle } }), /ISSUE_LOCAL_FILE_INVALID:the markdown has no "# " title heading/);
  assert.throws(() => parseLocalIssue('{"body":"no title"}'), /ISSUE_LOCAL_FILE_INVALID:the JSON has no title/);
  assert.throws(() => parseLocalIssue('not json at all {'), /ISSUE_LOCAL_FILE_INVALID/);
});

test('a local issue outside the workspace is refused', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-ws-'));
  const file = path.join(outside, 'issue.md');
  fs.writeFileSync(file, '# x\n\nbody\n', 'utf8');
  await assert.rejects(IssueTrackerService.fetch({ spec: { kind: 'local', path: file } }), /ISSUE_LOCAL_PATH_OUTSIDE_WORKSPACE/);
});

test('an unknown source kind is refused', async () => {
  await assert.rejects(IssueTrackerService.fetch({ spec: { kind: 'linear', path: 'x' } }), /ISSUE_SOURCE_KIND_UNKNOWN/);
  await assert.rejects(IssueTrackerService.fetch({ spec: null }), /ISSUE_SOURCE_REQUIRED/);
});

// ── the GitHub source ──────────────────────────────────────────────────────

test('the GitHub adapter refuses before any socket is opened when there is no allowlisted token', async () => {
  await assert.rejects(IssueTrackerService.fetch({ spec: { kind: 'github', repo: 'dmuhoro/software-factory', number: 1 } }), /ISSUE_GITHUB_TOKEN_REQUIRED/);
});

test('the GitHub adapter validates the reference shape', async () => {
  await assert.rejects(IssueTrackerService.fetch({ spec: { kind: 'github', number: 1, tokenSecretRef: 'ISSUE_TEST_TOKEN' } }), /ISSUE_GITHUB_REPO_REQUIRED/);
  await assert.rejects(IssueTrackerService.fetch({ spec: { kind: 'github', repo: 'no-slash', number: 1, tokenSecretRef: 'ISSUE_TEST_TOKEN' } }), /ISSUE_GITHUB_REPO_MALFORMED/);
  await assert.rejects(IssueTrackerService.fetch({ spec: { kind: 'github', repo: 'o/n', number: 0, tokenSecretRef: 'ISSUE_TEST_TOKEN' } }), /ISSUE_GITHUB_NUMBER_REQUIRED/);
});

test('the GitHub adapter reads one issue through the guarded egress path', async () => {
  const stub = await startGitHubStub((url) => {
    assert.equal(url, '/repos/dmuhoro/software-factory/issues/42');
    return {
      status: 200,
      body: { number: 42, title: 'Add alpha', body: 'feature.txt must contain alpha', html_url: 'https://github.com/dmuhoro/software-factory/issues/42', labels: [{ name: 'p0' }] },
    };
  });
  const previous = withGitHubToken();
  try {
    const issue = await IssueTrackerService.fetch({ spec: { kind: 'github', repo: 'dmuhoro/software-factory', number: 42, tokenSecretRef: 'ISSUE_TEST_TOKEN', baseUrl: stub.url } });
    assert.equal(issue.source, 'github');
    assert.equal(issue.id, '42');
    assert.equal(issue.title, 'Add alpha');
    assert.deepEqual(issue.labels, ['p0']);
    assert.match(issue.url ?? '', /github\.com/);
  } finally {
    await stub.close();
    if (previous === '') delete process.env.FACTORY_ALLOWED_SECRET_REFS; else process.env.FACTORY_ALLOWED_SECRET_REFS = previous;
    delete process.env.ISSUE_TEST_TOKEN;
  }
});

test('the GitHub adapter maps statuses and shapes explicitly, never inventing an issue', async () => {
  const run = async (respond: (url: string) => GitHubReply): Promise<unknown> => {
    const stub = await startGitHubStub(respond);
    const previous = withGitHubToken();
    try {
      return await IssueTrackerService.fetch({ spec: { kind: 'github', repo: 'o/n', number: 1, tokenSecretRef: 'ISSUE_TEST_TOKEN', baseUrl: stub.url } });
    } finally {
      await stub.close();
      if (previous === '') delete process.env.FACTORY_ALLOWED_SECRET_REFS; else process.env.FACTORY_ALLOWED_SECRET_REFS = previous;
      delete process.env.ISSUE_TEST_TOKEN;
    }
  };

  await assert.rejects(run(() => ({ status: 404, body: { message: 'Not Found' } })), /ISSUE_GITHUB_NOT_FOUND/);
  await assert.rejects(run(() => ({ status: 401, body: { message: 'Bad credentials' } })), /ISSUE_GITHUB_AUTH_FAILED/);
  await assert.rejects(run(() => ({ status: 403, body: { message: 'Forbidden' } })), /ISSUE_GITHUB_AUTH_FAILED/);
  await assert.rejects(run(() => ({ status: 503, body: { message: 'maintenance' } })), /ISSUE_GITHUB_FETCH_FAILED/);
  await assert.rejects(run(() => ({ status: 200, body: { message: 'not an issue at all' } })), /ISSUE_GITHUB_RESPONSE_INVALID/);
  await assert.rejects(
    run(() => ({ status: 200, body: { number: 1, title: 'x', body: 'b', pull_request: { url: 'https://github.com/o/n/pull/1' } } })),
    /ISSUE_GITHUB_IS_PULL_REQUEST/,
    'a pull request number must never be planned as an issue',
  );
});

// ── the bridge ─────────────────────────────────────────────────────────────

test('the bridge drafts a validated task document from a local issue, blocking edges included', async () => {
  const repo = cleanRepo('bridge-e2e');
  const issuePath = path.join(ROOT, 'e2e-issue.md');
  fs.writeFileSync(issuePath, '# Ship alpha then beta\n\nalpha first, beta depends on alpha.\n', 'utf8');
  const model = await startModelStub(validDoc());
  FrontierModelService.register({ tenantId: TENANT, id: 'stub', kind: 'local', baseUrl: model.url, modelIds: ['stub-code'] });
  try {
    const draft = await IssueIntakeService.draft({ tenantId: TENANT, repo, source: { kind: 'local', path: issuePath }, providerId: 'stub', model: 'stub-code' });
    assert.ok(fs.existsSync(draft.taskDocument), 'the draft was not written to disk');
    const parsed = parseTaskDocument(fs.readFileSync(draft.taskDocument, 'utf8'));
    assert.equal(parsed.title, 'Ship the feature');
    assert.deepEqual(parsed.milestones.map((milestone) => milestone.id), ['M1', 'M2']);
    assert.deepEqual(parsed.milestones[1].dependsOn, ['M1'], 'the blocking edge from the issue must survive the draft');
    assert.equal(draft.issue.source, 'local');
    assert.equal(draft.issue.id, 'e2e-issue.md');
  } finally {
    await model.close();
  }
});

test('the bridge refuses a draft the loop parser would reject', async () => {
  const repo = cleanRepo('bridge-bad');
  const issuePath = path.join(ROOT, 'bad-issue.md');
  fs.writeFileSync(issuePath, '# Broken\n\nnot actionable\n', 'utf8');
  const model = await startModelStub('not a task document at all\n');
  FrontierModelService.register({ tenantId: TENANT, id: 'stub', kind: 'local', baseUrl: model.url, modelIds: ['stub-code'] });
  try {
    await assert.rejects(
      () => IssueIntakeService.draft({ tenantId: TENANT, repo, source: { kind: 'local', path: issuePath }, providerId: 'stub', model: 'stub-code' }),
      /LOOP_ISSUE_DRAFT_INVALID/,
    );
  } finally {
    await model.close();
  }
});

test('the bridge never reaches the model when the issue cannot be read', async () => {
  const repo = cleanRepo('bridge-noread');
  const missing = path.join(ROOT, 'does-not-exist.md');
  let dialled = false;
  const patchStub = http.createServer((request, response) => {
    request.on('data', () => {});
    request.on('end', () => { dialled = true; response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content: validDoc() } }] })); });
  });
  await new Promise<void>((resolve) => patchStub.listen(0, '127.0.0.1', resolve));
  const address = patchStub.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  FrontierModelService.register({ tenantId: TENANT, id: 'stub', kind: 'local', baseUrl: `http://127.0.0.1:${port}/v1`, modelIds: ['stub-code'] });
  try {
    await assert.rejects(
      () => IssueIntakeService.draft({ tenantId: TENANT, repo, source: { kind: 'local', path: missing }, providerId: 'stub', model: 'stub-code' }),
      /PATH_DOES_NOT_EXIST/,
    );
    assert.equal(dialled, false, 'the model was dialled for an issue that could not be read');
  } finally {
    await patchStub.close();
  }
});