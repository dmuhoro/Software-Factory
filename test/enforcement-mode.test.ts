/**
 * Sprint 25, phase 4: graduated enforcement.
 *
 * The rule under test is the inversion this phase exists for. WorkOS ships a switch
 * that turns its actions endpoint off; SF does not, and this file is what proves it.
 * `off` is not a mode that happens to be discouraged — it is refused, in every
 * environment, including the one where a bypass would be most convenient.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_ENFORCEMENT_MODE,
  ENFORCEMENT_OFF_REFUSED,
  ENFORCEMENT_MODES,
  allow,
  enforceDecision,
  refuse,
  resolveEnforcementMode,
  type EnforcementMode,
} from '../src/utils/enforcement';
import { classifyApiError } from '../src/utils/apiError';

test('the mode set has two members, and neither of them is off', () => {
  assert.deepEqual([...ENFORCEMENT_MODES], ['enforce', 'log-only']);
  const values = ENFORCEMENT_MODES as readonly string[];
  assert.ok(!values.includes('off'), 'off is not a member of the type at all');
});

test('every spelling of off is refused, in every environment', () => {
  // The refusal must not be conditional on the environment. A bypass that only works
  // in development is a bypass that reaches production through a copied .env.
  for (const environment of ['development', 'test', 'production']) {
    for (const raw of ['off', 'OFF', 'Off', ' off ', 'disabled', 'false', '0', 'none']) {
      assert.throws(
        () => resolveEnforcementMode(raw, environment),
        (error: unknown) => error instanceof Error && error.message === ENFORCEMENT_OFF_REFUSED,
        `'${raw}' must be refused in ${environment}`,
      );
    }
  }
});

test('anything unrecognised resolves to enforce, never to log-only', () => {
  // A typo must not silently disable a check. Fail closed is the whole contract.
  for (const raw of [undefined, null, '', '   ', 'strict', 'yes', 'log', 'audit-only', 42, {}, []]) {
    assert.equal(resolveEnforcementMode(raw, 'production'), 'enforce', `${JSON.stringify(raw)} must fail closed`);
  }
  assert.equal(DEFAULT_ENFORCEMENT_MODE, 'enforce');
});

test('log-only is accepted, in every spelling, and only log-only', () => {
  for (const raw of ['log-only', 'log_only', 'logonly', 'LOG-ONLY', ' Log-Only ']) {
    assert.equal(resolveEnforcementMode(raw), 'log-only', `'${raw}' should be log-only`);
  }
  assert.equal(resolveEnforcementMode('enforce'), 'enforce');
});

test('under enforce a refusal throws the rule, so it classifies as a domain condition', () => {
  // The rule name as the message is this codebase's convention: `classifyApiError`
  // reads the message and looks it up, so a caller gets a written domain condition
  // instead of an unclassifiable internal fault.
  enforceDecision(allow(), 'enforce');
  assert.throws(() => enforceDecision(refuse('AUDIT_EVENT_INCOMPLETE'), 'enforce'), /AUDIT_EVENT_INCOMPLETE/);

  // The contract that makes classification work: the message IS the code. Proven
  // against a code that is registered today, so the mechanism is exercised rather than
  // assumed. A rule introduced later must be registered in `DOMAIN_ERRORS` and
  // `THROWN_CODES` for the same reason, which `l3-error-contract` enforces.
  assert.throws(() => enforceDecision(refuse('LOOP_RUN_NOT_CANCELABLE'), 'enforce'));
  const classified = classifyApiError(new Error('LOOP_RUN_NOT_CANCELABLE'));
  assert.notEqual(classified.code, 'INTERNAL_ERROR', 'an enforced rule must not degrade to a 500');
  assert.equal(classified.code, 'LOOP_RUN_NOT_CANCELABLE');
});

test('under log-only a refusal is recorded and the operation proceeds', () => {
  const bypassed: string[] = [];
  enforceDecision(allow(), 'log-only', (rule) => bypassed.push(rule));
  enforceDecision(refuse('AUDIT_EVENT_INCOMPLETE'), 'log-only', (rule) => bypassed.push(rule));
  assert.deepEqual(bypassed, ['AUDIT_EVENT_INCOMPLETE'], 'the bypass must be attributable to a named rule');

  // A log-only check with no logger still passes the operation through; it does not
  // fail closed in the other direction, because that would make log-only unusable.
  enforceDecision(refuse('AUDIT_EVENT_INCOMPLETE'), 'log-only');
});

test('the two modes differ only in whether a refusal stops the operation', () => {
  const run = (mode: EnforcementMode): string => {
    try {
      enforceDecision(refuse('AUDIT_EVENT_INCOMPLETE'), mode);
      return 'allowed';
    } catch {
      return 'refused';
    }
  };
  assert.equal(run('enforce'), 'refused');
  assert.equal(run('log-only'), 'allowed');
});
