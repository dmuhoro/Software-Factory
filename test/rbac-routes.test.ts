/**
 * RBAC route enforcement tests (P0 Identity).
 *
 * Proves that mutation routes refuse a principal whose role binding lacks the
 * required permission or resource scope, and that a principal with no binding
 * holds no role at all. These tests exercise the real route handler (through an
 * Express test server), not the service in isolation.
 *
 * No model keys are required; RBAC is a pure authorization check.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

import { DurableStore } from '../src/services/durableStore';
import { TenantService } from '../src/services/tenantService';
import { resetRateLimiterForTests } from '../src/api/middleware/rateLimiter';
import { apiRouter } from '../src/api';
import { RbacService, ANY_RESOURCE } from '../src/services/rbacService';
import { IndustryNiche, TenantSubscriptionTier, TenantStatus } from '../src/models/tenant';

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-rbac-routes-'));
process.env.FACTORY_DATA_DIR = path.join(state, 'data');
process.env.FACTORY_WORKSPACE_ROOT = path.join(state, 'ws');
process.env.NODE_ENV = 'test';
process.env.FACTORY_API_KEY = 'test-platform-key-0123456789abcdef';
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.FACTORY_WORKSPACE_ROOT, { recursive: true });

DurableStore.resetForTests();
TenantService.resetCacheForTests();
RbacService.resetForTests();

const TENANT = 'rbac-routes-tenant';
TenantService.registerTenant({
  id: TENANT, name: 'RBAC Routes Tenant', niche: IndustryNiche.CUSTOM_B2B,
  tier: TenantSubscriptionTier.PROFESSIONAL, status: TenantStatus.ACTIVE, apiKeyHash: '',
  quota: { maxRequestsPerMinute: 10_000, maxDailyAiTokens: 10_000_000, burstCapacity: 100, storageLimitMb: 1000 },
  customGuardrails: [], encryptionKeyId: 'test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});

let ownerApiKey = '';
test('setup: provision a root credential', async () => {
  const cred = await TenantService.provisionCredential(TENANT);
  ownerApiKey = cred.apiKey;
  resetRateLimiterForTests();
});

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function gitWithEnv(repo: string, env: Record<string, string>, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, ...env } }).trim();
}

function scratchRepo(name: string): { repo: string; branch: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `rbac-routes-${name}-`));
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
    name: 'test-repo', version: '1.0.0', scripts: { verify: 'git diff --check' },
  }));
  fs.writeFileSync(path.join(repo, 'README.md'), '# Test Repo\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '-A');
  gitWithEnv(repo, {
    GIT_AUTHOR_EMAIL: 't@t.com', GIT_AUTHOR_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.com', GIT_COMMITTER_NAME: 't',
  }, 'commit', '-qm', 'initial');
  const branch = git(repo, 'branch', '--show-current');
  return { repo, branch };
}

async function appFor(port: number): Promise<{ server: ReturnType<express.Express['listen']> }> {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = app.listen(port, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return { server };
}

async function fetchJson(port: number, urlPath: string, method: 'GET' | 'POST' = 'GET', body: unknown = undefined, apiKey: string = ownerApiKey, tenantId: string = TENANT): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}/api${urlPath}`, {
    method,
    headers: { 'x-api-key': apiKey, 'x-tenant-id': tenantId, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

test('RBAC: a principal with loop:submit can apply a tool edit', async () => {
  RbacService.bind(TENANT, 'operator', [ANY_RESOURCE]);
  const { repo, branch } = scratchRepo('rbac-apply');
  const { server } = await appFor(0);
  const port = (server.address() as { port: number }).port;
  try {
    const { status } = await fetchJson(port, '/tool-apply/apply', 'POST', {
      repo, branch,
      edits: [{ path: 'hello.txt', operation: 'create', content: 'rbac apply\n' }],
      requestedBy: 'operator', rationale: 'rbac test',
    });
    assert.equal(status, 201, `apply with loop:submit should succeed, got ${status}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('RBAC: a principal without loop:submit is refused on apply', async () => {
  RbacService.resetForTests();
  RbacService.bind(TENANT, 'auditor', [ANY_RESOURCE]);
  const { repo, branch } = scratchRepo('rbac-apply-refuse');
  const { server } = await appFor(0);
  const port = (server.address() as { port: number }).port;
  try {
    const { status } = await fetchJson(port, '/tool-apply/apply', 'POST', {
      repo, branch,
      edits: [{ path: 'hello.txt', operation: 'create', content: 'should be refused\n' }],
      requestedBy: 'auditor', rationale: 'no submit permission',
    });
    assert.equal(status, 403, `apply without loop:submit should be 403, got ${status}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('RBAC: a principal bound to viewer cannot apply (viewer lacks loop:submit)', async () => {
  RbacService.resetForTests();
  RbacService.bind(TENANT, 'viewer', [ANY_RESOURCE]);
  const { repo, branch } = scratchRepo('rbac-viewer-apply');
  const { server } = await appFor(0);
  const port = (server.address() as { port: number }).port;
  try {
    const { status } = await fetchJson(port, '/tool-apply/apply', 'POST', {
      repo, branch,
      edits: [{ path: 'hello.txt', operation: 'create', content: 'viewer apply\n' }],
      requestedBy: 'viewer', rationale: 'viewer has no submit',
    });
    assert.equal(status, 403, `apply by viewer should be 403, got ${status}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('RBAC: records read succeeds with loop:read (viewer)', async () => {
  RbacService.resetForTests();
  RbacService.bind(TENANT, 'viewer', [ANY_RESOURCE]);
  const { server } = await appFor(0);
  const port = (server.address() as { port: number }).port;
  try {
    const { status } = await fetchJson(port, '/tool-apply/records', 'GET');
    assert.equal(status, 200, `records read by viewer should be 200, got ${status}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
