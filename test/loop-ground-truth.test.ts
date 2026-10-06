/**
 * The verification gate and the commit boundary.
 *
 * The claim under test: a commit happens because commands were executed and git said so — never
 * because something said so. Every case below that expects a refusal observes the refusal; there
 * is no test that asserts a proof "would" pass.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { collectGroundTruth, proofDigest, verifiedStatement } from '../src/services/groundTruthService';
import { buildCommitMessage, commitUnit, pathMatchesPattern, readPackageVersion, slugify, type CommitRequest } from '../src/services/commitService';
import { DoctrineService } from '../src/services/doctrineService';

function makeRepo(): { repo: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-gt-'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'loop@test.local']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Loop Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'initial']);
  return { repo: dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const loop = DoctrineService.load().loop;

function request(repo: string, proof: ReturnType<typeof collectGroundTruth>, overrides: Partial<CommitRequest> = {}): CommitRequest {
  return {
    repo,
    type: 'feat',
    scope: 'audit',
    title: 'Add the audit route',
    proof,
    unitId: 'M1',
    attempt: 1,
    models: [{ role: 'implementer', tier: 'cheap', providerId: 'local', model: 'qwen2.5-coder:14b', source: 'doctrine' }],
    packageVersion: readPackageVersion(repo),
    refusePathPatterns: loop.commit.refusePathPatterns,
    requireGroundTruth: loop.commit.requireGroundTruth,
    requireProvenanceFooter: loop.commit.requireProvenanceFooter,
    subjectMaxLength: loop.commit.subjectMaxLength,
    ...overrides,
  };
}

test('doctrine itself demands a proof and a provenance footer before any commit', () => {
  assert.equal(loop.commit.requireGroundTruth, true, 'the requireGroundTruth flag is on in doctrine/loop.json');
  assert.equal(loop.commit.requireProvenanceFooter, true);
  assert.equal(loop.verification.acceptNarratedEvidence, false, 'narrated evidence is never acceptable');
  assert.equal(loop.attempt.maxPerUnit, 3);
});

test('a command that exits non-zero fails the proof, and the statement says which command', () => {
  const { repo, cleanup } = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'route.ts'), 'export const route = 1;\n');
    const proof = collectGroundTruth({
      repo,
      claimedFiles: ['route.ts'],
      requireNonEmptyDiff: true,
      commands: [
        { id: 'good', command: 'node -e "process.exit(0)"' },
        { id: 'bad', command: 'node -e "process.exit(3)"' },
      ],
      narratedClaims: ['the test suite passes and coverage is 100%'],
      timeoutMs: 30_000,
    });

    assert.equal(proof.passed, false, 'a non-zero exit fails the whole proof');
    assert.equal(proof.checks.find((item) => item.id === 'cmd:good')?.passed, true);
    assert.equal(proof.checks.find((item) => item.id === 'cmd:bad')?.passed, false);
    assert.equal(proof.checks.find((item) => item.id === 'cmd:bad')?.exitCode, 3);

    const statement = verifiedStatement(proof);
    assert.match(statement, /node -e "process\.exit\(3\)" \(exit 3\)/, 'the failed command is named with its exit code');
    assert.match(statement, /Narration rejected: 1 claim/);
    assert.equal(proof.rejectedNarration.length, 1, 'the narration is recorded');

    assert.throws(() => commitUnit(request(repo, proof)), /^Error: GROUND_TRUTH_REQUIRED/, 'a failed proof is refused a commit');
    const log = execFileSync('git', ['-C', repo, 'log', '--oneline'], { encoding: 'utf8' });
    assert.equal(log.trim().split('\n').length, 1, 'HEAD did not move');
  } finally {
    cleanup();
  }
});

test('a claimed file that was not actually changed fails the proof', () => {
  const { repo, cleanup } = makeRepo();
  try {
    const proof = collectGroundTruth({ repo, claimedFiles: ['route.ts'], timeoutMs: 30_000 });
    const check = proof.checks.find((item) => item.id === 'diff:claimed:route.ts');
    assert.equal(check?.passed, false, 'the claimed file does not exist');
    assert.match(check?.outputTail ?? '', /does not exist/);
    assert.equal(proof.passed, false);

    fs.writeFileSync(path.join(repo, 'route.ts'), 'export const route = 1;\n');
    const second = collectGroundTruth({ repo, claimedFiles: ['route.ts'], timeoutMs: 30_000 });
    assert.equal(second.checks.find((item) => item.id === 'diff:claimed:route.ts')?.passed, true);

    fs.writeFileSync(path.join(repo, 'route.ts'), 'export const route = 2;\n');
    const third = collectGroundTruth({ repo, claimedFiles: ['route.ts'], timeoutMs: 30_000 });
    assert.equal(third.checks.find((item) => item.id === 'diff:claimed:route.ts')?.passed, true, 'the edit is still observed');
  } finally {
    cleanup();
  }
});

test('an empty diff fails when doctrine demands a non-empty diff', () => {
  const { repo, cleanup } = makeRepo();
  try {
    const proof = collectGroundTruth({ repo, requireNonEmptyDiff: true, timeoutMs: 30_000 });
    assert.equal(proof.passed, false, 'an untouched tree is not a change');
    assert.match(proof.checks.find((item) => item.id === 'diff:non-empty')?.outputTail ?? '', /identical to HEAD/);
  } finally {
    cleanup();
  }
});

test('command output becomes a digest, not a claim that can be edited later', () => {
  const { repo, cleanup } = makeRepo();
  try {
    const proof = collectGroundTruth({ repo, commands: [{ id: 'suite', command: 'node -e "console.log(247 passing); process.exit(0)"' }], timeoutMs: 30_000 });
    const check = proof.checks.find((item) => item.id === 'cmd:suite');
    assert.match(check?.outputDigest ?? '', /^sha256:[0-9a-f]{64}$/);
    assert.match(check?.outputTail ?? '', /247 passing/, 'a human still gets the tail');
    assert.equal(proofDigest(proof).startsWith('sha256:'), true);
    assert.equal(proofDigest(proof), proofDigest(collectGroundTruth({ repo, commands: [{ id: 'suite', command: 'node -e "console.log(247 passing); process.exit(0)"' }], timeoutMs: 30_000 })), 'the digest is a function of what ran, not of the clock');
  } finally {
    cleanup();
  }
});

test('a green run commits, and the message carries the proof and the provenance footer', () => {
  const { repo, cleanup } = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'route.ts'), 'export const route = 1;\n');
    fs.writeFileSync(path.join(repo, 'check.sh'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(repo, 'check.sh'), 0o755);
    execFileSync('git', ['-C', repo, 'add', '-A']);

    const proof = collectGroundTruth({
      repo,
      claimedFiles: ['route.ts', 'check.sh'],
      requireNonEmptyDiff: true,
      commands: [{ id: 'suite', command: 'sh check.sh' }],
      timeoutMs: 30_000,
    });
    assert.equal(proof.passed, true, `expected a green proof: ${proof.checks.map((item) => `${item.id}=${item.passed}`).join(',')}`);

    const result = commitUnit(request(repo, proof));
    assert.match(result.sha, /^[0-9a-f]{40}$/);
    assert.match(result.subject, /^feat\(audit\): /);
    assert.ok(result.subject.length <= loop.commit.subjectMaxLength, 'the subject respects doctrine');

    assert.match(result.message, /Verified: sh check\.sh \(exit 0\)/, 'the body names what actually ran');
    assert.ok(result.message.includes(`Proof: ${proofDigest(proof)}`), 'the body carries the proof digest');
    assert.match(result.message, /AI-Assisted: implementer=local\/qwen2\.5-coder:14b/, 'the model that made the change is named');
    assert.match(result.message, /loop=software-factory\//, 'the loop version is named');
    assert.ok(result.files.includes('route.ts'));

    const committedBody = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%B'], { encoding: 'utf8' });
    assert.match(committedBody, /AI-Assisted:/, 'CONSTITUTION Art. IV.3: the footer is in git, not just in the return value');
    assert.match(committedBody, /Ground truth: \d+\/\d+ checks passed/);

    // The tree is clean afterwards: what was verified is what was committed.
    const status = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' });
    assert.equal(status.trim(), '', 'nothing left behind after the commit');
  } finally {
    cleanup();
  }
});

test('a credential-shaped path is refused, and the operator keeps their file', () => {
  const { repo, cleanup } = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, '.env'), 'API_KEY=supersecretvalue\n');
    const proof = collectGroundTruth({ repo, requireNonEmptyDiff: true, timeoutMs: 30_000 });
    assert.equal(proof.passed, true, 'the proof itself is green; the refusal is about what is in it');

    assert.throws(() => commitUnit(request(repo, proof)), /^Error: SECRET_PATH_REFUSED/);
    assert.equal(fs.existsSync(path.join(repo, '.env')), true, 'the file was not deleted');
    const status = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' });
    assert.match(status, /\?+ \.env/, 'unstaged: the refusal did not discard the work');
    const log = execFileSync('git', ['-C', repo, 'log', '--oneline'], { encoding: 'utf8' });
    assert.equal(log.trim().split('\n').length, 1, 'nothing was committed');

    // The same file, renamed to a name doctrine does not list, is still caught by content.
    fs.rmSync(path.join(repo, '.env'));
    fs.writeFileSync(path.join(repo, 'config.ts'), "export const key = 'sk-abcdefghijklmnopqrstuvwx123456';\n");
    const contentProof = collectGroundTruth({ repo, requireNonEmptyDiff: true, timeoutMs: 30_000 });
    assert.throws(() => commitUnit(request(repo, contentProof)), /^Error: SECRET_CONTENT_REFUSED/, 'the pattern looks at content, not just names');
    const after = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' });
    assert.ok(!after.startsWith('A '), 'the index was reset after the refusal');
  } finally {
    cleanup();
  }
});

test('a unit that changes nothing is refused rather than committed empty', () => {
  const { repo, cleanup } = makeRepo();
  try {
    const proof = collectGroundTruth({ repo, timeoutMs: 30_000 });
    assert.throws(() => commitUnit(request(repo, proof)), /^Error: (GROUND_TRUTH_REQUIRED|NOTHING_STAGED)/);
    const log = execFileSync('git', ['-C', repo, 'log', '--oneline'], { encoding: 'utf8' });
    assert.equal(log.trim().split('\n').length, 1);
  } finally {
    cleanup();
  }
});

test('the commit body is derived from the proof, so a stale proof cannot describe a new commit', () => {
  const { repo, cleanup } = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
    const proof = collectGroundTruth({ repo, claimedFiles: ['a.ts'], requireNonEmptyDiff: true, commands: [{ id: 'suite', command: 'node -e "process.exit(0)"' }], timeoutMs: 30_000 });
    const built = buildCommitMessage(request(repo, proof), ['a.ts']);
    assert.ok(built.message.includes(`Proof: ${proofDigest(proof)}`), 'the body carries the digest of the proof it was built from');

    const later = collectGroundTruth({ repo, claimedFiles: ['a.ts'], requireNonEmptyDiff: true, commands: [{ id: 'suite', command: 'node -e "process.exit(1)"' }], timeoutMs: 30_000 });
    assert.notEqual(proofDigest(proof), proofDigest(later), 'a different outcome produces a different digest');
    assert.throws(() => commitUnit(request(repo, later)), /GROUND_TRUTH_REQUIRED/);
  } finally {
    cleanup();
  }
});

test('doctrine path patterns match the way gitignore does, including at the root', () => {
  const patterns = loop.commit.refusePathPatterns;
  const refused: Array<[string, string]> = [
    ['.env', '.env'],
    ['config/.env.local', '.env.*'],
    ['certs/server.pem', '*.pem'],
    ['id_rsa', 'id_rsa*'],
    ['infra/terraform.tfstate', '*.tfstate'],
    ['appwrite.json', 'appwrite.json'],
  ];
  for (const [file, pattern] of refused) {
    assert.ok(pathMatchesPattern(file, pattern) || pathMatchesPattern(path.basename(file), pattern), `${file} should match ${pattern}`);
  }
  const allowed = ['src/route.ts', 'docs/README.md', 'src/environments.ts', 'certs/public.crt'];
  for (const file of allowed) {
    assert.equal(patterns.some((pattern) => pathMatchesPattern(file, pattern) || pathMatchesPattern(path.basename(file), pattern)), false, `${file} must not be refused`);
  }
  assert.equal(pathMatchesPattern('src/a/b.ts', 'src/**/b.ts'), true, '** crosses directories');
  assert.equal(slugify('Add The Audit Page!', 40), 'add-the-audit-page');
});
