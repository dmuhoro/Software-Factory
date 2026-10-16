/**
 * Sprint 31, WP-4: the executor-host bind address.
 *
 * ADR-014 §4 says the executor API binds to localhost and the tailnet only — never the
 * open internet. `FACTORY_BIND_HOST` is the control that enforces that, and it is enforced
 * in two halves that must not be confused:
 *
 *  - the *parser* (runtimeConfig) validates syntax: the address must be something
 *    `server.listen` can bind. It cannot know which deployment it is in — a pod binding
 *    0.0.0.0 is normal and necessary — so it refuses only what it cannot parse.
 *  - the *policy* (`evaluateBindHost`, enforced by `verify:host` on the executor host)
 *    refuses anything that is not loopback or on the operator's tailnet.
 *
 * The rule under test in each half is the same one ADR-014 states: absence is a refusal,
 * and a public bind on the executor host is never silently obeyed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { resolveRuntimeConfig, errorsOf, warningsOf } = await import('../src/configurations/runtimeConfig');
const { evaluateBindHost } = await import('../scripts/verify-host');

function configWith(bindHost: string | undefined): { bindHost: string; hasBindError: boolean } {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'production', FACTORY_API_KEY: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' };
  if (bindHost !== undefined) env.FACTORY_BIND_HOST = bindHost;
  const config = resolveRuntimeConfig(env);
  return { bindHost: config.bindHost, hasBindError: errorsOf(config).some((issue) => issue.variable === 'FACTORY_BIND_HOST') };
}

test('WP-4: an unset bind host keeps the container default (0.0.0.0), with no error', () => {
  const { bindHost, hasBindError } = configWith(undefined);
  assert.equal(bindHost, '0.0.0.0', 'the container path must not regress: no setting means the documented default');
  assert.equal(hasBindError, false);
});

test('WP-4: a bind host that parses is accepted by the parser, whatever its address', () => {
  // The parser cannot know the deployment: a pod binding 0.0.0.0 is correct, and
  // 8.8.8.8 is a legal thing for a process to bind. Whether it is *safe* is the
  // policy half's job, below.
  for (const host of ['127.0.0.1', 'localhost', '::1', '100.101.102.103', '8.8.8.8', '0.0.0.0']) {
    const { bindHost, hasBindError } = configWith(host);
    assert.equal(hasBindError, false, `${host} must parse`);
    assert.equal(bindHost, host);
  }
});

test('WP-4: an unparseable bind host is a startup error, never a silent fallback', () => {
  for (const host of ['not-an-address', '127.0.0.1; rm -rf /', '', '   ']) {
    const { hasBindError } = configWith(host);
    assert.equal(hasBindError, true, `${JSON.stringify(host)} must be reported as a configuration error`);
  }
});

test('WP-4: an out-of-range IPv4 octet is refused, not truncated into something that binds', () => {
  const { hasBindError } = configWith('999.999.999.999');
  assert.equal(hasBindError, true, 'an octet above 255 is not an address this service may bind');
});

test('WP-4: the policy refuses a public bind on the executor host, and says why', () => {
  for (const host of ['8.8.8.8', '1.2.3.4', '0.0.0.0', '10.0.0.5', '192.168.1.9']) {
    const verdict = evaluateBindHost(host);
    assert.equal(verdict.ok, false, `${host} must be refused by the executor-host policy`);
    assert.match(verdict.detail, /public bind/, 'the refusal must name the exposure');
    assert.ok(verdict.remediation, 'the operator must be told the fix');
  }
});

test('WP-4: the policy accepts loopback and tailnet addresses, because ADR-014 §4 names them', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1', '100.64.0.1', '100.127.255.254']) {
    const verdict = evaluateBindHost(host);
    assert.equal(verdict.ok, true, `${host} must be accepted: ${verdict.detail}`);
  }
});

test('WP-4: the policy treats an unset bind host as a refusal, not as safe', () => {
  // Unset means the service binds 0.0.0.0. On the executor host that is the open
  // internet, so the preflight must fail rather than shrug at the missing variable.
  for (const raw of [undefined, '', '   ']) {
    const verdict = evaluateBindHost(raw);
    assert.equal(verdict.ok, false, `${JSON.stringify(raw)} must be refused`);
    assert.match(verdict.detail, /0\.0\.0\.0/, 'the refusal must name what the service would actually bind');
  }
});

test('WP-4: the bind host is a recognised setting, so setting it is never reported as a typo', () => {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'production', FACTORY_API_KEY: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', FACTORY_BIND_HOST: '127.0.0.1' };
  const config = resolveRuntimeConfig(env);
  assert.equal(
    warningsOf(config).some((issue) => issue.variable === 'FACTORY_BIND_HOST'),
    false,
    'FACTORY_BIND_HOST is in use; it must not be flagged as having NO effect',
  );
});
