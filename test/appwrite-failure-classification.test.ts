/**
 * Failure classification for the Appwrite health check.
 *
 * The check's advice is chosen from this, so a misclassification does not merely produce a
 * worse message -- it tells an operator to fix the wrong thing. Every case here corresponds to a
 * distinct remedy, and the 401 case is the one the live pilot key actually produced.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyFailure } from '../src/services/appwriteClient';

test('a 401 is a rejected credential, not a network problem', () => {
  // This is the error the live key produces. If it were classified as anything else, the check
  // would advise the operator to fix the network, which is not broken.
  const e = Object.assign(new Error('The current user is not authorized to perform the requested action.'), { code: 401 });
  assert.equal(classifyFailure(e), 'unauthorized');
});

test('403 is a valid key with too narrow a scope', () => {
  const e = Object.assign(new Error('Permission denied'), { code: 403 });
  assert.equal(classifyFailure(e), 'forbidden');
});

test('404 is a missing project or database', () => {
  assert.equal(classifyFailure(Object.assign(new Error('Not found'), { code: 404 })), 'not-found');
});

test('a timeout is a network failure, not an authorization failure', () => {
  // undici nests the socket error, and codes like ETIMEDOUT are strings. Reading only the top
  // level would find no numeric status and could easily fall through to "unauthorized".
  const inner = Object.assign(new Error('socket hang up'), { code: 'ETIMEDOUT' });
  const outer = new Error('fetch failed', { cause: inner });
  assert.equal(classifyFailure(outer), 'network');
});

test('a 401 nested two causes deep is still found', () => {
  // The retry helper wraps, so the status is not always on the error the caller finally sees.
  const deepest = Object.assign(new Error('unauthorized'), { code: 401 });
  const middle = new Error('probe failed', { cause: deepest });
  const outer = new Error('after 3 attempts', { cause: middle });
  assert.equal(classifyFailure(outer), 'unauthorized');
});

test('a non-HTTP numeric code is not mistaken for a status', () => {
  // 0 and -1 are not HTTP statuses; treating them as authorization failures would be a guess.
  assert.equal(classifyFailure(Object.assign(new Error('nope'), { code: 0 })), 'network');
});

test('an error with no code at all is a network failure', () => {
  assert.equal(classifyFailure(new Error('boom')), 'network');
});
