/**
 * Tenant rate limiting.
 *
 * Two defects in the previous implementation:
 *
 *  1. It keyed on `X-Tenant-Id`, a value the caller chooses, and ran BEFORE
 *     authentication. Rotating that header handed every request a fresh bucket, so the
 *     limiter slowed down nobody. A control that a caller can sidestep by editing a
 *     header is not a control.
 *  2. It used a hardcoded 120 requests/minute regardless of subscription tier, while
 *     `TenantQuota` declares a real limit per tier. The declared quota was fiction.
 *
 * It now runs after authentication and keys on the resolved principal, applying the
 * tenant's own quota and burst capacity.
 */
import { Request, Response, NextFunction } from 'express';
import { emitSecurityError } from '../../utils/validation';
import { TenantService } from '../../services/tenantService';
import { isPublicPath } from './tenantAuth';

interface TokenBucket {
  tokens: number;
  lastRefill: number;
  lastSeen: number;
}

const buckets = new Map<string, TokenBucket>();

/** Buckets idle for longer than this are evicted, so the map cannot be grown without bound. */
const BUCKET_IDLE_MS = 10 * 60 * 1000;
/** Hard ceiling on tracked buckets, independent of the idle sweep. */
const MAX_BUCKETS = 10_000;
/** Ceiling applied when a tenant's declared quota is absent or nonsensical. */
const FALLBACK_RPM = 120;
const FALLBACK_BURST = 30;

function evictIdle(now: number): void {
  for (const [key, bucket] of buckets) {
    if (now - bucket.lastSeen > BUCKET_IDLE_MS) buckets.delete(key);
  }
  // A flood of distinct identities must not be able to exhaust memory. When the ceiling
  // is hit, the least recently seen bucket is dropped rather than refusing to track.
  while (buckets.size > MAX_BUCKETS) {
    let oldestKey: string | undefined;
    let oldestSeen = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of buckets) {
      if (bucket.lastSeen < oldestSeen) { oldestSeen = bucket.lastSeen; oldestKey = key; }
    }
    if (!oldestKey) break;
    buckets.delete(oldestKey);
  }
}

function quotaFor(tenantId: string): { maxRequestsPerMinute: number; burstCapacity: number } {
  const profile = TenantService.getTenant(tenantId);
  const quota = profile?.quota;
  const rpm = Number(quota?.maxRequestsPerMinute);
  const burst = Number(quota?.burstCapacity);
  return {
    maxRequestsPerMinute: Number.isFinite(rpm) && rpm > 0 ? rpm : FALLBACK_RPM,
    burstCapacity: Number.isFinite(burst) && burst > 0 ? burst : FALLBACK_BURST,
  };
}

/**
 * Consumes one token for the AUTHENTICATED principal.
 *
 * Must be mounted after `tenantAuthMiddleware`. If it runs before authentication there
 * is no trustworthy identity to limit, and the only available key is caller-controlled.
 */
export function tenantRateLimiter(req: Request, res: Response, next: NextFunction) {
  const principal = (req as Request & { principal?: { tenantId: string; role: string } }).principal;

  // Health, readiness and metrics are unauthenticated by design so orchestrators and
  // scrapers can reach them. They are not tenant-scoped, so there is no tenant quota to
  // apply; they are excluded rather than given a shared bucket.
  if (!principal && isPublicPath(req.path)) return next();

  // Failing closed: a request on a PROTECTED path that reached the limiter without an
  // authenticated principal is refused rather than given a shared anonymous bucket.
  if (!principal) {
    res.setHeader('Retry-After', '1');
    return res.status(401).json(emitSecurityError('UNAUTHORIZED', 'Rate limiting requires an authenticated tenant context'));
  }

  const { tenantId, role } = principal;
  const now = Date.now();
  const { maxRequestsPerMinute, burstCapacity } = quotaFor(tenantId);
  // A platform operator is an operator of the whole factory, not one tenant, so it is
  // not throttled to a single tenant's quota.
  const maxTokens = role === 'platform_operator' ? maxRequestsPerMinute * 10 : maxRequestsPerMinute;
  const refillRate = maxTokens / 60_000;

  let bucket = buckets.get(tenantId);
  if (!bucket) {
    evictIdle(now);
    bucket = { tokens: Math.min(maxTokens, burstCapacity), lastRefill: now, lastSeen: now };
    buckets.set(tenantId, bucket);
  } else {
    bucket.tokens = Math.min(maxTokens, bucket.tokens + (now - bucket.lastRefill) * refillRate);
    bucket.lastRefill = now;
    bucket.lastSeen = now;
  }

  res.setHeader('X-RateLimit-Limit', String(Math.round(maxTokens)));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, Math.floor(bucket.tokens))));

  if (bucket.tokens < 1) {
    const retryAfter = Math.max(1, Math.ceil((1 - bucket.tokens) / refillRate));
    res.setHeader('Retry-After', String(retryAfter));
    res.setHeader('X-RateLimit-Remaining', '0');
    return res.status(429).json(emitSecurityError(
      'RATE_LIMIT_EXCEEDED',
      `Tenant '${tenantId}' has exceeded its ${Math.round(maxRequestsPerMinute)} requests/minute quota. Retry in ${retryAfter}s.`,
    ));
  }

  bucket.tokens -= 1;
  return next();
}

/** Test-only: clears limiter state. */
export function resetRateLimiterForTests(): void {
  buckets.clear();
}
