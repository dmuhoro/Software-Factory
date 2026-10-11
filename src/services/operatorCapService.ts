/**
 * Durable operator cap overrides, per tenant.
 *
 * The tier-derived caps lived in two places nobody could change at runtime: `TenantQueueService`
 * fixed the concurrency bounds in code, and the tenant profile fixed the daily AI-token allowance
 * at registration. Debugging a noisy tenant meant editing code or re-registering the tenant. This
 * service is the operator's runtime handle on both, persisted in the durable ledger (collection
 * `operatorCaps`) so a restart does not silently restore the defaults under a live override.
 *
 * Two properties make the override safe by construction, not by convention:
 *
 *  - **Tighten-only.** `set` refuses an override that would raise a cap above the base it is given
 *    (`OPERATOR_CAP_NOT_TIGHTENING`). The guarantee does not depend on this refusal alone: every
 *    consumer computes its effective cap as `Math.min(base, override)`, so even a value that slips
 *    past validation (a stale base, a future caller) can never enlarge the allowance. A cap override
 *    is a floor that may be lowered, not a ceiling that may be raised.
 *  - **Durable and attributable.** Each record carries `updatedAt`, `updatedBy` and a bumping
 *    `revision`, and the route that writes one also writes an audit event. A change that vanishes
 *    after a restart or belongs to no one is a control that was never really applied.
 *
 * `clear` restores the base by removing the override; it can never take effect above the base,
 * because removing a lower override returns the allowance to the tier default, not above it.
 */

import { DurableStore } from './durableStore';

/**
 * A persistent, tighten-only override of one tenant's operational caps. Absent fields leave the
 * base untouched; a field present is always `Math.min(base, field)` when consumed.
 */
export interface OperatorCap {
  tenantId: string;
  /** Concurrent runs this tenant may hold. Integer >= 1, never above the tier/env cap. */
  concurrency?: number;
  /** Daily AI-token allowance. Integer >= 0, never above the subscription quota. */
  dailyAiTokens?: number;
  updatedAt: string;
  updatedBy: string;
  /** Monotonically increasing per tenant; bumps on every successful `set`. */
  revision: number;
}

/** The base allowance an override is measured against, supplied by the caller who owns the tier. */
export interface CapCeiling {
  /** The concurrent-run allowance the tenant already has (tier tightened by environment). */
  concurrency: number;
  /** The daily token allowance the tenant already has. `null` means unmeasurable: an override is refused. */
  dailyAiTokens: number | null;
}

export interface CapOverrideInput {
  tenantId: string;
  actor: string;
  ceiling: CapCeiling;
  concurrency?: number;
  dailyAiTokens?: number;
}

function assertWholeNumber(value: number, single: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`OPERATOR_CAP_INVALID:${single}=${String(value)}`);
  return value;
}

export class OperatorCapService {
  public static get(tenantId: string): OperatorCap | undefined {
    if (typeof tenantId !== 'string' || tenantId.trim() === '') throw new Error('TENANT_CONTEXT_REQUIRED');
    return DurableStore.get('operatorCaps', tenantId) as unknown as OperatorCap | undefined;
  }

  public static list(): OperatorCap[] {
    return (DurableStore.list('operatorCaps') as unknown as OperatorCap[]).sort((a, b) => a.tenantId.localeCompare(b.tenantId));
  }

  /** The effective cap for a tenant: the base never exceeds the tier default, override never exceeds the base. */
  public static effective(tenantId: string, ceiling: CapCeiling): { concurrency: number; dailyAiTokens: number | null; override: OperatorCap | null } {
    const override = this.get(tenantId);
    const concurrency = override?.concurrency === undefined ? ceiling.concurrency : Math.min(ceiling.concurrency, override.concurrency);
    let dailyAiTokens = ceiling.dailyAiTokens;
    if (override?.dailyAiTokens !== undefined && ceiling.dailyAiTokens !== null) dailyAiTokens = Math.min(ceiling.dailyAiTokens, override.dailyAiTokens);
    return { concurrency, dailyAiTokens, override: override ?? null };
  }

  /**
   * Writes a tighten-only override. `ceiling` is the base the caller resolves from the tenant's
   * own tier and quota; a value above it, or a daily-token override against an unmeasurable base,
   * is refused (`OPERATOR_CAP_NOT_TIGHTENING`) rather than honoured as a suspicion.
   */
  public static set(input: CapOverrideInput): OperatorCap {
    if (typeof input.tenantId !== 'string' || input.tenantId.trim() === '') throw new Error('TENANT_CONTEXT_REQUIRED');
    if (typeof input.actor !== 'string' || input.actor.trim() === '') throw new Error('OPERATOR_ACTOR_REQUIRED');
    if (input.concurrency === undefined && input.dailyAiTokens === undefined) throw new Error('OPERATOR_CAP_INVALID:none-given');

    if (input.concurrency !== undefined) {
      const value = assertWholeNumber(input.concurrency, 'concurrency');
      if (value < 1) throw new Error(`OPERATOR_CAP_INVALID:concurrency=${String(value)}`);
      if (!Number.isFinite(input.ceiling.concurrency) || value > input.ceiling.concurrency) {
        throw new Error(`OPERATOR_CAP_NOT_TIGHTENING:concurrency=${value},base=${String(input.ceiling.concurrency)}`);
      }
    }
    if (input.dailyAiTokens !== undefined) {
      const value = assertWholeNumber(input.dailyAiTokens, 'dailyAiTokens');
      if (input.ceiling.dailyAiTokens === null || !Number.isFinite(input.ceiling.dailyAiTokens) || value > input.ceiling.dailyAiTokens) {
        throw new Error(`OPERATOR_CAP_NOT_TIGHTENING:dailyAiTokens=${value},base=${input.ceiling.dailyAiTokens === null ? 'unmeasurable' : String(input.ceiling.dailyAiTokens)}`);
      }
    }

    const previous = this.get(input.tenantId);
    const at = new Date().toISOString();
    const cap: OperatorCap = {
      tenantId: input.tenantId,
      ...(input.concurrency !== undefined ? { concurrency: input.concurrency } : {}),
      ...(input.dailyAiTokens !== undefined ? { dailyAiTokens: input.dailyAiTokens } : {}),
      updatedAt: at,
      updatedBy: input.actor,
      revision: (previous?.revision ?? 0) + 1,
    };
    DurableStore.upsert('operatorCaps', input.tenantId, cap as unknown as Record<string, unknown>);
    return cap;
  }

  /** Removes the override, restoring the base allowance. Returns the removed cap, if any. */
  public static clear(tenantId: string, actor: string): OperatorCap | undefined {
    if (typeof tenantId !== 'string' || tenantId.trim() === '') throw new Error('TENANT_CONTEXT_REQUIRED');
    if (typeof actor !== 'string' || actor.trim() === '') throw new Error('OPERATOR_ACTOR_REQUIRED');
    const previous = this.get(tenantId);
    if (previous) DurableStore.delete('operatorCaps', tenantId);
    return previous;
  }

  /** Test-only: drops every persisted override. */
  public static resetForTests(): void {
    for (const [tenantId] of DurableStore.entries('operatorCaps')) {
      DurableStore.delete('operatorCaps', tenantId);
    }
  }
}