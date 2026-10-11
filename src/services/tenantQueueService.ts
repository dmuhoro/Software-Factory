/**
 * Per-tenant queue isolation and fair-share concurrency.
 *
 * The loop already refuses to run when the HOST is exhausted (`ResourceGovernorService`), but that
 * is a global bound: one tenant with many repositories could occupy every admitted slot and starve
 * every other tenant. A global cap with no per-tenant bound is not isolation, it is a race.
 *
 * This is the missing boundary. Admission is decided here, before any work starts, on three rules
 * that each fail closed:
 *
 *  - **A per-tenant cap derived from the subscription tier.** A `starter` tenant gets one
 *    concurrent run, `professional` two, `enterprise` four. An environment value may only tighten
 *    it (`FACTORY_TENANT_CONCURRENCY` is a ceiling), never loosen it past the tier.
 *  - **Fair-share when tenants compete.** A tenant may hold at most `floor(globalCap / competitors)`
 *    of the host's admitted slots, where `competitors` is the number of distinct tenants currently
 *    holding a slot (plus this one). Alone, a tenant may use its whole tier cap; the moment a second
 *    tenant arrives, the first can no longer grow past half the host, and neither can the second.
 *    This is deliberately non-preemptive -- a run already holding a slot is never killed -- so the
 *    division takes effect on the next admission, not retroactively.
 *  - **An unknown principal is held to the most conservative tier, not waved through.** A tenant
 *    that is not in the registry has no tier to divide by; it is capped like a `starter` rather than
 *    given the host.
 *
 * Tracking is process-local and in-memory on purpose, exactly like loop cancellation: "in flight"
 * is a fact about *this* process's execution, not a durable fact about the world. After a restart
 * there are no in-flight runs to count, so nothing needs persisting. A multi-replica deployment
 * would need a shared counter, which is named as an open item rather than faked here.
 */

import { TenantService } from './tenantService';
import { ResourceGovernorService } from './resourceGovernorService';
import { TenantSubscriptionTier } from '../models/tenant';

/** Concurrent runs a tier may hold, before any operator or environment tightening. */
const TIER_CONCURRENCY: Record<TenantSubscriptionTier, number> = {
  [TenantSubscriptionTier.STARTER]: 1,
  [TenantSubscriptionTier.PROFESSIONAL]: 2,
  [TenantSubscriptionTier.ENTERPRISE]: 4,
};

/** The cap applied to a principal the registry does not know. Conservative on purpose. */
const UNREGISTERED_CONCURRENCY = 1;

function positiveEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return undefined;
  return Math.floor(value);
}

export interface TenantQueueAdmission {
  admitted: boolean;
  tenantId: string;
  /** The registered tier, or `unregistered` when the registry knows no such tenant. */
  tier: TenantSubscriptionTier | 'unregistered';
  /** The effective per-tenant cap: min(tier cap, fair share, environment cap). */
  limit: number;
  tierLimit: number;
  fairShare: number;
  /** This tenant's in-flight runs before the decision. */
  inFlight: number;
  globalCap: number;
  totalInFlight: number;
  /** The lease to release with when this admission is done. Empty when refused. */
  leaseId: string;
  reasons: string[];
}

export class TenantQueueService {
  /** tenantId -> number of runs currently holding a slot. */
  private static readonly inFlight = new Map<string, number>();
  /** leaseId -> tenantId, so a release decrements the right tenant. */
  private static readonly leases = new Map<string, string>();

  /** The tier's concurrent-run allowance, tightened by environment only. */
  public static tierLimit(tier: TenantSubscriptionTier | 'unregistered'): number {
    const base = tier === 'unregistered' ? UNREGISTERED_CONCURRENCY : TIER_CONCURRENCY[tier];
    const env = positiveEnv('FACTORY_TENANT_CONCURRENCY');
    return env === undefined ? base : Math.min(base, env);
  }

  /** The cap this tenant may hold when nobody else is competing. */
  public static limitFor(tenantId: string): number {
    const profile = TenantService.getTenant(tenantId);
    return this.tierLimit(profile ? profile.tier : 'unregistered');
  }

