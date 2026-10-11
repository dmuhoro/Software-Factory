/**
 * Per-tenant usage metering.
 *
 * The service declares an AI-token budget per tier (`maxDailyAiTokens`), but nothing ever
 * measured consumption, so the budget was a number with no reader. This is the meter: it
 * records what was actually reported by a dependency call, durably, per tenant per UTC day.
 *
 * Two rules make the meter honest:
 *
 *  - It records only observed usage. A dependency that reports no token count is recorded as
 *    zero, never as a plausible-looking constant. Metering a fabricated number would make the
 *    budget enforce a fiction.
 *  - A figure that is not a non-negative integer is refused, not coerced. A meter that rounds,
 *    guesses, or accepts `NaN` is not a meter.
 *
 * Enforcement lives with the caller that spends: `PipelineOrchestrator` refuses a cycle whose
 * tenant is already at or over its daily allowance before it calls the model, using
 * `budgetState`. This service measures the consumption the budget is enforced against, and
 * answers the one question the boundary needs (is the allowance spent?) without pretending to
 * reserve or atomically decrement a balance it does not own.
 */

import { DurableStore } from './durableStore';
import { TenantService } from './tenantService';

/** Whole seconds from now until the next UTC midnight. Never 0: "now" is inside today. */
function secondsUntilUtcMidnight(): number {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
  return Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000));
}

export interface UsageEvent {
  id: string;
  tenantId: string;
  /** What consumed the usage, e.g. `ai-transform`. */
  source: string;
  tokens: number;
  correlationId?: string;
  model?: string;
  recordedAt: string;
}

export interface UsageSummary {
  tenantId: string;
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  tokens: number;
  events: number;
}

/**
 * Where a tenant stands against its daily AI-token allowance at this instant. The allowance is
 * whatever the tenant profile declares; the consumption is the meter's own durable count.
 *
 * `reason` separates the two ways a tenant can have no spend available: the allowance is
 * *spent* (refusable as a retryable policy refusal) or the allowance is *unset/unknown* (a
 * configuration fault the boundary must refuse rather than spend against -- never a
 * wave-through). Budgets are whole non-negative integers; anything else is unmeasurable.
 */
export interface BudgetState {
  tenantId: string;
  /** The declared `maxDailyAiTokens`. `null` when the profile or its allowance is unmeasurable. */
  budget: number | null;
  consumed: number;
  remaining: number;
  exhausted: boolean;
  retryAfterSeconds?: number;
  reason: 'spent' | 'unset' | 'unknown';
}

function utcDay(at: string): string {
  return at.slice(0, 10);
}

/** A token figure must be a whole, non-negative count. Anything else is refused, not rounded. */
function assertTokenCount(tokens: unknown): number {
  if (typeof tokens !== 'number' || !Number.isInteger(tokens) || tokens < 0) {
    throw new Error(`USAGE_TOKENS_INVALID:${String(tokens)}`);
  }
  return tokens;
}

export class UsageMeteringService {
  public static record(input: { tenantId: string; source: string; tokens: number; correlationId?: string; model?: string }): UsageEvent {
    if (typeof input.tenantId !== 'string' || input.tenantId.trim() === '') throw new Error('TENANT_CONTEXT_REQUIRED');
    if (typeof input.source !== 'string' || input.source.trim() === '') throw new Error('USAGE_SOURCE_REQUIRED');
    const tokens = assertTokenCount(input.tokens);
    const at = new Date().toISOString();
    // Idempotent at the storage boundary: a retried call that carries the same correlation id
    // and source must not be counted twice. `deterministicId` hashes only its parts, so the same
    // retry maps to the same record; without a correlation id the event is distinct.
    const id = input.correlationId ? DurableStore.deterministicId('usage', input.tenantId, input.source, input.correlationId) : DurableStore.id('usage', at);
    const existing = DurableStore.get('usageEvents', id) as unknown as UsageEvent | undefined;
    if (existing) return existing;
    const event: UsageEvent = { id, tenantId: input.tenantId, source: input.source, tokens, correlationId: input.correlationId, model: input.model, recordedAt: at };
    DurableStore.upsert('usageEvents', id, event as unknown as Record<string, unknown>);
    return event;
  }

  /** Every usage event for a tenant, newest first. */
  public static list(tenantId: string): UsageEvent[] {
    return (DurableStore.list('usageEvents') as unknown as UsageEvent[])
      .filter((event) => event.tenantId === tenantId)
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  }

  /** Total tokens a tenant consumed on a given UTC day (defaults to today). */
  public static daily(tenantId: string, day = utcDay(new Date().toISOString())): UsageSummary {
    const events = this.list(tenantId).filter((event) => utcDay(event.recordedAt) === day);
    return { tenantId, day, tokens: events.reduce((sum, event) => sum + event.tokens, 0), events: events.length };
  }

  /** Per-day totals for a tenant, newest day first. */
  public static summaries(tenantId: string): UsageSummary[] {
    const byDay = new Map<string, { tokens: number; events: number }>();
    for (const event of this.list(tenantId)) {
      const day = utcDay(event.recordedAt);
      const current = byDay.get(day) ?? { tokens: 0, events: 0 };
      byDay.set(day, { tokens: current.tokens + event.tokens, events: current.events + 1 });
    }
    return [...byDay.entries()].map(([day, value]) => ({ tenantId, day, ...value })).sort((a, b) => b.day.localeCompare(a.day));
  }

  /**
   * Answers, durably, whether a tenant may still spend today. Never throws: a profile without a
   * measurable allowance is reported as exhausted with `reason: 'unset'`/`'unknown'` so the
   * boundary can fail closed on it, rather than guessing at an allowance the code cannot read.
   */
  public static budgetState(tenantId: string): BudgetState {
    const profile = TenantService.getTenant(tenantId);
    const allowance = typeof profile?.quota?.maxDailyAiTokens === 'number' ? profile.quota.maxDailyAiTokens : null;
    const measurable = allowance !== null && Number.isInteger(allowance) && allowance >= 0;
    // A budget of 0 is measurable and fully spent on arrival.
    const budget = measurable ? (allowance as number) : null;
    const consumed = this.daily(tenantId).tokens;
    const exhausted = !measurable ? true : consumed >= budget;
    const reason: BudgetState['reason'] = !profile ? 'unknown' : !measurable ? 'unset' : 'spent';
    return {
      tenantId,
      budget,
      consumed,
      remaining: measurable ? Math.max(0, budget - consumed) : 0,
      exhausted,
      ...(exhausted && reason === 'spent' ? { retryAfterSeconds: secondsUntilUtcMidnight() } : {}),
      reason,
    };
  }
}
