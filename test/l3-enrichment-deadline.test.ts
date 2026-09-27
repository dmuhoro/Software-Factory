/**
 * Layer 3, part 3: a wall-clock deadline for retried work.
 *
 * A per-attempt timeout and a retry count do not bound how long a request can be held
 * open. These tests pin the aggregate bound, because that is the part that was missing and
 * the part a caller actually experiences.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withExponentialBackoff, OperationDeadlineExceededError } from '../src/utils/circuitBreaker';

const ok = async <T>(value: T) => value;

test('L3: retries stop at the deadline instead of running the full retry budget', async () => {
  const started = Date.now();
  let attempts = 0;

  // A "provider" slower than the deadline itself: without a wall-clock bound this ran
  // every attempt to completion and reported the last attempt's error.
  await assert.rejects(
    withExponentialBackoff(
      async () => {
        attempts++;
        await new Promise((resolve) => setTimeout(resolve, 200));
        throw new Error('provider slow');
      },
      5, // retries
      10,
      20,
      0,
      400, // overall deadline
    ),
    (error: unknown) => error instanceof OperationDeadlineExceededError
  );

  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1500, `expected the deadline to cut the work short, took ${elapsed}ms`);
  assert.ok(attempts < 6, `expected fewer than all 6 attempts, made ${attempts}`);
});

test('L3: the deadline error carries the underlying failure as its cause', async () => {
  const cause = new Error('upstream 503');
  await assert.rejects(
    withExponentialBackoff(
      async () => {
        throw cause;
      },
      3,
      1_000, // backoff far larger than the deadline
      1_000,
      0,
      50
    ),
    (error: unknown) => {
      assert.ok(error instanceof OperationDeadlineExceededError);
      // Without this the operator sees "deadline exceeded" and loses the reason.
      assert.equal((error as { cause?: unknown }).cause, cause);
      return true;
    }
  );
});

test('L3: an unbounded deadline is refused rather than silently accepted', async () => {
  // An infinite budget is the bug this change removes, so it must be a hard error instead
  // of a value that quietly restores the unbounded behaviour.
  for (const bad of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
    await assert.rejects(
      withExponentialBackoff(async () => ok(1), 1, 1, 1, 0, bad),
      /positive finite deadline/,
      `deadline ${bad} should be rejected`
    );
  }
});

test('L3: a fast success is returned without waiting for the deadline', async () => {
  const { result, attempts } = await withExponentialBackoff(async (n) => ok(n * 2), 3, 1, 1, 0, 5_000);
  assert.equal(result, 2);
  assert.equal(attempts, 1);
});

test('L3: a healthy transient failure still recovers within the budget', async () => {
  let attempts = 0;
  const { result, attempts: used } = await withExponentialBackoff(
    async () => {
      attempts++;
      if (attempts < 3) throw new Error('flaky');
      return 'ok';
    },
    3,
    5,
    20,
    0,
    5_000
  );
  assert.equal(result, 'ok', 'the deadline must not break normal recovery');
  assert.equal(used, 3);
});

test('L3: retries exhausted inside the budget rethrows the real error, not the deadline', async () => {
  const cause = new Error('genuine upstream failure');
  await assert.rejects(
    withExponentialBackoff(
      async () => {
        throw cause;
      },
      2,
      1,
      2,
      0,
      10_000
    ),
    (error: unknown) => {
      assert.equal(error, cause, 'with budget to spare the original error must surface');
      return true;
    }
  );
});