  public static globalCap(): number {
    return ResourceGovernorService.cap();
  }

  public static inFlightCount(tenantId: string): number {
    return this.inFlight.get(tenantId) ?? 0;
  }

  public static totalInFlight(): number {
    let total = 0;
    for (const count of this.inFlight.values()) total += count;
    return total;
  }

  /** Every tenant currently holding a slot, with its live count and effective cap. */
  public static snapshot(): Array<{ tenantId: string; inFlight: number; limit: number }> {
    return [...this.inFlight.entries()]
      .filter(([, count]) => count > 0)
      .map(([tenantId, count]) => ({ tenantId, inFlight: count, limit: this.limitFor(tenantId) }))
      .sort((a, b) => b.inFlight - a.inFlight || a.tenantId.localeCompare(b.tenantId));
  }

  /**
   * Decides one admission without changing any state. Pure, so a caller can ask "may I?" and a
   * test can assert the reason without having to acquire and unwind a real run.
   */
  public static admit(tenantId: string): TenantQueueAdmission {
    const profile = TenantService.getTenant(tenantId);
    const tier: TenantSubscriptionTier | 'unregistered' = profile ? profile.tier : 'unregistered';
    const tierLimit = this.tierLimit(tier);
    const globalCap = this.globalCap();
    const totalInFlight = this.totalInFlight();
    const inFlight = this.inFlightCount(tenantId);

    // Competitors are the distinct tenants already holding a slot, plus this tenant if it holds
    // none. A tenant alone on the host divides the host by one and may use its whole tier cap.
    const holders = new Set([...this.inFlight.entries()].filter(([, count]) => count > 0).map(([id]) => id));
    const competitors = holders.has(tenantId) ? holders.size : holders.size + 1;
    const fairShare = Math.max(1, Math.floor(globalCap / Math.max(1, competitors)));
    const limit = Math.min(tierLimit, fairShare);
    const reasons: string[] = [];

    if (globalCap < 1) reasons.push('GLOBAL_CAPACITY:0');
    else if (totalInFlight >= globalCap) reasons.push(`GLOBAL_CAPACITY:in-flight=${totalInFlight},cap=${globalCap}`);
    if (inFlight >= limit) reasons.push(`TENANT_CAP:in-flight=${inFlight},limit=${limit},tier=${tier}`);

    const admitted = reasons.length === 0;
    return {
      admitted,
      tenantId,
      tier,
      limit,
      tierLimit,
      fairShare,
      inFlight,
      globalCap,
      totalInFlight,
      leaseId: '',
      reasons,
    };
  }

  /**
   * Reserves a slot for this tenant. Returns the admission; when admitted, the caller MUST call
   * `release(leaseId)` exactly once when the run settles, or the tenant leaks its cap forever.
   */
  public static acquire(tenantId: string, leaseId: string): TenantQueueAdmission {
    if (typeof leaseId !== 'string' || leaseId.trim() === '') throw new Error('TENANT_QUEUE_LEASE_REQUIRED');
    if (this.leases.has(leaseId)) throw new Error('TENANT_QUEUE_LEASE_REUSED');
    const decision = this.admit(tenantId);
    if (!decision.admitted) return decision;
    this.inFlight.set(tenantId, decision.inFlight + 1);
    this.leases.set(leaseId, tenantId);
    return { ...decision, leaseId };
  }

  /** Releases one slot. Idempotent: releasing an unknown lease is a miss, not an error. */
  public static release(leaseId: string): boolean {
    const tenantId = this.leases.get(leaseId);
    if (tenantId === undefined) return false;
    this.leases.delete(leaseId);
    const next = (this.inFlight.get(tenantId) ?? 1) - 1;
    if (next <= 0) this.inFlight.delete(tenantId);
    else this.inFlight.set(tenantId, next);
    return true;
  }

  /** Test-only: drops all in-flight accounting. */
  public static resetForTests(): void {
    this.inFlight.clear();
    this.leases.clear();
  }
}
