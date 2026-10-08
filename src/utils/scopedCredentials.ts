/**
 * Scoped, expiring tenant credentials.
 *
 * Every tenant always has exactly one root credential (`TenantProfile.apiKeyHash`): it
 * is long-lived and unrestricted, and it is what an operator uses to administer the
 * tenant. A scoped credential is strictly narrower than that root and is what you hand
 * to an integration that needs to do one thing. It expires on its own, carries an
 * explicit list of what it may do, and can be revoked without touching the root.
 *
 * ## Why the scopes are a closed set
 *
 * The requirement for a request is derived from its method and path, and any protected
 * path that does not match a known family demands `admin`. A scoped credential holding
 * only `loop:read` therefore cannot reach a route nobody thought about: the default is
 * refusal, not access. This is the same fail-closed posture as `isPublicPath`.
 *
 * ## Why nothing here is signed
 *
 * The obvious alternative is a self-describing signed token carrying its own scopes and
 * expiry, which needs no lookup. It also needs a signing dependency this repository does
 * not have and a revocation story that is harder to reason about, and a hand-rolled
 * signer on a credential boundary is exactly the kind of cryptography that must not be
 * invented. Scopes and expiry are stored beside the scrypt digest instead, so the only
 * secret comparison in this path is the one already reviewed in `tenantCredentials.ts`.
 */

/** The closed set of scopes. An unrecognised value is refused, never ignored. */
export const SCOPES = ['loop:read', 'loop:write', 'admin'] as const;
export type Scope = (typeof SCOPES)[number];

const SCOPE_SET = new Set<string>(SCOPES);

export function isScope(value: unknown): value is Scope {
  return typeof value === 'string' && SCOPE_SET.has(value);
}

/**
 * Validates a stored or requested scope list, refusing anything unrecognised.
 *
 * An empty list is valid to parse and grants nothing: a credential with no scopes can
 * authenticate and then be refused at the first protected route, which is the correct
 * shape for "provisioned but not yet granted".
 */
export function parseScopes(raw: unknown): Scope[] {
  if (!Array.isArray(raw)) throw new Error(`scopes must be an array, received ${typeof raw}`);
  const out: Scope[] = [];
  for (const entry of raw) {
    if (!isScope(entry)) {
      throw new Error(`scope '${String(entry)}' is not one of ${SCOPES.join(', ')}`);
    }
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

/**
 * The scope a request requires, or `null` when the path is public.
 *
 * Deliberately conservative: anything that is not a recognised, unprotected loop route
 * requires `admin`. Adding a route therefore automatically denies every scoped
 * credential until someone grants the matching scope on purpose, which is the only safe
 * direction for this to fail in.
 */
export function requiredScope(method: string, path: string): Scope | null {
  const normalisedPath = path.replace(/\/+$/, '') || '/';
  const upper = (method || 'GET').toUpperCase();

  // Mirror of the public paths tenantAuth already excuses; those need no scope.
  const segments = normalisedPath.split('/').filter(Boolean);
  const tail = segments.slice(-2).join('/');
  if (['health', 'ready', 'metrics'].includes(segments[segments.length - 1] ?? '')) return null;
  if (['factory/health', 'factory/ready', 'factory/metrics'].includes(tail)) return null;
  if (normalisedPath.startsWith('/schemas') || tail.startsWith('schemas')) return null;

  const loopIndex = segments.lastIndexOf('loop');
  if (loopIndex !== -1) {
    const isRead = upper === 'GET' || upper === 'HEAD' || upper === 'OPTIONS';
    return isRead ? 'loop:read' : 'loop:write';
  }
  return 'admin';
}

/** True when a granted scope set satisfies a requirement. `admin` satisfies everything. */
export function scopeCovers(granted: readonly Scope[], required: Scope): boolean {
  return granted.includes('admin') || granted.includes(required);
}
