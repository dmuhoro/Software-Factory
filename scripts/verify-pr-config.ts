#!/usr/bin/env tsx
/**
 * `npm run verify:pr-config -- [--repo <path>] [--owner <owner/name>]`
 *
 * Preflight the pull-request configuration **without opening a pull request**. Opening one writes
 * to a real repository, so the only safe way to rehearse it is to check every precondition the open
 * path checks, plus the two it cannot: that the token is actually mounted under an allowlisted
 * reference, and that the host is the one this product speaks to.
 *
 * It prints the *names* of what it checked and never a secret value: proving a credential is wired
 * means proving the lookup, not printing the key.
 *
 * Exit 0 = every precondition holds; exit 1 = at least one does not; exit 2 = bad invocation.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const GITHUB_API = 'https://api.github.com';
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

function loopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function remoteOwnerRepo(repo: string): string | undefined {
  try {
    const url = execFileSync('git', ['-C', repo, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
    const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
    return match ? `${match[1]}/${match[2]}` : undefined;
  } catch {
    return undefined;
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const repo = path.resolve(value('--repo') ?? process.cwd());
  const expected = value('--owner');

  console.log(`═══ PR configuration preflight (no pull request is opened) ═══`);
  console.log(`  repo: ${repo}`);

  // Read the raw doctrine file, not `DoctrineService.load()`: that service deliberately drops a
  // disabled `pullRequest` block, and a preflight whose job is to show the config *before* it is
  // enabled must still see it. Presence and enablement are separate checks below.
  const doctrineFile = path.resolve('doctrine', 'loop.json');
  let config: any;
  try {
    const raw = JSON.parse(fs.readFileSync(doctrineFile, 'utf8')) as Record<string, unknown>;
    config = (raw.pullRequest ?? undefined) as any;
  } catch (error) {
    check(`doctrine loads (${doctrineFile})`, false, (error as Error).message);
    process.exit(1);
  }

  check('loop.pullRequest is declared', Boolean(config));
  if (!config) { console.log(`\n═══ ${passed} passed, ${failed} failed ═══`); process.exit(1); }

  check('pullRequest.enabled is true (an open path that is off proves nothing)', config.enabled === true);
  check('pullRequest.mode is github', config.mode === 'github', `mode is ${String(config.mode)}`);
  check('target and base branch are named', Boolean(config.targetBranch) && Boolean(config.baseBranch));

  const ref = config.github?.tokenSecret?.trim() ?? '';
  check('a token secret reference is named', ref.length > 0);

  const allowlist = new Set(
    (process.env.FACTORY_ALLOWED_SECRET_REFS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  );
  check('the reference is allowlisted (FACTORY_ALLOWED_SECRET_REFS)', allowlist.has(ref), `ref ${ref || '<empty>'} is not allowed`);
  const mounted = ref ? process.env[ref] : undefined;
  check('the reference resolves to a mounted value (name only, never the value)', Boolean(mounted) && (mounted ?? '').length > 0);

  const baseUrl = (config.github?.baseUrl || GITHUB_API).trim();
  let host = '';
  let protocol = '';
  try {
    const url = new URL(baseUrl);
    host = url.hostname;
    protocol = url.protocol;
  } catch {
    host = '';
  }
  const isLocal = loopback(host);
  check('the host is api.github.com or a loopback stub', isLocal || host === 'api.github.com', `host ${host || '<unparseable>'}`);
  check('the scheme is https, or http only for a loopback stub', isLocal ? protocol === 'http:' || protocol === 'https:' : protocol === 'https:', `scheme ${protocol || '<none>'}`);

  const target = remoteOwnerRepo(repo);
  check('the repository has a github origin remote', Boolean(target), 'no github.com origin remote');
  if (target) check('the remote matches the owner/name grammar', REPO_PATTERN.test(target), target);
  if (expected) {
    check('the remote matches the declared scope (--owner)', target === expected, `remote ${target ?? '<none>'} != ${expected}`);
  }

  check(
    'the configuration cannot merge (merge stays an operator action)',
    (config as { autoMerge?: unknown }).autoMerge !== true,
  );
  let tokenIgnored = false;
  try {
    execFileSync('git', ['-C', repo, 'check-ignore', '-q', '.env'], { stdio: 'ignore' });
    tokenIgnored = true;
  } catch { tokenIgnored = false; }
  check('a local credential file (.env) is gitignored, so a mounted token cannot be committed', tokenIgnored);

  console.log(`\n═══ PR CONFIG: ${passed} passed, ${failed} failed ═══`);
  if (failed > 0) {
    console.log('Refusing: a pull request opened under this configuration would not be the one rehearsed here.');
    process.exit(1);
  }
  console.log('Configuration rehearsed. Opening the pull request remains an operator action.');
}

main();
