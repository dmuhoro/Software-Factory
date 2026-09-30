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
