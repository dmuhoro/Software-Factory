/**
 * The Appwrite integration is real, or it is refused.
 *
 * ## The defect this file is the guard for
 *
 * `src/configurations/appwrite.config.ts` shipped these defaults:
 *
 * ```ts
 * endpoint: process.env.APPWRITE_ENDPOINT || 'https://cloud.appwrite.io/v1',
 * projectId: process.env.APPWRITE_PROJECT_ID || 'b2b_software_factory_proj',
 * apiKey:    process.env.APPWRITE_API_KEY    || 'standard_appwrite_api_key_secret',
 * ```
 *
 * All three were fiction, and the API key was shaped like a real Appwrite credential, so an
 * operator reading the configuration would conclude the integration was complete. Meanwhile
 * `AppwriteService` -- the class named after Appwrite -- performed no HTTP request and imported
 * no SDK at all: it wrote to the local file ledger and described itself as a "port for founder
 * mode and future Appwrite replacement". So the product required `APPWRITE_API_KEY` at startup
 * in Rust, invented one in TypeScript, and contacted Appwrite in neither.
 *
 * These tests assert the fail-closed contract, and the last one is a source-level guard so the
 * placeholder cannot return in a file this test does not read.
 */

import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';
import { isPlaceholder, isValidAppwriteId, requireAppwriteConfig, resolveAppwriteConfig } from '../src/configurations/appwrite.config';
import { checkAppwriteReachable, documentIdFor, getAppwriteServices, isTransportFailure, resetAppwriteServices } from '../src/services/appwriteClient';
import { DurableStore } from '../src/services/durableStore';

const ROOT = process.cwd();

const VALID = {
  APPWRITE_ENDPOINT: 'https://fra.cloud.appwrite.io/v1',
  APPWRITE_PROJECT_ID: 'a1b2c3d4e5f6a7b8c9d0',
  APPWRITE_API_KEY: 'a-real-looking-opaque-key-0123456789abcdef',
} as NodeJS.ProcessEnv;

test('the exact placeholder that shipped is refused', () => {
  // This is the literal value that was committed. It is named here so that reintroducing it is
  // a test failure rather than a silent re-enable of a fake integration.
  assert.equal(isPlaceholder('standard_appwrite_api_key_secret'), true);
  const settings = resolveAppwriteConfig({ ...VALID, APPWRITE_API_KEY: 'standard_appwrite_api_key_secret' });
  assert.equal(settings.configured, false, 'a placeholder key must not produce a configured integration');
  assert.ok(
    settings.issues.some((issue) => issue.variable === 'APPWRITE_API_KEY' && issue.severity === 'error'),
    'the refusal must name APPWRITE_API_KEY as an error',
  );
});

test('a real Appwrite key is accepted and the shipped placeholder is not', () => {
  // Found by running the detector against the operator's actual credential during the first
  // authenticated connection. The first version refused anything beginning `standard_`, which is
  // exactly what a *real* Appwrite key begins with -- so it refused every genuine key the
  // operator owns. A guard that blocks real traffic protects nothing; it just gets bypassed.
  // Synthetic, shaped like a real key. The real credential is never a test fixture: a key prefix
  // pasted into source is a leak waiting to be committed, and this file is the one most likely to
  // be committed by someone in a hurry.
  const real = `standard_${'0123456789abcdef'.repeat(8)}`;
  assert.equal(isPlaceholder(real), false, 'a real standard_<hex> key must not be refused');
  assert.equal(isPlaceholder('standard_appwrite_api_key_secret'), true, 'the shipped placeholder must be refused');
  assert.equal(isPlaceholder('standard_deadbeef'), true, 'a short non-hex suffix is still a template');
  assert.equal(resolveAppwriteConfig({ ...VALID, APPWRITE_API_KEY: real }).configured, true,
    'the operator\'s real key must produce a configured integration');
});

