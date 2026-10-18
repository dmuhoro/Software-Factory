/**
 * The PR preflight (Sprint 34, WP-5).
 *
 * Two things are proved here. First, the preflight fails closed on this repository's real
 * configuration, because PR mode is off and no token is wired — a preflight that passes on an
 * unconfigured path is the false confidence this repository forbids. Second, when the
 * configuration *is* complete it passes **without opening a pull request**: the token it is given
 * is deliberately invalid, so any request to the real API would fail with 401. A green result
 * therefore proves the rehearsal made no socket.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-pr-preflight-'));
const projectRoot = process.cwd();
const cli = path.join(projectRoot, 'scripts', 'verify-pr-config.ts');

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
    encoding: 'utf8',
  });
}

function scratchRepo(): string {
  const repo = fs.mkdtempSync(path.join(root, 'repo-'));
  fs.writeFileSync(path.join(repo, '.env'), 'PR_GITHUB_TOKEN=placeholder\n');
  sh(repo, 'init', '-q');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-qm', 'initial');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/scratch.git');
  return repo;
}
function sh(repo: string, ...args: string[]): void {
  git(repo, ...args);
  if (args[0] === 'init') fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n');
}

function workspaceWithDoctrine(overrides: Record<string, unknown>): { cwd: string; repo: string } {
  const cwd = fs.mkdtempSync(path.join(root, 'ws-'));
  fs.mkdirSync(path.join(cwd, 'doctrine'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, 'doctrine', 'loop.json'),
    `${JSON.stringify({
      pullRequest: {
        enabled: true,
        mode: 'github',
        targetBranch: 'main',
        baseBranch: 'main',
        github: { tokenSecret: 'PR_GITHUB_TOKEN', baseUrl: 'https://api.github.com' },
        ...overrides,
      },
    }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(cwd, '.gitignore'), '.env\n');
  return { cwd, repo: scratchRepo() };
}

function runPreflight(cwd: string, args: string[], env: Record<string, string> = {}): { status: number; out: string } {
  try {
    const out = execFileSync('npx', ['tsx', cli, ...args], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FACTORY_ALLOWED_SECRET_REFS: '', PR_GITHUB_TOKEN: '', ...env },
    });
    return { status: 0, out };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? 1, out: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

test('this repository fails the preflight: PR mode is off and no token is wired', () => {
  const result = runPreflight(projectRoot, []);
  assert.equal(result.status, 1);
  assert.match(result.out, /FAIL {2}pullRequest\.enabled is true/);
  assert.match(result.out, /Refusing/);
});

test('a complete configuration passes with an invalid token, proving no request was made', () => {
  const { cwd, repo } = workspaceWithDoctrine({});
  const result = runPreflight(cwd, ['--repo', repo, '--owner', 'acme/scratch'], {
    FACTORY_ALLOWED_SECRET_REFS: 'PR_GITHUB_TOKEN',
    PR_GITHUB_TOKEN: 'definitely-not-a-real-token',
  });
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /PR CONFIG: 14 passed, 0 failed/);
  assert.match(result.out, /Opening the pull request remains an operator action/);
  // The value itself never appears in the output.
  assert.ok(!result.out.includes('definitely-not-a-real-token'), 'the preflight must never print the secret');
});

test('an unallowlisted reference is refused by name', () => {
  const { cwd, repo } = workspaceWithDoctrine({});
  const result = runPreflight(cwd, ['--repo', repo], {
    FACTORY_ALLOWED_SECRET_REFS: 'SOME_OTHER_REF',
    PR_GITHUB_TOKEN: 'x',
  });
  assert.equal(result.status, 1);
  assert.match(result.out, /FAIL {2}the reference is allowlisted/);
  assert.match(result.out, /PR_GITHUB_TOKEN is not allowed/);
});

test('an allowlisted but unmounted reference is refused', () => {
  const { cwd, repo } = workspaceWithDoctrine({});
  const result = runPreflight(cwd, ['--repo', repo], { FACTORY_ALLOWED_SECRET_REFS: 'PR_GITHUB_TOKEN' });
  assert.equal(result.status, 1);
  assert.match(result.out, /FAIL {2}the reference resolves to a mounted value/);
});

test('a host other than GitHub or loopback is refused', () => {
  const { cwd, repo } = workspaceWithDoctrine({ github: { tokenSecret: 'PR_GITHUB_TOKEN', baseUrl: 'https://exfil.example.com' } });
  const result = runPreflight(cwd, ['--repo', repo], { FACTORY_ALLOWED_SECRET_REFS: 'PR_GITHUB_TOKEN', PR_GITHUB_TOKEN: 'x' });
  assert.equal(result.status, 1);
  assert.match(result.out, /FAIL {2}the host is api\.github\.com or a loopback stub/);
});

test('a declared scope that does not match the remote is refused', () => {
  const { cwd, repo } = workspaceWithDoctrine({});
  const result = runPreflight(cwd, ['--repo', repo, '--owner', 'acme/other'], {
    FACTORY_ALLOWED_SECRET_REFS: 'PR_GITHUB_TOKEN', PR_GITHUB_TOKEN: 'x',
  });
  assert.equal(result.status, 1);
  assert.match(result.out, /FAIL {2}the remote matches the declared scope/);
});
