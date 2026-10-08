/**
 * Audit events: schema validation, preview, and record.
 *
 * An audit trail nobody can trust is worse than none, because it is consulted. Every
 * event written through this service is validated against a schema that names, in
 * machine-readable form, *who* did *what* to *which* subject and with what *outcome*.
 * An event missing any of those is refused rather than written with holes, because a
 * trail with holes is a trail that can be argued with after the fact.
 *
 * ## Why this is an advisory check
 *
 * Schema completeness is graded under `resolveEnforcementMode`: `enforce` refuses a
 * malformed event, `log-only` records what it would have refused and writes the event
 * anyway. That is the correct posture for a *new* check whose false positives would
 * stop work, and it is what `src/utils/enforcement.ts` exists for.
 *
 * It is NOT the correct posture for a check whose failure costs a boundary. A
 * cross-tenant write, an unapproved execution path, a quota breach — none of those are
 * consultable through this module. They have no mode. A complete audit trail cannot be
 * worth less than the thing it records.
 *
 * ## Preview
 *
 * `preview` answers "what would this event do?" without writing anything. It is the
 * operator-facing half: before a new integration starts emitting events, someone runs
 * its payload through a preview and sees the refusals it would collect under `enforce`,
 * rather than discovering them in the trail a week later.
 */

import { TelemetryLogger } from '../utils/telemetryLogger';
import { allow, enforceDecision, refuse, type EnforcementDecision, type EnforcementMode } from '../utils/enforcement';