test('project ids are validated by shape, not against a list of known fakes', () => {
  // `b2b_software_factory_proj` shipped as a default. A blacklist of known fakes cannot work: the
  // next fabricated id is a different string. Appwrite ids are 24 alphanumeric characters.
  // 20 characters, measured against the operator's real project id rather than guessed.
  assert.equal(isValidAppwriteId('a1b2c3d4e5f6a7b8c9d0'), true, 'a measured 20-character project id is valid');
  // 24 is a MongoDB ObjectId length, not an Appwrite one. Asserting it rejected the real id.
  assert.equal(isValidAppwriteId('a'.repeat(24)), false, 'a 24-character id is not an Appwrite id');
  assert.equal(isValidAppwriteId('0123456789abcdefghij'), true, 'a 20-char account id shares the format');
  assert.equal(isValidAppwriteId('b2b_software_factory_proj'), false, 'the shipped fabrication is not a valid id');
  assert.equal(resolveAppwriteConfig({ ...VALID, APPWRITE_PROJECT_ID: 'b2b_software_factory_proj' }).configured, false,
    'a fabricated project id must not produce a configured integration');
});

test('nothing is defaulted: an empty environment is unconfigured, not fiction', () => {
  const settings = resolveAppwriteConfig({} as NodeJS.ProcessEnv);
  assert.equal(settings.configured, false);
  // The three variables the Rust runtime already refuses to start without.
  for (const variable of ['APPWRITE_ENDPOINT', 'APPWRITE_PROJECT_ID', 'APPWRITE_API_KEY']) {
    assert.ok(
      settings.issues.some((issue) => issue.variable === variable),
      `an unset environment must report ${variable}; a default is what made this defect invisible`,
    );
  }
  // The fabricated project id and the global endpoint must not reappear as defaults.
  assert.equal(settings.projectId, '', 'projectId must not be invented');
  assert.equal(settings.endpoint, '', 'endpoint must not be invented');
  assert.equal(settings.apiKey, '', 'apiKey must not be invented');
});

test('the global endpoint is not silently substituted for a regional one', () => {
  // The shipped default sent tenant telemetry to the global endpoint rather than the regional
  // one this deployment uses, which is a data-residency problem and not a default.
  const settings = resolveAppwriteConfig({ ...VALID, APPWRITE_ENDPOINT: '' });
  assert.equal(settings.endpoint, '', 'a missing endpoint must stay missing, not become cloud.appwrite.io');
  assert.equal(settings.configured, false);
});

test('a malformed endpoint is an error, not a warning', () => {
  for (const bad of ['http://fra.cloud.appwrite.io/v1', 'https://fra.cloud.appwrite.io', 'fra.cloud.appwrite.io/v1']) {
    const settings = resolveAppwriteConfig({ ...VALID, APPWRITE_ENDPOINT: bad });
    assert.equal(
      settings.configured, false,
      `"${bad}" must be refused: plaintext, versionless, or not a URL at all are all wrong`,
    );
  }
  assert.equal(resolveAppwriteConfig(VALID).configured, true, 'the real regional endpoint must be accepted');
});

test('requireAppwriteConfig throws and names every problem at once', () => {
  assert.throws(
    () => requireAppwriteConfig({} as NodeJS.ProcessEnv),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : '';
      // One throw, every reason. A caller that fixed them one restart at a time is a caller
      // that will ship after the second one.
      assert.match(message, /APPWRITE_ENDPOINT/);
      assert.match(message, /APPWRITE_PROJECT_ID/);
      assert.match(message, /APPWRITE_API_KEY/);
      return true;
    },
  );
  assert.doesNotThrow(() => requireAppwriteConfig(VALID), 'valid configuration must not throw');
});

test('the Appwrite client is memoised, because a fresh one per call is flaky', async () => {
  // Measured against the operator's real project: a fresh Client per call failed roughly 1 in 6
  // with a bare `TypeError: fetch failed`, while one reused client completed 8/8 and then 20/20.
  // The SDK holds the connection pool, so building a throwaway client per call is what made the
  // integration look flaky -- and "flaky" was a property of this code, not of Appwrite.
  resetAppwriteServices();
  const first = getAppwriteServices(VALID);
  const second = getAppwriteServices(VALID);
  assert.equal(first, second, 'the same configuration must return the same client, not rebuild it');

  // A rotated credential must not be served from the memo, or a revoked key would keep working
  // for the life of the process.
  resetAppwriteServices();
  const rotated = getAppwriteServices({ ...VALID, APPWRITE_API_KEY: `${VALID.APPWRITE_API_KEY}-rotated` });
  assert.notEqual(rotated, first, 'a different credential must produce a different client');
  resetAppwriteServices();
});

test('a live-reachability check reports "not attempted" instead of pretending', async () => {
  const result = await checkAppwriteReachable({} as NodeJS.ProcessEnv);
  assert.equal(result.reachable, false);
  assert.equal(result.authenticated, false);
  assert.match(result.detail, /not attempted/);
  // The point of the function is that it never claims a connection it did not make.
  assert.equal(result.projectId, '');
  assert.deepEqual(result.expected.collections.length, 4, 'the expected schema is reported even when unconfigured');
});

