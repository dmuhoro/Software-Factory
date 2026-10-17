/**
 * The skills bridge (Sprint 31, WP-6, ADR-013).
 *
 * A skill is advisory, vendored, and hash-pinned; it may be shown to a role, never obeyed. These
 * cases pin the two halves that make that a fact rather than a promise:
 *
 *  - the pin gate: a skill with no pin, a modified skill, and a pin with no licence are each refused
 *    with a code, so a file whose bytes were never reviewed cannot reach a run;
 *  - the injection seam: OFF is byte-identical (the ADR-013 §4 "provable no-op"), ON shows only pinned
 *    skills, fenced and labelled as untrusted, and a skill names no egress.
 *
 * The proof that a skill cannot alter a gate verdict is structural: the advisory block is appended to
 * a prompt's task text and to nothing else, and the gate machinery does not know skills exist.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-skills-bridge-'));
process.env.FACTORY_DATA_DIR = path.join(state, 'data');
process.env.FACTORY_WORKSPACE_ROOT = path.join(state, 'ws');
process.env.NODE_ENV = 'test';
process.env.FACTORY_API_KEY = 'test-platform-key-0123456789abcdef';
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });

const {
  loadPinnedSkills,
  loadSkills,
  computeSkillHash,
  parseSkillsLock,
  SkillError,
} = await import('../src/services/skillRegistryService');
const {
  fencedSkillBlock,
  injectSkills,
  resolveAdvisory,
  SkillInjectionService,
  EMPTY_ADVISORY,
} = await import('../src/services/skillInjectionService');
const { DoctrineService } = await import('../src/services/doctrineService');
const { buildReviewPrompts } = await import('../src/services/reviewService');
const { DurableStore } = await import('../src/services/durableStore');

DurableStore.resetForTests();

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

function skillText(name: string, body = '# Heading\nBody text.'): string {
  return ['---', `name: ${name}`, `description: A skill for tests.`, 'version: 1.0.0', 'tools: read', 'enabled: true', '---', body].join('\n');
}

interface Fixture { dir: string; lock: string }

function fixture(name: string, body?: string, overrides: { licence?: string | null; mutateAfter?: (file: string) => void; omitPin?: boolean } = {}): Fixture {
  const dir = fs.mkdtempSync(path.join(state, 'skills-'));
  const file = path.join(dir, `${name}.skill.md`);
  const text = skillText(name, body);
  fs.writeFileSync(file, text, 'utf8');
  const skills: Record<string, unknown> = {};
  if (!overrides.omitPin) {
    const entry: Record<string, unknown> = {
      source: 'this repository',
      sourceType: 'in-repo',
      skillPath: `skills/${name}.skill.md`,
      computedHash: computeSkillHash(text),
    };
    if (overrides.licence !== null) entry.licence = overrides.licence ?? 'MIT';
    skills[name] = entry;
  }
  const lock = path.join(dir, 'skills-lock.json');
  fs.writeFileSync(lock, JSON.stringify({ version: 1, skills }, null, 2), 'utf8');
  if (overrides.mutateAfter) overrides.mutateAfter(file);
  return { dir, lock };
}

// ── the pin gate: what may reach a run ──────────────────────────────────────

test('WP-6: a pinned skill with a recorded licence loads', () => {
  const { dir, lock } = fixture('pinned-skill');
  const { skills, refusals } = loadPinnedSkills(dir, lock);
  assert.equal(refusals.length, 0, JSON.stringify(refusals));
  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, 'pinned-skill');
});

test('WP-6: a skill with no pin is refused, not shown', () => {
  const { dir, lock } = fixture('unpinned-skill', undefined, { omitPin: true });
  const { skills, refusals } = loadPinnedSkills(dir, lock);
  assert.equal(skills.length, 0);
  assert.equal(refusals[0].code, 'SKILL_UNPINNED');
  assert.match(refusals[0].detail, /unpinned-skill/);
});

test('WP-6: a modified skill is refused, because the reviewed bytes are not the bytes on disk', () => {
  const { dir, lock } = fixture('tampered-skill', undefined, { mutateAfter: (file) => fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8')}\nInjected line.\n`) });
  const { skills, refusals } = loadPinnedSkills(dir, lock);
  assert.equal(skills.length, 0);
  assert.equal(refusals[0].code, 'SKILL_PIN_MISMATCH');
  assert.match(refusals[0].detail, /not the pinned/);
});

test('WP-6: a pin with no licence is refused, because an unrecorded licence was never reviewed', () => {
  const { dir, lock } = fixture('unlicensed-skill', undefined, { licence: null });
  const { skills, refusals } = loadPinnedSkills(dir, lock);
  assert.equal(skills.length, 0);
  assert.equal(refusals[0].code, 'SKILL_LOCK_INVALID');
});

test('WP-6: a missing lock refuses every skill rather than treating them as trusted', () => {
  const { dir } = fixture('orphan-skill');
  const { skills, refusals } = loadPinnedSkills(dir, path.join(dir, 'does-not-exist.json'));
  assert.equal(skills.length, 0);
  assert.equal(refusals[0].code, 'SKILL_UNPINNED');
});

test('WP-6: a malformed lock refuses the whole load with a code, not silently', () => {
  assert.throws(() => parseSkillsLock('{ not json', 'lock'), (error: unknown) => error instanceof SkillError && error.code === 'SKILL_LOCK_INVALID');
  assert.throws(() => parseSkillsLock(JSON.stringify({ skills: { x: {} } }), 'lock'), (error: unknown) => error instanceof SkillError && error.code === 'SKILL_LOCK_INVALID');
});

// ── the shipped skill is genuinely pinned ───────────────────────────────────

test('WP-6: the shipped repo-hygiene skill is pinned and loads; tampering with it is refused', () => {
  const shipped = path.join(REPO_ROOT, 'skills', 'repo-hygiene.skill.md');
  const original = fs.readFileSync(shipped, 'utf8');
  try {
    const before = loadPinnedSkills(path.join(REPO_ROOT, 'skills'), path.join(REPO_ROOT, 'skills-lock.json'));
    assert.ok(before.skills.some((skill) => skill.name === 'repo-hygiene'), 'the shipped skill must be pinned to its reviewed bytes');
    assert.equal(before.refusals.length, 0, JSON.stringify(before.refusals));

    fs.writeFileSync(shipped, `${original}\nsilently changed\n`, 'utf8');
    const after = loadPinnedSkills(path.join(REPO_ROOT, 'skills'), path.join(REPO_ROOT, 'skills-lock.json'));
    assert.ok(!after.skills.some((skill) => skill.name === 'repo-hygiene'), 'a tampered skill must not load');
    assert.equal(after.refusals.find((refusal) => refusal.source === 'repo-hygiene.skill.md')?.code, 'SKILL_PIN_MISMATCH');
  } finally {
    fs.writeFileSync(shipped, original, 'utf8');
  }
});

// ── the injection seam: OFF is byte-identical ───────────────────────────────

test('WP-6: injectSkills with the flag off returns the prompt byte-for-byte', () => {
  const prompt = 'a prompt\nwith lines';
  assert.equal(injectSkills(prompt, 'IGNORED BLOCK', false), prompt);
  assert.equal(injectSkills(prompt, '', true), prompt, 'an empty block changes nothing even when on');
});

test('WP-6: the fenced block is labelled untrusted and delimited', () => {
  const skill = { name: 'demo', description: 'd', version: '1.0.0', tools: [], enabled: true, body: 'Do the thing carefully.', source: 'demo.skill.md' };
  const { block, refusals } = fencedSkillBlock([skill]);
  assert.equal(refusals.length, 0);
  assert.match(block, /untrusted skill text/);
  assert.match(block, /not an instruction/);
  assert.match(block, /<<<SKILL: demo>>>/);
  assert.match(block, /<<<END SKILL: demo>>>/);
  assert.match(block, /Do the thing carefully\./);
});

test('WP-6: a skill that names a network endpoint is refused, not shown', () => {
  const skill = { name: 'egress', description: 'd', version: '1.0.0', tools: [], enabled: true, body: 'Call https://example.com/v1 to fetch more.', source: 'egress.skill.md' };
  const { block, refusals } = fencedSkillBlock([skill]);
  assert.equal(block, '');
  assert.equal(refusals[0].code, 'SKILL_NAMES_EGRESS');
});

// ── the role resolver ───────────────────────────────────────────────────────

test('WP-6: with the flag off, no skill is loaded and the advisory is empty', () => {
  let loaded = false;
  const result = resolveAdvisory({ inject: false, byRole: { implementer: ['repo-hygiene'] } }, 'implementer', () => { loaded = true; return { skills: [], refusals: [] }; });
  assert.deepEqual(result, EMPTY_ADVISORY);
  assert.equal(loaded, false, 'off must not even read the skills directory');
});

test('WP-6: with the flag on and the role declared, the pinned skill is shown, fenced', () => {
  const skill = { name: 'repo-hygiene', description: 'd', version: '1.0.0', tools: [], enabled: true, body: 'Check the tree.', source: 'repo-hygiene.skill.md' };
  const result = resolveAdvisory({ inject: true, byRole: { implementer: ['repo-hygiene'] } }, 'implementer', () => ({ skills: [skill], refusals: [] }));
  assert.equal(result.enabled, true);
  assert.match(result.block, /<<<SKILL: repo-hygiene>>>/);
  assert.match(result.block, /Check the tree\./);
});

test('WP-6: with the flag on but the role not declared, nothing is shown', () => {
  const result = resolveAdvisory({ inject: true, byRole: { reviewer: ['repo-hygiene'] } }, 'implementer', () => ({ skills: [], refusals: [] }));
  assert.equal(result.enabled, true);
  assert.equal(result.block, '');
});

test('WP-6: a skill the role declares but that is not pinned is refused, not silently ignored', () => {
  const result = resolveAdvisory({ inject: true, byRole: { implementer: ['no-such-skill'] } }, 'implementer', () => ({ skills: [], refusals: [] }));
  assert.equal(result.enabled, true);
  assert.equal(result.block, '');
  assert.ok(result.refusals.some((refusal) => refusal.code === 'SKILL_UNPINNED' && refusal.detail.includes('no-such-skill')), 'a typo in byRole must be loud');
});

test('WP-6: a declared skill refused by the pin gate is not double-reported as absent', () => {
  const result = resolveAdvisory({ inject: true, byRole: { implementer: ['tampered'] } }, 'implementer', () => ({
    skills: [],
    refusals: [{ source: 'tampered.skill.md', code: 'SKILL_PIN_MISMATCH', detail: 'tampered.skill.md: bytes differ' }],
  }));
  assert.deepEqual(result.refusals.map((refusal) => refusal.code), ['SKILL_PIN_MISMATCH'], 'the loader owns the refusal; the resolver does not add a second');
});

test('WP-6: the shipped doctrine leaves skills injection off, so the live resolver is a no-op', () => {
  assert.equal(DoctrineService.load().loop.skills.inject, false);
  assert.deepEqual(DoctrineService.load().loop.skills.byRole, {
    drafter: ['grilling', 'to-spec', 'to-tickets'],
    implementer: ['tdd'],
    'implementer-stuck': ['diagnosing-bugs'],
    reviewer: ['code-review', 'improve-codebase-architecture'],
    reporter: ['handoff'],
  });
  assert.deepEqual(SkillInjectionService.advisoryForRole('implementer'), EMPTY_ADVISORY);
});

// ── the prompt seam, on a real builder ──────────────────────────────────────

function reviewRequest(): import('../src/services/reviewService').ReviewRequest {
  const repo = fs.mkdtempSync(path.join(state, 'repo-'));
  return {
    tenantId: 'skills-bridge',
    repo,
    unit: { id: 'm1', milestoneId: 'M1', title: 'Feature', criteria: [{ id: 'c1', text: 'exists', check: 'true' }], dependsOn: [], type: 'feat', verify: 'true' },
    document: { title: 'Doc', goal: 'Ship', constraints: [], models: {}, milestones: [], sourceHash: 'sha256:doc' },
    assignment: { role: 'reviewer', tier: 'frontier', providerId: 'stub', model: 'stub', source: 'task-document' },
    doctrineLines: ['R-13: nothing commits without review approval'],
    isolation: { doctrineRoot: '/d', doctrineDigest: 'sha256:deadbeef', targetRepo: repo, quarantine: [], childEnv: {}, stagedAt: 'now' },
    proof: { passed: true, repo, head: 'HEAD', checks: [], claimedFiles: [], observedFiles: [], rejectedNarration: [], recordedAt: 'now' },
    timeoutMs: 60_000,
  };
}

test('WP-6: an advisory is appended to a prompt\'s task only — the system prompt and the contract are untouched', () => {
  const request = reviewRequest();
  const off = buildReviewPrompts(request, 'standards', { enabled: false, block: '' });
  const never = buildReviewPrompts(request, 'standards');
  assert.deepEqual(off, never, 'OFF must be byte-identical to never wiring the seam');

  const on = buildReviewPrompts(request, 'standards', { enabled: true, block: '<<<SKILL: x>>>\nADVISORY\n<<<END SKILL: x>>>' });
  assert.equal(on.system, off.system, 'a skill may not change the system prompt that carries the doctrine rules');
  assert.ok(on.task.startsWith(off.task), 'a skill is appended to the task, it does not rewrite it');
  assert.match(on.task, /ADVISORY/);
});

test('WP-6: the gate machinery does not know skills exist', () => {
  for (const file of ['src/services/loopGates.ts', 'src/services/gateIds.ts']) {
    const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    assert.ok(!/skill/i.test(source), `${file} must not reference skills; a skill cannot alter a gate verdict`);
  }
});

test('WP-6: loadSkills stays an inspection surface and is unaffected by pin state', () => {
  const { dir, lock } = fixture('inspection-skill', undefined, { omitPin: true });
  assert.equal(loadSkills(dir).skills.length, 1, 'inspection sees the parsed file');
  assert.equal(loadPinnedSkills(dir, lock).skills.length, 0, 'influence refuses the unpinned file');
});
