/**
 * Security audit tests (Layer 5 Diagnostic, cloudflare security-audit-skill shape).
 *
 * Proves:
 *  - SA-1  a hardcoded credential is reported with a file, a line, a severity, and a remediation
 *  - SA-2  the evidence never contains the credential itself
 *  - SA-3  dynamic code execution is reported
 *  - SA-4  a shell command built from a runtime value is reported
 *  - SA-5  disabled TLS verification and the "none" token algorithm are reported
 *  - SA-6  a credential written to the log is reported
 *  - SA-7  clean source produces no findings
 *  - SA-8  the same source always produces the same findings
 *  - SA-9  the audit route audits a repository inside the workspace and refuses one outside it
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-security-audit-'));
process.env.FACTORY_DATA_DIR = path.join(state, 'data');
process.env.FACTORY_WORKSPACE_ROOT = path.join(state, 'ws');
process.env.NODE_ENV = 'test';
process.env.FACTORY_API_KEY = 'test-platform-key-0123456789abcdef';
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.FACTORY_WORKSPACE_ROOT, { recursive: true });

const { DurableStore } = await import('../src/services/durableStore');
const { TenantService } = await import('../src/services/tenantService');
const { resetRateLimiterForTests } = await import('../src/api/middleware/rateLimiter');
const { apiRouter } = await import('../src/api');
const { auditSource } = await import('../src/services/securityAuditService');
const { IndustryNiche, TenantSubscriptionTier, TenantStatus } = await import('../src/models/tenant');

DurableStore.resetForTests();
TenantService.resetCacheForTests();

const TENANT = 'security-audit-tenant';
TenantService.registerTenant({
  id: TENANT, name: 'Security Audit Tenant', niche: IndustryNiche.CUSTOM_B2B,
  tier: TenantSubscriptionTier.PROFESSIONAL, status: TenantStatus.ACTIVE, apiKeyHash: '',
  quota: { maxRequestsPerMinute: 10_000, maxDailyAiTokens: 10_000_000, burstCapacity: 100, storageLimitMb: 1000 },
  customGuardrails: [], encryptionKeyId: 'test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});

let apiKey = '';
test('setup: provision a root credential', async () => {
  apiKey = (await TenantService.provisionCredential(TENANT)).apiKey;
  resetRateLimiterForTests();
});

const DIRTY = `import { execSync } from 'node:child_process';

const API_KEY = 'sk-1234567890abcdef1234567890abcdef';

export function run(target: string): string {
  execSync('cat ' + target);
  eval('return 1');
  console.log('token', API_KEY);
  return API_KEY;
}
`;

const TLS = `import https from 'node:https';

export function call(options: Record<string, unknown>): void {
  https.request({ ...options, rejectUnauthorized: false });
}

export const verifier = { algorithm: 'none' };
`;

test('SA-1: a hardcoded credential is reported with a file, a line, a severity and a remediation', () => {
  const result = auditSource([{ path: 'src/creds.ts', content: DIRTY }]);
  const secret = result.findings.find((finding) => finding.rule === 'hardcoded-secret');
  assert.ok(secret, 'the hardcoded credential was not reported');
  assert.equal(secret!.file, 'src/creds.ts');
  assert.equal(secret!.line, 3);
  assert.ok(secret!.severity === 'critical' || secret!.severity === 'high');
  assert.ok(secret!.remediation.length > 0);
  assert.ok(secret!.confidence > 0 && secret!.confidence <= 1);
  assert.equal(secret!.source, 'ast');
});

test('SA-2: the evidence never contains the credential itself', () => {
  const result = auditSource([{ path: 'src/creds.ts', content: DIRTY }]);
  const credential = 'sk-1234567890abcdef1234567890abcdef';
  for (const finding of result.findings) {
    assert.ok(!finding.evidence.includes(credential), `the evidence leaked the credential: ${finding.evidence}`);
  }
  const secret = result.findings.find((finding) => finding.rule === 'hardcoded-secret')!;
  assert.match(secret.evidence, /\*\*\*/, 'the credential is masked');
});

test('SA-3: dynamic code execution is reported', () => {
  const result = auditSource([{ path: 'src/creds.ts', content: DIRTY }]);
  const dynamic = result.findings.filter((finding) => finding.rule === 'dynamic-code-execution');
  assert.ok(dynamic.length > 0, 'eval was not reported');
  assert.ok(dynamic.every((finding) => finding.line !== undefined));
});

test('SA-4: a shell command built from a runtime value is reported', () => {
  const result = auditSource([{ path: 'src/creds.ts', content: DIRTY }]);
  const injection = result.findings.find((finding) => finding.rule === 'command-injection');
  assert.ok(injection, 'the shell command was not reported');
  assert.equal(injection!.line, 6);
});

test('SA-5: disabled TLS verification and the "none" token algorithm are reported', () => {
  const result = auditSource([{ path: 'src/tls.ts', content: TLS }]);
  const tls = result.findings.find((finding) => finding.rule === 'tls-verification-disabled');
  assert.ok(tls, 'the disabled TLS verification was not reported');
  assert.equal(tls!.severity, 'critical');
  const none = result.findings.find((finding) => finding.rule === 'jwt-algorithm-none');
  assert.ok(none, 'the "none" algorithm was not reported');
  assert.equal(none!.severity, 'critical');
});

test('SA-6: a credential written to the log is reported', () => {
  const result = auditSource([{ path: 'src/creds.ts', content: DIRTY }]);
  const logged = result.findings.find((finding) => finding.rule === 'secret-in-log');
  assert.ok(logged, 'the logged credential was not reported');
  assert.equal(logged!.line, 8);
});

test('SA-7: clean source produces no findings', () => {
  const result = auditSource([
    {
      path: 'src/clean.ts',
      content: "import { createHash } from 'node:crypto';\n\nexport function digest(value: string): string {\n  return createHash('sha256').update(value).digest('hex');\n}\n",
    },
  ]);
  assert.deepEqual(result.findings, []);
  assert.equal(result.filesScanned, 1);
});

test('SA-8: the same source always produces the same findings', () => {
  const first = auditSource([{ path: 'src/creds.ts', content: DIRTY }]);
  for (let i = 0; i < 25; i += 1) {
    const repeated = auditSource([{ path: 'src/creds.ts', content: DIRTY }]);
    assert.deepEqual(repeated, first);
  }
});

test('SA-9: the audit route audits a repository inside the workspace and refuses one outside it', async () => {
  const repo = path.join(process.env.FACTORY_WORKSPACE_ROOT!, 'project');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'app.ts'), DIRTY);

  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;

  const call = async (body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/bug-detective/audit`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'x-tenant-id': TENANT, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  try {
    const audited = await call({ repo });
    assert.equal(audited.status, 200, JSON.stringify(audited.body));
    const findings = audited.body.audit.findings as Array<{ rule: string; file: string; line: number }>;
    assert.ok(findings.length > 0, 'the route found nothing');
    assert.ok(findings.some((finding) => finding.rule === 'hardcoded-secret'));
    assert.ok(findings.every((finding) => finding.file === 'app.ts'));
    assert.ok(findings.every((finding) => finding.line > 0));

    const outside = await call({ repo: path.join(state, 'outside') });
    assert.equal(outside.status, 403, 'a repository outside the workspace was audited');
    assert.equal(outside.body.code, 'SECURITY_AUDIT_REPO_OUTSIDE_WORKSPACE');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
