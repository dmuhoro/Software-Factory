/**
 * Preview plane — Layer 2 Agency.
 *
 * The preview plane builds a target repo in an ephemeral git worktree, runs its
 * dev server on an ephemeral port, and exposes a commit → preview mapping.
 * Additive only: no loop, doctrine, or gate is touched.
 *
 * These tests exercise the real service against a real git repo and a real
 * worktree. The dev server is a tiny HTTP server we spawn ourselves (no external
 * package manager needed), so the tests are deterministic and credential-free.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { previewPlaneService } from '../src/services/previewPlaneService';

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-preview-'));
const workspace = fs.mkdtempSync(path.join(state, 'ws-'));
process.env.FACTORY_DATA_DIR = path.join(state, 'data');
process.env.FACTORY_WORKSPACE_ROOT = workspace;
process.env.NODE_ENV = 'test';
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });

const TENANT = 'preview-tenant';

function makeRepo(name: string): { repo: string; commit: string } {
  const root = fs.mkdtempSync(path.join(workspace, `${name}-`));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);

  // A tiny dev server the preview plane can start on an ephemeral port.
  const pkg = {
    name: `preview-fixture-${name}`,
    version: '1.0.0',
    scripts: { dev: 'node server.js' },
  };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg, null, 2));
  fs.writeFileSync(
    path.join(root, 'server.js'),
    [
      'const http = require("node:http");',
      'const port = process.env.PORT || 3000;',
      'const host = process.env.HOST || "127.0.0.1";',
      'http.createServer((req, res) => {',
      '  res.writeHead(200, { "content-type": "text/html" });',
      '  res.end("<html><body>preview of ' + name + '</body></html>");',
      '}).listen(port, host);',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(root, 'index.html'), '<html><body>fixture</body></html>\n');

  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'initial']);
  const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { repo: root, commit };
}

test('createSession builds a worktree, starts a dev server, and returns a ready session', async () => {
  const { repo, commit } = makeRepo('ready');
  const session = await previewPlaneService.createSession({ tenantId: TENANT, repo, commit });

  assert.equal(session.sessionId.startsWith('preview-'), true);
  assert.equal(session.tenantId, TENANT);
  assert.equal(session.repo, repo);
  assert.equal(session.commit, commit);
  assert.equal(session.status, 'ready');
  assert.ok(session.port > 0);
  assert.ok(session.url.startsWith('http://127.0.0.1:'));
  assert.ok(fs.existsSync(session.worktreePath), 'worktree must exist while the session is ready');

  // The dev server actually answers.
  const res = await new Promise<{ statusCode: number | undefined; body: string }>((resolve) => {
    http.get(session.url, (r) => {
      let body = '';
      r.on('data', (c) => (body += c));
      r.on('end', () => resolve({ statusCode: r.statusCode, body }));
    });
  });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes('preview of ready'));
});

test('createSession with an unknown commit is refused', async () => {
  const { repo } = makeRepo('refused');
  await assert.rejects(
    previewPlaneService.createSession({ tenantId: TENANT, repo, commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }),
    /unknown revision|not found|ambiguous argument|Needed a single revision/,
  );
});

test('list returns sessions scoped to the authenticated tenant', async () => {
  previewPlaneService.stopAll();
  const { repo: r1, commit: c1 } = makeRepo('tenant-a-1');
  const { repo: r2, commit: c2 } = makeRepo('tenant-b-1');
  await previewPlaneService.createSession({ tenantId: 'tenant-a', repo: r1, commit: c1 });
  await previewPlaneService.createSession({ tenantId: 'tenant-b', repo: r2, commit: c2 });

  const a = previewPlaneService.list('tenant-a');
  const b = previewPlaneService.list('tenant-b');
  const all = previewPlaneService.list();

  assert.equal(a.length, 1);
  assert.equal(a[0].tenantId, 'tenant-a');
  assert.equal(b.length, 1);
  assert.equal(b[0].tenantId, 'tenant-b');
  assert.equal(all.length, 2);
});

test('get returns a session by id', async () => {
  const { repo, commit } = makeRepo('get-fixture');
  const session = await previewPlaneService.createSession({ tenantId: TENANT, repo, commit });

  const got = previewPlaneService.get(session.sessionId);
  assert.ok(got);
  assert.equal(got!.sessionId, session.sessionId);
  assert.equal(got!.tenantId, TENANT);
  assert.equal(got!.status, 'ready');
});

test('stop removes the worktree and kills the dev server', async () => {
  const { repo, commit } = makeRepo('stop-fixture');
  const session = await previewPlaneService.createSession({ tenantId: TENANT, repo, commit });
  assert.equal(session.status, 'ready');
  assert.ok(fs.existsSync(session.worktreePath));

  const stopped = previewPlaneService.stop(session.sessionId);
  assert.equal(stopped, true);

  const after = previewPlaneService.get(session.sessionId);
  assert.ok(!after || after.status === 'stopped');
  assert.ok(!fs.existsSync(session.worktreePath), 'worktree must be removed on stop');
});

test('stopAll clears every session', async () => {
  const { repo: r1, commit: c1 } = makeRepo('all-1');
  const { repo: r2, commit: c2 } = makeRepo('all-2');
  await previewPlaneService.createSession({ tenantId: TENANT, repo: r1, commit: c1 });
  await previewPlaneService.createSession({ tenantId: TENANT, repo: r2, commit: c2 });

  previewPlaneService.stopAll();
  assert.equal(previewPlaneService.list().length, 0);
  assert.equal(previewPlaneService.list(TENANT).length, 0);
});
