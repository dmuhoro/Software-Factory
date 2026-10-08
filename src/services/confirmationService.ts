/**
 * Two-phase confirmation for irreversible control-plane operations.
 *
 * ## Where the shape comes from
 *
 * WorkOS issues a single-use confirmation token from a first call and requires it back on the
 * second call before executing a permanent deletion or a billing change. The value of the shape
 * is that an irreversible operation cannot be reached by a single mistyped request: the caller
 * has to come back, look at what it is about to do, and present a token only that first call
 * could have produced.
 *
 * ## What is deliberately different
 *
 * WorkOS pairs the token with a failOpen tolerance elsewhere in its stack. There is no such
 * tolerance here. An expired, reused, or mismatched token is a refusal, and a refusal is the
 * only outcome: there is no configuration that lets the operation proceed.
 *
 * ## Why memory and not the ledger
 *
 * A pending confirmation is a conversation with one caller, not a fact about the world. It must
 * not survive a restart: a token that outlives the process that issued it was never consented to
 * by anything still running. TTL alone is not enough, because a restarted process could
 * otherwise be handed a token minted under different doctrine.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

/** How long a confirmation stays valid. Short: the caller is expected to be looking at it. */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

interface PendingConfirmation {
  token: string;
  tenantId: string;
  operation: string;
  subjectId: string;
  expiresAtMs: number;
}

export interface IssuedConfirmation {
  /** Single-use token the caller must present on the second call. */
  confirmationToken: string;
  /** ISO-8601 instant after which the token is refused. */
  expiresAt: string;
}

const pending = new Map<string, PendingConfirmation>();

function key(tenantId: string, operation: string, subjectId: string): string {
  return [tenantId, operation, subjectId].join(String.fromCharCode(0));
}

/** Drop anything that can no longer be redeemed. Runs on every issue and every consume. */
function sweep(nowMs: number): void {
  for (const [id, entry] of pending) if (entry.expiresAtMs <= nowMs) pending.delete(id);
}

export class ConfirmationService {
  /**
   * Issue the token for an irreversible operation.
   *
   * Issuing again for the same (tenant, operation, subject) replaces the previous token rather
   * than issuing a second one. Two live tokens for the same pending destruction would let the
   * caller confirm either, which defeats the point of a single-use token.
   */
  public static issue(input: { tenantId: string; operation: string; subjectId: string; ttlMs?: number }): IssuedConfirmation {
    const nowMs = Date.now();
    sweep(nowMs);

    const id = key(input.tenantId, input.operation, input.subjectId);
    pending.delete(id);

    const token = randomBytes(32).toString('hex');
    const expiresAtMs = nowMs + (input.ttlMs ?? DEFAULT_TTL_MS);
    pending.set(id, { token, tenantId: input.tenantId, operation: input.operation, subjectId: input.subjectId, expiresAtMs });

    return { confirmationToken: token, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  /**
   * Redeem the token. Single-use: a consume removes it, so a replayed request is refused even
   * inside the TTL.
   *
   * Returns false - never throws - for every failure mode. A caller that guesses wrong must not
   * be able to tell an expired token from a foreign one from a never-issued one, because that
   * difference is exactly what makes a token brute-forceable.
   */
  public static consume(input: { token: unknown; tenantId: string; operation: string; subjectId: string }): boolean {
    const nowMs = Date.now();
    sweep(nowMs);

    const presented = typeof input.token === 'string' ? input.token : '';
    if (!presented) return false;

    const id = key(input.tenantId, input.operation, input.subjectId);
    const entry = pending.get(id);
    if (!entry) return false;

    const a = Buffer.from(presented, 'utf8');
    const b = Buffer.from(entry.token, 'utf8');
    // A length mismatch would throw under timingSafeEqual, so lengths are compared first.
    const matches = a.length === b.length && timingSafeEqual(a, b);

    // Single-use regardless of whether it matched: a wrong guess against a live confirmation
    // invalidates it, so a caller cannot brute-force its way past the second phase.
    pending.delete(id);
    return matches;
  }

  /** Test seam. Nothing in the product calls this. */
  public static reset(): void {
    pending.clear();
  }
}