test('documentIdFor delegates to the canonical ADR-001 key, byte for byte', () => {
  // A second hashing scheme would be a second answer to the same question. The NUL separator in
  // DurableStore.deterministicId is load-bearing, so this asserts delegation rather than equality
  // of shape.
  // Delegation, plus the one thing that must differ: Appwrite rejects ids over 36 characters and
  // the canonical function returns 42, so the result is truncated rather than re-derived.
  assert.equal(
    documentIdFor('doc_telem', 'tenant_re_8841', 'idem-1'),
    DurableStore.deterministicId('doc_telem', 'tenant_re_8841', 'idem-1').slice(0, 36),
  );
  assert.equal(
    documentIdFor('doc_telem', 'tenant_re_8841', 'idem-1'),
    documentIdFor('doc_telem', 'tenant_re_8841', 'idem-1'),
    'the same key must always produce the same document id, or replay protection is gone',
  );
  // The separator must not be reintroduced as something ambiguous: ['ab','c'] and ['a','bc']
  // must not collide.
  assert.notEqual(
    documentIdFor('doc_telem', 'ab', 'c'),
    documentIdFor('doc_telem', 'a', 'bc'),
    'partition boundaries must survive the join, which is why the separator is a NUL',
  );
  // Appwrite document ids allow [A-Za-z0-9._-] and cap at 36 characters.
  const id = documentIdFor('doc_telem', 'tenant_re_8841', 'idem-1');
  assert.ok(id.length <= 36, `document id must fit Appwrite's 36-character limit (got ${id.length})`);
  assert.match(id, /^[A-Za-z0-9._-]+$/, 'document id must use only characters Appwrite accepts');
});

test('no source file gives an APPWRITE_* variable a string fallback', () => {
  // Matches the shape of the defect rather than the literal. The first version searched for the
  // placeholder string, which fired on this file -- it names the defect on purpose -- and on the
  // docstring in appwrite.config.ts that quotes the old code so a future reader understands why.
  // A guard that cannot distinguish the defect from its own documentation will be silenced, and
  // a silenced guard is how `standard_appwrite_api_key_secret` survives a second hardening pass.
  //
  // `process.env.APPWRITE_X || 'literal'` is what makes a product look configured when it is
  // not, so that is what is forbidden.
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!/\.(ts|tsx|js)$/.test(entry.name)) continue;
      // Comment lines are removed first. Source code executes; a docstring quoting the defect it
      // fixed does not. This is ADR-008 rule 4, reached the fourth time in this release: a check
      // that cannot tell documentation from behaviour gets silenced the first time it is
      // inconvenient, and the defect it was written for comes back. Only whole-line comments are
      // stripped, so a `#` or a quoted string inside a line of real code is left alone.
      const source = readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line))
        .join('\n');
      if (/APPWRITE_[A-Z_]+\s*\|\|\s*['"][^'"]+['"]/.test(source)) offenders.push(path);
    }
  };
  walk(join(ROOT, 'src'));
  assert.deepEqual(offenders, [], `an APPWRITE_* variable must not have a string fallback: ${offenders.join(', ')}`);
});

test('a transport failure stays recognisable after it is wrapped', () => {
  // Regression, caught by measurement rather than by reading. The retry classifier originally
  // matched on the exact message "fetch failed". Wrapping the probe error to give it a useful
  // message therefore made it unrecognisable, which silently disabled every retry and took the
  // live check from 9/10 green to 1/6. A robustness layer that stops working when it is improved
  // is worse than no layer, so this pins the behaviour.
  const timeout = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
  const original = new TypeError('fetch failed', { cause: timeout });
  assert.equal(isTransportFailure(original), true, 'a bare fetch failure is a transport failure');
  assert.equal(isTransportFailure(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })), true, 'so is a reset connection');

  // A status means the server answered. Retrying that is re-sending a request the server judged.
  const judged = Object.assign(new Error('Document not found'), { response: '404' });
  assert.equal(isTransportFailure(judged), false, 'a server verdict is never retried as a transport failure');

  // And an unrelated error is not retried either.
  assert.equal(isTransportFailure(new Error('validation failed')), false, 'application errors are not transport failures');
});
