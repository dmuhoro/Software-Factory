/**
 * The reviewer's repository architecture rationale (part of the frontier review stage).
 *
 * The reviewer is the read no gate can do: it judges intent. To judge whether a change fits the
 * repository it is pretending to be, it needs the repository's own *stated* architecture — its
 * tracked inventory, manifests, and module boundaries — drawn from git, never from the
 * implementer's word. These tests pin that block: present, grounded in the real tracked files,
 * and honestly truncation-aware.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { repoArchitectureBrief, buildReviewPrompts } from '../src/services/reviewService';
import type { ReviewRequest } from '../src/services/reviewService';

function makeRepo(files: Record<string, string>): { repo: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-arch-'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'loop@test.local']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Loop Test']);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content, 'utf8');
  }
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'initial']);
  return { repo: dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function requestFor(repo: string): ReviewRequest {
  return {
    tenantId: 'review-arch',
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
    isolation: { doctrineRoot: '/d', doctrineDigest: 'sha256:deadbeef', targetRepo: repo, quarantine: [], childEnv: {}, stagedAt: 'now' },
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

test('the review prompt carries the repository architecture rationale block', () => {
  const { repo, cleanup } = makeRepo({
    'package.json': '{"name":"arch-fixture","scripts":{"build":"tsc"}}\n',
    'tsconfig.json': '{}\n',
    'src/lib/core.ts': 'export const core = 1;\n',
    'src/lib/util.ts': 'export const util = 1;\n',
    'README.md': '# Arch fixture\nDescribes the intended design.\n',
    'scripts/check-a.cjs': 'console.log("ok")\n',
  });
  try {
    const { task } = buildReviewPrompts(requestFor(repo));
    assert.match(task, /Repository architecture \(from the tracked inventory and manifests — use it to judge intent\):/, 'the prompt must label the architecture block');
    assert.match(task, /Tracked files: 6/, 'the brief must state the tracked-file count from git');
    assert.match(task, /Top-level structure/, 'the brief must render the top-level inventory');
    assert.match(task, /src \(2\)/, 'the inventory must count files per top-level directory from git, not from a guess');
    assert.match(task, /Manifest excerpts/, 'the brief must excerpt the repository manifests');
    assert.match(task, /"scripts":\{"build":"tsc"\}/, 'the excerpt is the real manifest content');
    assert.match(task, /src\/lib\/core\.ts/, 'the command/source tree must list the actual tracked source files');
    assert.match(task, /README\.md/, 'readme is part of the manifest inventory');
  } finally {
    cleanup();
  }
});

test('the architecture brief counts only what git tracks, not the working tree', () => {
  const { repo, cleanup } = makeRepo({ 'src/a.ts': 'x\n', 'bin/run.ts': 'y\n' });
  try {
    fs.writeFileSync(path.join(repo, 'untracked-bomb.ts'), 'nope\n'); // not committed
    const { text } = repoArchitectureBrief(repo);
    assert.match(text, /Tracked files: 2/, 'the brief must reflect the tracked set, ignoring untracked files');
    assert.doesNotMatch(text, /untracked-bomb/, 'an untracked file must not appear in the architecture brief');
    assert.match(text, /bin \(1\)/, 'bin is inventoried');
  } finally {
    cleanup();
  }
});

test('the architecture brief states its own truncation instead of silently overflowing', () => {
  const bigTree: Record<string, string> = {};
  for (let i = 0; i < 900; i += 1) bigTree[`m${i}/index.ts`] = 'export const x = 1;\n';
  bigTree['package.json'] = JSON.stringify({ name: 'big', scripts: { build: 'tsc' } });
  const { repo, cleanup } = makeRepo(bigTree);
  try {
    const result = repoArchitectureBrief(repo);
    assert.equal(result.truncated, true, 'a 900-directory tree must exceed the brief cap and say so');
    assert.match(result.text, /\[\.\.\. architecture brief truncated at \d+ characters\]/, 'the truncation must be explicit, never silent');
  } finally {
    cleanup();
  }
});

test('a missing repository reports an honest refusal, not a fabricated inventory', () => {
  const result = repoArchitectureBrief('/nonexistent/definitely-missing-repo');
  assert.match(result.text, /could not be read/, 'the brief must say it could not read the repository');
  assert.equal(result.truncated, false);
});

test('the reviewer rules call out architectural-consistency as a rejection ground', () => {
  const { repo, cleanup } = makeRepo({ 'README.md': '# x\n' });
  try {
    const { system } = buildReviewPrompts(requestFor(repo));
    assert.match(system, /contradicts the repository's stated architecture/, 'the reviewer must be told to reject changes that fight the stated architecture');
    assert.match(system, /The repository architecture brief in the task is ground truth from the repository itself/, 'the reviewer must be told to trust the brief, not the implementer');
  } finally {
    cleanup();
  }
});