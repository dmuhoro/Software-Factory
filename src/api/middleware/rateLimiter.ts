/**
 * Sliding Window Tenant Rate Limiting Middleware
 * Protects system capacity against quota exhaustion and noisy neighbors.
 */

import { Request, Response, NextFunction } from 'express';
import { emitSecurityError } from '../../utils/validation';

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, TokenBucket>();

export function tenantRateLimiter(req: Request, res: Response, next: NextFunction) {
  const tenantId = (req.headers['x-tenant-id'] as string) || req.body?.tenantId || 'anonymous';
  const now = Date.now();
  const maxTokens = 120; // 120 requests per minute
  const refillRate = maxTokens / 60000; // tokens per ms

  let bucket = buckets.get(tenantId);
  if (!bucket) {
    bucket = { tokens: maxTokens, lastRefill: now };
    buckets.set(tenantId, bucket);
  } else {
    const elapsed = now - bucket.lastRefill;
    bucket.tokens = Math.min(maxTokens, bucket.tokens + elapsed * refillRate);
    bucket.lastRefill = now;
  }

  if (bucket.tokens < 1) {
    res.setHeader('Retry-After', '2');
    return res.status(429).json(
      emitSecurityError('RATE_LIMIT_EXCEEDED', `Tenant '${tenantId}' has exceeded maximum burst quota. Retry shortly.`)
    );
  }

  bucket.tokens -= 1;
  res.setHeader('X-RateLimit-Remaining', Math.floor(bucket.tokens));
  next();
}
