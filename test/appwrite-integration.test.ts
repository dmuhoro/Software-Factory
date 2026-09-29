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
import { isPlaceholder, requireAppwriteConfig, resolveAppwriteConfig } from '../src/configurations/appwrite.config';
import { checkAppwriteReachable, documentIdFor } from '../src/services/appwriteClient';
import { DurableStore } from '../src/services/durableStore';

const ROOT = process.cwd();

const VALID = {
  APPWRITE_ENDPOINT: 'https://fra.cloud.appwrite.io/v1',
  APPWRITE_PROJECT_ID: '6aaa99700007bd53480e',
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
