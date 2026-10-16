/**
 * The declarative skills registry (Sprint 30, WP-2).
 *
 * A skill is a governed file, not a TypeScript release. These cases pin the strict format: a valid
 * file parses, and every shape the registry does not fully understand — an unknown field, a missing
 * field, a bad version, a bad name, a duplicate, an empty body — is refused with a code. A refused
 * file is reported, never silently dropped.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-skills-registry-'));
process.env.FACTORY_DATA_DIR = path.join(state, 'data');
process.env.FACTORY_WORKSPACE_ROOT = path.join(state, 'ws');
process.env.NODE_ENV = 'test';
process.env.FACTORY_API_KEY = 'test-platform-key-0123456789abcdef';
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });

const { parseSkillFile, loadSkills, loadPinnedSkills, computeSkillHash, SkillError, resolveSkillsDir } = await import('../src/services/skillRegistryService');
const { DurableStore } = await import('../src/services/durableStore');
const { TenantService } = await import('../src/services/tenantService');
const { resetRateLimiterForTests } = await import('../src/api/middleware/rateLimiter');
const { apiRouter } = await import('../src/api');
const { IndustryNiche, TenantStatus, TenantSubscriptionTier } = await import('../src/models/tenant');

DurableStore.resetForTests();

const VALID = [
  '---',
  'name: sample-skill',
  'description: A sample skill for tests.',
  'version: 1.2.3',
  'tools: read, write',
  'enabled: true',
  '---',
  '# Sample',
  'Body text.',
].join('\n');

function code(error: unknown): string | undefined {
  return error instanceof SkillError ? error.code : undefined;
}

// ── the parser ──────────────────────────────────────────────────────────────

test('a well-formed skill file parses', () => {
  const skill = parseSkillFile(VALID, 'sample.skill.md');
  assert.equal(skill.name, 'sample-skill');
  assert.equal(skill.version, '1.2.3');
  assert.deepEqual(skill.tools, ['read', 'write']);
  assert.equal(skill.enabled, true);
  assert.match(skill.body, /Body text/);
  assert.equal(skill.source, 'sample.skill.md');
});

test('an unknown field is refused', () => {
  assert.throws(() => parseSkillFile(VALID.replace('enabled: true', 'enabled: true\nprivileges: root'), 'x.skill.md'), (e) => code(e) === 'SKILL_UNKNOWN_FIELD');
});

test('a missing required field is refused', () => {
  assert.throws(() => parseSkillFile(VALID.replace('version: 1.2.3\n', ''), 'x.skill.md'), (e) => code(e) === 'SKILL_MISSING_FIELD');
  assert.throws(() => parseSkillFile('---\ndescription: d\nversion: 1.0.0\n---\nbody\n', 'x.skill.md'), (e) => code(e) === 'SKILL_MISSING_FIELD');
});

test('a bad version, a bad name, a duplicate field and an empty body are each refused', () => {
  assert.throws(() => parseSkillFile(VALID.replace('1.2.3', 'v1.2'), 'x.skill.md'), (e) => code(e) === 'SKILL_INVALID_VERSION');
  assert.throws(() => parseSkillFile(VALID.replace('sample-skill', 'Sample Skill'), 'x.skill.md'), (e) => code(e) === 'SKILL_INVALID_NAME');
  assert.throws(() => parseSkillFile(VALID.replace('description: A sample skill for tests.', 'description: first\ndescription: second'), 'x.skill.md'), (e) => code(e) === 'SKILL_DUPLICATE_FIELD');
  assert.throws(() => parseSkillFile('---\nname: ok\ndescription: d\nversion: 1.0.0\n---\n', 'x.skill.md'), (e) => code(e) === 'SKILL_EMPTY_BODY');
});

test('missing frontmatter and an invalid field line are refused', () => {
  assert.throws(() => parseSkillFile('no frontmatter here', 'x.skill.md'), (e) => code(e) === 'SKILL_MISSING_FRONTMATTER');
  assert.throws(() => parseSkillFile(VALID.replace('enabled: true', 'enabled:: true'), 'x.skill.md'), (e) => code(e) === 'SKILL_INVALID_FIELD');
});

// ── the loader ──────────────────────────────────────────────────────────────

test('a directory loads its valid skills and reports the refused ones', () => {
  const dir = fs.mkdtempSync(path.join(state, 'skills-'));
  fs.writeFileSync(path.join(dir, 'good.skill.md'), VALID);
  fs.writeFileSync(path.join(dir, 'bad.skill.md'), '---\nname: bad\nunknown: 1\n---\nbody\n');
  fs.writeFileSync(path.join(dir, 'ignored.txt'), 'not a skill');
  const { skills, refusals } = loadSkills(dir);
  assert.equal(skills.length, 1, 'only the valid skill is loaded');
  assert.equal(skills[0].name, 'sample-skill');
  assert.equal(refusals.length, 1, 'the refused file is reported');
  assert.equal(refusals[0].code, 'SKILL_UNKNOWN_FIELD');
  assert.equal(refusals[0].source, 'bad.skill.md');
});

test('a missing skills directory is empty, not an error', () => {
  const { skills, refusals } = loadSkills(path.join(state, 'does-not-exist'));
  assert.deepEqual(skills, []);
  assert.deepEqual(refusals, []);
});

test('the shipped skills directory loads the example skill', () => {
  const { skills, refusals } = loadSkills(resolveSkillsDir());
  assert.deepEqual(refusals, [], 'the shipped skills must all be valid');
  assert.ok(skills.some((skill) => skill.name === 'repo-hygiene'), 'the example skill must load');
});

// ── the vendored set (Sprint 33, WP-1) ──────────────────────────────────────

const VENDORED = ['code-review', 'diagnosing-bugs', 'grilling', 'handoff', 'improve-codebase-architecture', 'tdd', 'to-spec', 'to-tickets'];

test('WP-1: every vendored skill is pinned, loads, and names no egress endpoint', () => {
  const { skills, refusals } = loadPinnedSkills(resolveSkillsDir());
  assert.deepEqual(refusals, [], 'every shipped skill must be pinned and match its pin');
  const loaded = new Set(skills.map((skill) => skill.name));
  for (const name of VENDORED) assert.ok(loaded.has(name), `${name} must load from the shipped skills directory`);
  const EGRESS = /\b(?:https?|wss?|ftp):\/\//i;
  for (const name of VENDORED) {
    const body = fs.readFileSync(path.join(resolveSkillsDir(), `${name}.skill.md`), 'utf8');
    assert.ok(!EGRESS.test(body), `${name}.skill.md must name no egress endpoint`);
  }
});

test('WP-1: the pin gate refuses a vendored file whose bytes were changed', () => {
  const dir = fs.mkdtempSync(path.join(state, 'vendored-'));
  for (const entry of fs.readdirSync(resolveSkillsDir())) {
    if (entry.endsWith('.skill.md')) fs.copyFileSync(path.join(resolveSkillsDir(), entry), path.join(dir, entry));
  }
  const target = path.join(dir, 'tdd.skill.md');
  const original = fs.readFileSync(target, 'utf8');
  assert.equal(computeSkillHash(original), JSON.parse(fs.readFileSync(path.resolve('skills-lock.json'), 'utf8')).skills.tdd.computedHash);
  fs.writeFileSync(target, `${original}\nA smuggled trailing line.\n`);

  const { skills, refusals } = loadPinnedSkills(dir, path.resolve('skills-lock.json'));
  assert.ok(refusals.some((refusal) => refusal.code === 'SKILL_PIN_MISMATCH' && refusal.source === 'tdd.skill.md'), 'a changed byte must refuse with SKILL_PIN_MISMATCH');
  assert.ok(!skills.some((skill) => skill.name === 'tdd'), 'the tampered skill must not reach a run');
  assert.ok(skills.some((skill) => skill.name === 'repo-hygiene'), 'untouched skills still load');
});

// ── the route ───────────────────────────────────────────────────────────────

test('GET /api/factory/skills is 401 without a credential and lists the skills with one', async () => {
  const TENANT = 'skills-tenant';
  TenantService.registerTenant({
    id: TENANT, name: 'Skills tenant', niche: IndustryNiche.CUSTOM_B2B,
    tier: TenantSubscriptionTier.PROFESSIONAL, status: TenantStatus.ACTIVE, apiKeyHash: '',
    quota: { maxRequestsPerMinute: 10_000, maxDailyAiTokens: 10_000_000, burstCapacity: 100, storageLimitMb: 1000 },
    customGuardrails: [], encryptionKeyId: 'test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const owner = await TenantService.provisionCredential(TENANT);
  resetRateLimiterForTests();

  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const anonymous = await fetch(`${base}/api/factory/skills`);
    assert.equal(anonymous.status, 401, 'the skills registry must not be served to an unauthenticated caller');

    const response = await fetch(`${base}/api/factory/skills`, { headers: { 'x-api-key': owner.apiKey, 'x-tenant-id': TENANT } });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { status: string; count: number; skills: Array<{ name: string }>; refusals: unknown[] };
    assert.equal(body.status, 'success');
    assert.ok(body.skills.some((skill) => skill.name === 'repo-hygiene'));
    assert.deepEqual(body.refusals, []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
