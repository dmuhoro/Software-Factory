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
 * Enforcement of the daily token *budget* is deliberately out of scope here: it can only be
 * exercised against real model usage, which lands with WP-5. This service measures; it does
 * not yet cap.
 */

import { DurableStore } from './durableStore';

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
}
