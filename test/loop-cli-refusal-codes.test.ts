/**
 * Sprint 22 finding (a): a run that refuses to start must say *why* in a machine-readable
 * code. Before this test, both of the refusals below reached cron as
 *
 *     INTERNAL_ERROR: The service could not complete this request. Quote the incident id ...
 *     incident <uuid>
 *
 * which names nothing and points at no log (the CLI writes no log keyed by that id). The
 * subject under test is the real CLI an operator runs, not the classifier in isolation: a
 * unit test of `classifyApiError` would pass while the CLI still printed the wrong line.
 *
 * Both scenarios are the real cases that exposed the finding:
 *   1. the doctrine root sits inside the target repository (running the loop against a repo
 *      that would supply the rules it is judged by) — refusals in sprint 22's self-dogfood;
 *   2. a task document with two command lines under `## Verification` — the exact document
 *      shape that was refused during the sprint 22 dogfood.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLI = path.join(ROOT, 'scripts', 'run-factory-loop.ts');
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-loop-refusal-'));

function gitInit(dir: string): void {
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'loop@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Loop Fixture']);
  execFileSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
}

/** Runs the CLI the way cron would: one process, no TTY, a fresh ledger, and no test env. */
function runCli(repo: string, task: string, extraEnv: Record<string, string>): { status: number | null; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // The refusal must not depend on a developer's shell having relaxed the guard. Strip
  // the base environment first, then let the scenario set what it needs.
  delete env.FACTORY_ALLOW_SELF_DOCTRINE;
  delete env.FACTORY_DOCTRINE_ROOT;
  delete env.FACTORY_DOCTRINE_SHA256;
  Object.assign(env, extraEnv);
  const result = spawnSync(process.execPath, ['--import', 'tsx', CLI, '--repo', repo, '--task', task], { env, encoding: 'utf8' });
  return { status: result.status, stderr: result.stderr ?? '' };
}

function assertNamedRefusal(stderr: string, code: string): void {
  assert.ok(stderr.includes(`${code}:`), `the named code must be on stderr, got:\n${stderr}`);
  assert.ok(!stderr.includes('INTERNAL_ERROR'), `the refusal degraded to INTERNAL_ERROR:\n${stderr}`);
  assert.ok(!stderr.includes('incident '), `an incident id that resolves to no log is not a reason:\n${stderr}`);
}

test('CLI: a doctrine root inside the target is refused by name, not as INTERNAL_ERROR', () => {
  const repo = path.join(STATE, 'self-doctrine');
  fs.mkdirSync(repo);
  gitInit(repo);
  // A complete, valid doctrine placed *inside* the target: the guard is what refuses it,
  // not a missing or malformed rulebook.
  fs.cpSync(path.join(ROOT, 'doctrine'), path.join(repo, 'doctrine'), { recursive: true });
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'doctrine copy']);
  const task = path.join(STATE, 'ok.md');
  fs.writeFileSync(task, '# Task: t\n\n## Goal\ngoal\n\n## Verification\nnode -e "process.exit(0)"\n\n## Milestones\n### M1: m\ntype: fix\nindependent: true\n- [ ] criterion\n');

  const { status, stderr } = runCli(repo, task, {
    FACTORY_DATA_DIR: path.join(STATE, 'data-self-doctrine'),
    FACTORY_DOCTRINE_ROOT: path.join(repo, 'doctrine'),
  });
  assert.equal(status, 1, `a refusal to start exits 1; got ${status}\n${stderr}`);
  assertNamedRefusal(stderr, 'DOCTRINE_ROOT_INSIDE_TARGET_REPOSITORY');
});

test('CLI: an invalid task document is refused by name, not as INTERNAL_ERROR', () => {
  const repo = path.join(STATE, 'bad-document');
  fs.mkdirSync(repo);
  gitInit(repo);
  execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init']);
  // The real case: two command lines under `## Verification`, which the parser refuses.
  const task = path.join(STATE, 'bad.md');
  fs.writeFileSync(task, '# Task: t\n\n## Goal\ngoal\n\n## Verification\nnode -e "console.log(1)"\nnode -e "console.log(2)"\n\n## Milestones\n### M1: m\ntype: fix\nindependent: true\n- [ ] criterion\n');

  const { status, stderr } = runCli(repo, task, { FACTORY_DATA_DIR: path.join(STATE, 'data-bad-document') });
  assert.equal(status, 1, `a refusal to start exits 1; got ${status}\n${stderr}`);
  assertNamedRefusal(stderr, 'TASK_DOCUMENT_INVALID');
});