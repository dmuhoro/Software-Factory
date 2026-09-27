/**
 * Tenant credential hashing and verification.
 *
 * `TenantProfile.apiKeyHash` was declared in the domain model but never verified by
 * anything: authentication compared the caller's key against one global
 * `FACTORY_API_KEY` and then believed whatever `X-Tenant-Id` header followed. Any
 * holder of that single key could act as any registered tenant.
 *
 * Credentials are stored only as salted scrypt digests. The plaintext is shown once at
 * provisioning and is never persisted, logged, or returned by any read path.
 *
 * Digest format: `scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>`, which carries its own
 * parameters so the cost can be raised later without invalidating existing tenants.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

const PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const PREFIX = 'scrypt';

/**
 * Produces a storable digest for a plaintext tenant credential.
 * Use at provisioning time only; the plaintext must not be retained by the caller.
 */
export async function hashTenantCredential(plaintext: string): Promise<string> {
  if (typeof plaintext !== 'string' || plaintext.length < 24) {
    throw new Error('A tenant credential must be at least 24 characters');
  }
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(plaintext, salt, KEY_LENGTH, { ...PARAMS, maxmem: 64 * 1024 * 1024 });
  return [PREFIX, PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('hex'), derived.toString('hex')].join('$');
}

/**
 * Verifies a presented credential against a stored digest in constant time.
 *
 * Returns false for every malformed or legacy digest rather than throwing, so a
 * placeholder value left in the registry can never be treated as a valid credential.
 */
export async function verifyTenantCredential(plaintext: string, storedDigest: string | undefined): Promise<boolean> {
  if (typeof plaintext !== 'string' || plaintext.length === 0) return false;
  if (typeof storedDigest !== 'string') return false;
  const parts = storedDigest.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // Refuse absurd parameters from a tampered record rather than allocating against them.
  if (N > 1 << 20 || r > 32 || p > 16) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], 'hex');
    expected = Buffer.from(parts[5], 'hex');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  try {
    const derived = await scrypt(plaintext, salt, expected.length, { N, r, p, maxmem: 256 * 1024 * 1024 });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** True when a digest is in the format this module produces. */
export function isCredentialDigest(value: unknown): value is string {
  return typeof value === 'string' && value.split('$').length === 6 && value.startsWith(`${PREFIX}$`);
}
