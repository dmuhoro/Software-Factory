/**
 * Hermetic environment for the test suite.
 *
 * ## Why this exists
 *
 * The product reads several directory roots from the environment, and a developer's `.env` sets
 * them to production-shaped absolute paths:
 *
 *     FACTORY_WORKSPACE_ROOT=/approved/workspace/root
 *     FACTORY_WORKTREE_ROOT=/approved/worktrees
 *
 * Tests that forgot to override one of those inherited it. The result was a suite whose outcome
 * depended on the operator's shell: `npm test` passed on a machine that could create
 * `/approved/worktrees` and failed with `EACCES` on one that could not, from the same commit.
 *
 * That is the failure mode this repository exists to prevent, in miniature. A green suite that is
 * green because the environment happened to cooperate is not evidence, and a red suite that is red
 * because of a stray export sends the next person hunting a bug that is not in the code.
 *
 * ## What it does
 *
 * Every workspace root is pointed at a fresh temporary directory before any test file loads, so
 * no test can inherit a path from the shell that launched it. Individual tests are still free to
 * override these with their own `mkdtemp` directories, and most do; this is the floor under them,
 * not a replacement.
 *
 * It is a *test* concern, so it lives here and is loaded via `--import` in the test script. It is
 * deliberately not added to the product's own startup: silently rewriting an operator's configured
 * paths in production would be far worse than the problem it fixes.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Every directory root the product resolves from the environment. */
const ROOTS = [
  'FACTORY_WORKSPACE_ROOT',
  'FACTORY_CLIENT_WORKSPACE_ROOT',
  'FACTORY_WORKTREE_ROOT',
  'FACTORY_SANDBOX_ROOT',
  'FACTORY_ARTIFACT_ROOT',
] as const;

const base = mkdtempSync(join(tmpdir(), 'factory-test-roots-'));

for (const root of ROOTS) {
  const inherited = process.env[root];
  if (inherited !== undefined && !inherited.startsWith(tmpdir())) {
    // Recorded rather than swallowed: if a test ever asserts on the ambient value, the reason it
    // is not what it expected will be here.
    process.env[`SF_TEST_OVERRODE_${root}`] = inherited;
  }
  process.env[root] = join(base, root.replace(/^FACTORY_/, '').toLowerCase());
}

/**
 * Variables that decide *whether a request is authenticated*, not where a file is written.
 *
 * These were the second half of the same defect the roots above fixed, and they were missed. A
 * developer `.env` exports `ALLOW_INSECURE_LOCAL=true`; `verify:full` sources `.env` before running
 * the suite; so under `verify:full` the loopback bypass is live and every "401 without a
 * credential" harness case answered 403 (`TENANT_NOT_FOUND` for the synthetic `local-development`
 * principal) instead of 401. The same suite passed when run directly, because that shell had no
 * `.env`. A suite whose verdict depends on which command launched it is not evidence -- the exact
 * failure `scripts/verify-env.sh` forbids for the shell harnesses, and this mirrors its list for
 * the Node suite. Individual tests still set what they need; this only removes what leaked in.
 */
const AUTH_AND_BACKEND = [
  'FACTORY_DATA_DIR',
  'FACTORY_API_KEY',
  'FACTORY_TENANT_CREDENTIALS',
  'FACTORY_TENANT_SEED_DEMO',
  'FACTORY_ALLOWED_SECRET_REFS',
  'FACTORY_ALLOWED_MODEL_HOSTS',
  'ALLOW_INSECURE_LOCAL',
  'STORAGE_BACKEND',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
] as const;

for (const variable of AUTH_AND_BACKEND) {
  delete process.env[variable];
}

/**
 * The host's own load and memory, the last ambient input the suite inherited.
 *
 * The loop refuses to run when the *host* is short on resources (`ResourceGovernorService`, and
 * the `resource-admission` gate). On a shared developer machine that made the loop-driving tests
 * fail whenever the desktop was busy -- `resource exhaustion: LOAD:loadavg-per-cpu=2.10,budget=2`
 * -- even though nothing was wrong with the code. A verdict that depends on whether Chrome was
 * open is the same defect the workspace roots above fixed, so the sample is pinned here instead.
 *
 * The governor's own behaviour is not weakened: its test clears this override and proves the real
 * path still reads the host and still refuses when the host is genuinely short. Here we pin a
 * benign sample only so the tests that *drive real loops* measure the loop, not the machine.
 */
const { ResourceGovernorService } = await import('../src/services/resourceGovernorService');
ResourceGovernorService.setSamplerForTests(() => ({ cpus: 8, freeMemMb: 8192, loadAvgPerCpu: 0.25 }));