/** The outcome an audit event must carry. A blank one is not an outcome. */
export const AUDIT_OUTCOMES = ['allowed', 'refused', 'observed', 'failed'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/**
 * An auditable fact.
 *
 * Every field is a string on purpose. An audit event is read by operators, grepped by
 * scripts, and diffed by hand; a nested object is a structure that has to be
 * round-tripped faithfully to stay trustworthy, and this trail does not need that risk.
 * Anything richer belongs in `details`, which is opaque to validation and is not a
 * source of claims.
 */
export interface AuditEvent {
  /** The tenant the event belongs to. Never optional: an event with no tenant is nobody's. */
  tenantId: string;
  /** A stable, lowercase, colon-namespaced verb: `loop.run.cancel`, `credential.provision`. */
  kind: string;
  /** Who did it. A principal id, a credential id, or `system`. Never a display name. */
  actor: string;
  /** What was done. One verb, lowercase. */
  action: string;
  /** Which subject it was done to: a run id, a credential id, a repo path. */
  target: string;
  outcome: AuditOutcome;
  /** ISO-8601. Validated, not trusted: an unparseable timestamp is a refusal. */
  timestamp: string;
  /** Opaque. Not validated, not a source of claims, never consulted for authorisation. */
  details?: Record<string, unknown>;
}

/** The named rules. Each is registered so it classifies as a domain condition, not a 500. */
export const AUDIT_RULES = {
  TENANT_REQUIRED: 'AUDIT_EVENT_TENANT_REQUIRED',
  KIND_REQUIRED: 'AUDIT_EVENT_KIND_REQUIRED',
  KIND_MALFORMED: 'AUDIT_EVENT_KIND_MALFORMED',
  ACTOR_REQUIRED: 'AUDIT_EVENT_ACTOR_REQUIRED',
  ACTION_REQUIRED: 'AUDIT_EVENT_ACTION_REQUIRED',
  TARGET_REQUIRED: 'AUDIT_EVENT_TARGET_REQUIRED',
  OUTCOME_NOT_RECOGNISED: 'AUDIT_EVENT_OUTCOME_NOT_RECOGNISED',
  TIMESTAMP_INVALID: 'AUDIT_EVENT_TIMESTAMP_INVALID',
} as const;

const KIND_PATTERN = /^[a-z][a-z0-9]*(?:[:.][a-z0-9_]+)+$/;

/**
 * Validates an event and returns the rules it breaks.
 *
 * Returns refusals rather than throwing so a caller can see every problem at once. A
 * check that stops at the first violation makes an operator fix them one round-trip at
 * a time, which is how a check earns a reputation for being annoying and gets bypassed.
 */
export function validateAuditEvent(event: Partial<AuditEvent>): EnforcementDecision[] {
  const refusals: EnforcementDecision[] = [];

  if (typeof event.tenantId !== 'string' || event.tenantId.trim() === '') {
    refusals.push(refuse(AUDIT_RULES.TENANT_REQUIRED));
  }
  if (typeof event.kind !== 'string' || event.kind.trim() === '') {
    refusals.push(refuse(AUDIT_RULES.KIND_REQUIRED));
  } else if (!KIND_PATTERN.test(event.kind)) {
    refusals.push(refuse(AUDIT_RULES.KIND_MALFORMED));
  }
  if (typeof event.actor !== 'string' || event.actor.trim() === '') {
    refusals.push(refuse(AUDIT_RULES.ACTOR_REQUIRED));
  }
  if (typeof event.action !== 'string' || event.action.trim() === '') {
    refusals.push(refuse(AUDIT_RULES.ACTION_REQUIRED));
  }
  if (typeof event.target !== 'string' || event.target.trim() === '') {
    refusals.push(refuse(AUDIT_RULES.TARGET_REQUIRED));
  }
  if (!AUDIT_OUTCOMES.includes(event.outcome as AuditOutcome)) {
    refusals.push(refuse(AUDIT_RULES.OUTCOME_NOT_RECOGNISED));
  }
  if (typeof event.timestamp !== 'string' || Number.isNaN(Date.parse(event.timestamp))) {
    refusals.push(refuse(AUDIT_RULES.TIMESTAMP_INVALID));
  }

  return refusals.length > 0 ? refusals : [allow()];
}

export interface AuditPreview {
  /** True when the event would be written under `enforce`. */
  valid: boolean;
  /** The rules the event breaks. Empty when valid. */
  refusals: string[];
  /** The event as it would be written, or `null` when it is refused under `enforce`. */
  event: AuditEvent | null;
  /** What would actually happen under this mode. */
  underMode: 'write' | 'write-with-bypass';
}

/**
 * Answers "what would this event do?" without writing anything.
 *
 * The operator-facing half of the phase: run a new integration's payload through a
 * preview and see the refusals it would collect under `enforce`, before it is trusted
 * to emit into the real trail.
 */
export function previewAuditEvent(event: Partial<AuditEvent>, mode: EnforcementMode): AuditPreview {
  const decisions = validateAuditEvent(event);
  const valid = decisions.every((decision) => decision.action === 'allow');
  const refusals = decisions.flatMap((decision) => (decision.action === 'refuse' ? [decision.rule] : []));
  return {
    valid,
    refusals,
    event: valid || mode === 'log-only' ? (event as AuditEvent) : null,
    underMode: valid ? 'write' : mode === 'log-only' ? 'write-with-bypass' : 'write',
  };
}

/**
 * Validates under the given mode and records the event.
 *
 * Under `enforce` a malformed event is refused and nothing is written. Under `log-only`
 * the bypass is logged with the rules that were waived — attributable, so an operator
 * reviewing the trail later can see which events arrived unvalidated and why.
 *
 * Returns the refusals that were waived, which is empty under `enforce` when the event
 * is valid, and non-empty under `log-only` when it was not.
 */
export async function recordAuditEvent(
  event: Partial<AuditEvent>,
  mode: EnforcementMode,
  sink: (event: AuditEvent) => Promise<unknown> = defaultSink,
): Promise<{ written: boolean; waived: string[] }> {
  const decisions = validateAuditEvent(event);
  const valid = decisions.every((decision) => decision.action === 'allow');
  const waived = decisions.flatMap((decision) => (decision.action === 'refuse' ? [decision.rule] : []));

  if (valid) {
    await sink(event as AuditEvent);
    return { written: true, waived: [] };
  }

  let waivedUnderMode: string[] = [];
  for (const decision of decisions) {
    if (decision.action !== 'refuse') continue;
    enforceDecision(decision, mode, (rule) => {
      waivedUnderMode.push(rule);
      TelemetryLogger.warn('Audit event written with schema refusals waived', {
        metadata: { rule, kind: event.kind ?? null, tenantId: event.tenantId ?? null, mode },
      });
    });
  }

  // Reaching here means every refusal was waived: `enforce` would have thrown on the
  // first one. The event goes out, and the trail records that it went out unvalidated.
  await sink(event as AuditEvent);
  return { written: true, waived: waivedUnderMode };
}

/**
 * The default sink writes to the telemetry log.
 *
 * A separate, injectable sink exists so a caller can point audit events at a durable
 * store without this module importing one. The default is deliberately the log: an
 * audit service that silently dropped events because a store was unavailable would be
 * worse than one that says nothing, so the caller always knows what it is writing to.
 */
async function defaultSink(event: AuditEvent): Promise<void> {
  TelemetryLogger.info('audit event', {
    metadata: { tenantId: event.tenantId, kind: event.kind, actor: event.actor, action: event.action, target: event.target, outcome: event.outcome },
  });
}
