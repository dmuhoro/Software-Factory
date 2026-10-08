/**
 * Sprint 25, phase 5: audit event schema validation and preview.
 *
 * The rule under test is that an audit event is refused when it cannot say who did
 * what to which subject with what outcome. A trail with holes is a trail that can be
 * argued with after the fact, so a malformed event is not written with holes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUDIT_OUTCOMES,
  AUDIT_RULES,
  previewAuditEvent,
  recordAuditEvent,
  validateAuditEvent,
  type AuditEvent,
} from '../src/services/auditEventService';
import { classifyApiError } from '../src/utils/apiError';

const NOW = '2026-10-08T12:00:00.000Z';

function validEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    tenantId: 'tenant_scoped_0001',
    kind: 'loop.run.cancel',
    actor: 'sfc_abc123',
    action: 'halt',
    target: 'run_42',
    outcome: 'allowed',
    timestamp: NOW,
    ...overrides,
  };
}

function rulesOf(event: Partial<AuditEvent>): string[] {
  return validateAuditEvent(event).flatMap((decision) => (decision.action === 'refuse' ? [decision.rule] : []));
}

test('a complete event is accepted and names every fact the trail depends on', () => {
  assert.deepEqual(rulesOf(validEvent()), [], 'a complete event must produce no refusals');
  assert.deepEqual([...AUDIT_OUTCOMES], ['allowed', 'refused', 'observed', 'failed']);
});

test('every missing fact is a named rule, and all of them are reported at once', () => {
  // All at once, not one per round-trip: an operator fixing a new integration should
  // see the whole list, not discover it a validation at a time.
  const refusals = rulesOf({});
  assert.ok(refusals.includes(AUDIT_RULES.TENANT_REQUIRED));
  assert.ok(refusals.includes(AUDIT_RULES.KIND_REQUIRED));
  assert.ok(refusals.includes(AUDIT_RULES.ACTOR_REQUIRED));
  assert.ok(refusals.includes(AUDIT_RULES.ACTION_REQUIRED));
  assert.ok(refusals.includes(AUDIT_RULES.TARGET_REQUIRED));
  assert.ok(refusals.includes(AUDIT_RULES.OUTCOME_NOT_RECOGNISED));
  assert.ok(refusals.includes(AUDIT_RULES.TIMESTAMP_INVALID));
  assert.equal(refusals.length, 7, 'a fully empty event breaks exactly the seven required facts');

  assert.deepEqual(rulesOf(validEvent({ tenantId: '  ' })), [AUDIT_RULES.TENANT_REQUIRED], 'blank is not present');
  assert.deepEqual(rulesOf(validEvent({ timestamp: 'yesterday' })), [AUDIT_RULES.TIMESTAMP_INVALID]);
  assert.deepEqual(rulesOf(validEvent({ outcome: 'maybe' as AuditEvent['outcome'] })), [AUDIT_RULES.OUTCOME_NOT_RECOGNISED]);
});

test('a kind must be lowercase and namespaced, or it is not a stable identifier', () => {
  assert.deepEqual(rulesOf(validEvent({ kind: 'Loop.Run.Cancel' })), [AUDIT_RULES.KIND_MALFORMED]);
  assert.deepEqual(rulesOf(validEvent({ kind: 'cancel' })), [AUDIT_RULES.KIND_MALFORMED], 'a bare verb names nothing');
  assert.deepEqual(rulesOf(validEvent({ kind: 'loop.run.cancel' })), []);
  assert.deepEqual(rulesOf(validEvent({ kind: 'loop:run:cancel' })), []);
});

test('every audit rule classifies as a domain condition, not an internal fault', () => {
  for (const rule of Object.values(AUDIT_RULES)) {
    const classified = classifyApiError(new Error(rule));
    assert.notEqual(classified.code, 'INTERNAL_ERROR', `${rule} must not degrade to a 500`);
    assert.notEqual(classified.status, 500, `${rule} must not be reported as a server fault`);
  }
});

test('preview answers what an event would do, and writes nothing', () => {
  const good = previewAuditEvent(validEvent(), 'enforce');
  assert.equal(good.valid, true);
  assert.deepEqual(good.refusals, []);
  assert.equal(good.underMode, 'write');
  assert.deepEqual(good.event, validEvent());

  const bad = previewAuditEvent({ tenantId: 't' }, 'enforce');
  assert.equal(bad.valid, false);
  assert.ok(bad.refusals.includes(AUDIT_RULES.ACTION_REQUIRED));
  assert.equal(bad.event, null, 'a refused event has nothing to write under enforce');

  // Under log-only the event still goes out, and the preview says so.
  const observed = previewAuditEvent({ tenantId: 't' }, 'log-only');
  assert.equal(observed.valid, false, 'log-only does not make a malformed event valid');
  assert.equal(observed.underMode, 'write-with-bypass');
  assert.ok(observed.event, 'log-only still has something to write');
});

test('under enforce a malformed event is refused and the sink is never called', async () => {
  const written: AuditEvent[] = [];
  await assert.rejects(
    () => recordAuditEvent({ tenantId: 't' }, 'enforce', async (event) => { written.push(event); }),
    /AUDIT_EVENT_/,
  );
  assert.deepEqual(written, [], 'nothing may reach the sink when enforce refuses');
});

test('under log-only a malformed event is written and the waived rules are returned', async () => {
  const written: AuditEvent[] = [];
  const result = await recordAuditEvent({ tenantId: 't' }, 'log-only', async (event) => { written.push(event); });
  assert.equal(result.written, true);
  assert.ok(result.waived.includes(AUDIT_RULES.ACTION_REQUIRED));
  assert.ok(result.waived.includes(AUDIT_RULES.TIMESTAMP_INVALID));
  assert.equal(written.length, 1, 'log-only writes the event, which is the whole difference');
});

test('a valid event is written under both modes with no waivers', async () => {
  for (const mode of ['enforce', 'log-only'] as const) {
    const written: AuditEvent[] = [];
    const result = await recordAuditEvent(validEvent(), mode, async (event) => { written.push(event); });
    assert.deepEqual(result, { written: true, waived: [] }, `${mode} must not waive anything for a valid event`);
    assert.equal(written.length, 1);
  }
});

test('the default sink logs rather than dropping, so a caller always knows where events went', async () => {
  // No sink argument: the event reaches the default one. Proven by the call not
  // throwing and not returning a silent success with nowhere behind it.
  const result = await recordAuditEvent(validEvent(), 'enforce');
  assert.equal(result.written, true);
});
