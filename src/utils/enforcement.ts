/**
 * Graduated enforcement for advisory checks.
 *
 * WorkOS exposes a switch that turns its actions endpoint off entirely
 * (`upsertActionsEndpoint(failOpen)`). That switch is not borrowed, and the reason is
 * the whole point of this module: **a protection that can be switched off is not a
 * protection.** An operator who can set `failOpen` can, and eventually will, disable
 * the thing it was installed to prevent.
 *
 * So this type has two members, not three. `off` is not a value it can hold; it is a
 * value the parser refuses, in every environment, and says so. What remains is a
 * genuine choice for tuning, not a bypass:
 *
 *  - `enforce` (the default, and the value returned for anything unrecognised): the
 *    check refuses the operation and the caller is told why.
 *  - `log-only`: the check records what it *would* have refused and lets the operation
 *    through. It is for watching a new check find real violations before it is trusted
 *    to stop work, and it is loud: every pass-through is logged at warn with the rule
 *    that was bypassed.
 *
 * `log-only` is permitted in production because it is an observability mode, not an
 * absence of one — but it is never the default, and nothing selects it by accident.
 *
 * ## What this may and may not govern
 *
 * Advisory checks only: audit completeness, schema validation, delivery guarantees.
 * A hard safety gate — the loop's refusal to cross the workspace boundary, a quota, an
 * approval that must exist before a run — has no mode. It is not consultable through
 * this module and must not be. Graduation is for checks whose failure costs a delay;
 * a check whose failure costs money, a tenant boundary or a real repository is not a
 * check, it is a wall, and walls do not have an off switch.
 */

export const ENFORCEMENT_MODES = ['enforce', 'log-only'] as const;
export type EnforcementMode = (typeof ENFORCEMENT_MODES)[number];

/** The only value an unset, empty, or unrecognised setting resolves to. */
export const DEFAULT_ENFORCEMENT_MODE: EnforcementMode = 'enforce';

/** Raised for an `off` request, in any environment. The message is the code. */
export const ENFORCEMENT_OFF_REFUSED = 'ENFORCEMENT_OFF_REFUSED';

/**
 * Turns an operator's setting into a mode, refusing the one that must not exist.
 *
 * Fails closed in two directions. A value that is not a known mode resolves to
 * `enforce`, so a typo cannot silently disable a check; and an explicit `off` throws
 * rather than resolving, so it cannot be set by accident either.
 */
export function resolveEnforcementMode(raw: unknown, environment = process.env.NODE_ENV): EnforcementMode {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'off' || value === 'disabled' || value === 'false' || value === '0' || value === 'none') {
    // Thrown in production AND outside it. The refusal is not conditional on the
    // environment, because a bypass that only works in development is a bypass that
    // reaches production through a copied .env.
    throw new Error(ENFORCEMENT_OFF_REFUSED);
  }
  if (value === 'log-only' || value === 'log_only' || value === 'logonly') return 'log-only';
  void environment;
  return DEFAULT_ENFORCEMENT_MODE;
}

/**
 * The verdict a check applies once it has decided something is wrong.
 *
 * Returned rather than thrown so a caller has to handle both branches: a check that
 * returns `refuse` and a caller that ignores it would otherwise look like a working
 * check. `enforceDecision` below is the only thing that turns a refusal into a throw.
 */
export type EnforcementDecision = { action: 'allow' } | { action: 'refuse'; rule: string };

export function allow(): EnforcementDecision {
  return { action: 'allow' };
}

export function refuse(rule: string): EnforcementDecision {
  return { action: 'refuse', rule };
}

/**
 * Applies a refusal under the given mode.
 *
 * Under `enforce` it throws, with the rule name as the message so it classifies as a
 * domain condition rather than an internal fault. Under `log-only` it records the
 * bypass and allows the operation, which is the entire difference between the two
 * modes: one line of logging, and the audit trail that shows it happened.
 */
export function enforceDecision(decision: EnforcementDecision, mode: EnforcementMode, onBypass?: (rule: string) => void): void {
  if (decision.action === 'allow') return;
  if (mode === 'log-only') {
    onBypass?.(decision.rule);
    return;
  }
  throw new Error(decision.rule);
}
