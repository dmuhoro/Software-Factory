import { timingSafeEqual } from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { emitMalformedContextError, emitSecurityError } from '../../utils/validation';
import { TenantService } from '../../services/tenantService';
import { IndustryNiche } from '../../models/tenant';
import { TelemetryLogger } from '../../utils/telemetryLogger';

function secureEquals(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type AuthenticatedRole = 'tenant_operator' | 'platform_operator';

export interface AuthenticatedPrincipal {
  tenantId: string;
  role: AuthenticatedRole;
}

type PrincipalRequest = Request & { principal?: AuthenticatedPrincipal; tenantContext?: unknown };

/**
 * Routes that must answer before a tenant context exists, so they cannot be
 * authenticated. Exported because the rate limiter needs the same list: it keys on the
 * authenticated principal, and a public path has none, so without this the limiter
 * would reject the very endpoints orchestrators and scrapers depend on.
 */
export function isPublicPath(reqPath: string): boolean {
  // A path we cannot read is not a path we can excuse. An unreadable path is treated as
  // PROTECTED, so the caller is refused rather than waved through. This must fail closed:
  // a crash or a permissive default here would expose every tenant-scoped route.
  if (typeof reqPath !== 'string' || reqPath === '') return false;
  // `req.path` is relative to whichever router the middleware is mounted on, so the same
  // endpoint appears as '/metrics' under one mount and '/factory/metrics' under another.
  // Matching the trailing segment keeps the allowlist correct at every mount point
  // instead of silently depending on where the middleware happens to sit.
  const normalised = reqPath.replace(/\/+$/, '') || '/';
  if (normalised === '/health' || normalised === '/ready' || normalised === '/metrics') return true;
  if (normalised === '/factory/health' || normalised === '/factory/ready' || normalised === '/factory/metrics') return true;
  return normalised.startsWith('/schemas');
}

function presentedCredential(req: Request): string | undefined {
  const header = (req.headers['x-api-key'] as string | undefined)?.trim();
  if (header) return header;
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match) return match[1].trim();
  }
  return undefined;
}

/** Query and body values are attacker-controlled and may be arrays or objects. */
function firstString(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (Array.isArray(value)) return firstString(value[0]);
  return undefined;
}

function isLoopback(req: Request): boolean {
  const remote = req.ip || req.socket.remoteAddress || '';
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

/**
 * Authenticates the caller and BINDS it to exactly one tenant partition.
 *
 * Previously the only check was "does the presented key equal the single global
 * FACTORY_API_KEY", after which the `X-Tenant-Id` header was believed. One leaked key
 * therefore granted every tenant's data. Now:
 *
 *  - a tenant credential resolves to exactly one tenant, and a claim for any other
 *    tenant is refused (Constitution Article I, zero cross-tenant conflation);
 *  - the platform key may act for any tenant, but only as `platform_operator`, and the
 *    impersonation is recorded so it is visible in the audit trail;
 *  - a tenant with no provisioned credential is inert, because a registry entry without
 *    a verifiable digest cannot authenticate anyone.
 */
export async function tenantAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  if (isPublicPath(req.path)) return next();

  const typed = req as PrincipalRequest;

  // Development affordance: loopback callers may skip credentials entirely, but only
  // outside production and only with the flag set. The binding below still applies, so
  // a local caller cannot reach a tenant that has no profile.
  const localDev = process.env.NODE_ENV !== 'production' && process.env.ALLOW_INSECURE_LOCAL === 'true';
  if (localDev && !presentedCredential(req) && isLoopback(req)) {
    resolveTenantContext(req, res, next, { tenantId: 'local-development', role: 'platform_operator' }, true);
    return;
  }

  const presented = presentedCredential(req);
  if (!presented) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="software-factory"');
    return res.status(401).json(emitSecurityError('UNAUTHORIZED', 'Valid API credentials are required'));
  }

  const platformKey = process.env.FACTORY_API_KEY;
  if (platformKey && secureEquals(presented, platformKey)) {
    // The platform key is an operator credential, not a tenant credential. It is
    // recorded on every use so cross-tenant access is always attributable.
    TelemetryLogger.warn('Platform credential used', {
      metadata: { claimedTenant: (req.headers['x-tenant-id'] as string) || (req.body as { tenantId?: string })?.tenantId || null, path: req.path },
    });
    resolveTenantContext(req, res, next, { tenantId: 'platform', role: 'platform_operator' }, true);
    return;
  }

  const owner = await TenantService.resolveCredentialOwner(presented);
  if (!owner) {
    // Deliberately identical to "no credential supplied", so a caller cannot use the
    // response to discover which tenant ids exist.
    return res.status(401).json(emitSecurityError('UNAUTHORIZED', 'Valid API credentials are required'));
  }

  resolveTenantContext(req, res, next, { tenantId: owner.tenantId, role: 'tenant_operator' }, false);
}

/**
 * Applies the tenant claim against the authenticated principal.
 *
 * `mayActForAnyTenant` is true only for platform/local operators. For a tenant
 * credential the claimed tenant MUST be the credential's owner, whether the claim
 * arrives in the header, the body, or the query string; otherwise the caller's own
 * context is used and a mismatch is refused. Checking one source but reading another is
 * exactly the conflation this guards against.
 */
function resolveTenantContext(
  req: Request,
  res: Response,
  next: NextFunction,
  principal: AuthenticatedPrincipal,
  mayActForAnyTenant: boolean,
): void {
  const typed = req as PrincipalRequest;
  const headerClaim = firstString(req.headers['x-tenant-id']);
  const bodyClaim = firstString((req.body as { tenantId?: unknown } | undefined)?.tenantId);
  const queryClaim = firstString(req.query.tenantId);
  const claimed = headerClaim || bodyClaim || queryClaim;

  if (!mayActForAnyTenant && principal.tenantId !== 'local-development') {
    for (const source of [headerClaim, bodyClaim, queryClaim]) {
      if (source && source !== principal.tenantId) {
        TelemetryLogger.warn('Cross-tenant access refused', {
          metadata: { credentialTenant: principal.tenantId, claimedTenant: source, path: req.path },
        });
        res.status(403).json(emitSecurityError(
          'TENANT_CREDENTIAL_MISMATCH',
          'The presented credential is not authorised for the requested tenant',
        ));
        return;
      }
    }
  }

  const tenantId = mayActForAnyTenant ? (claimed || principal.tenantId) : principal.tenantId;
  if (!tenantId) {
    res.status(401).json(emitSecurityError('TENANT_CONTEXT_REQUIRED', 'A tenant context is required'));
    return;
  }

  const niche = firstString(req.headers['x-industry-niche']) || firstString((req.body as { niche?: unknown } | undefined)?.niche);
  const correlationId = firstString(req.headers['x-correlation-id']) || `req_${Date.now()}`;

  const profile = TenantService.getTenant(tenantId);
  if (!profile) {
    res.status(403).json(emitSecurityError('TENANT_NOT_FOUND', `Tenant '${tenantId}' is not registered`));
    return;
  }

  if (niche) {
    const resolution = TenantService.resolveContext(tenantId, niche as IndustryNiche, correlationId);
    if (resolution.error) { res.status(403).json(resolution.error); return; }
    typed.tenantContext = { ...resolution.context, authenticatedRole: principal.role };
  } else {
    typed.tenantContext = {
      tenantId: profile.id,
      niche: profile.niche,
      tier: profile.tier,
      correlationId,
      authenticatedRole: principal.role,
      quota: profile.quota,
    };
  }
  typed.principal = principal;
  next();
}

export function requireTenantMatch(req: Request, tenantId: string): boolean {
  const context = (req as Request & { tenantContext?: { tenantId?: string } }).tenantContext;
  return context?.tenantId === tenantId;
}

export function validateTenantRequest(req: Request, res: Response): boolean {
  const tenantId = (req.body?.tenantId || req.query.tenantId || req.headers['x-tenant-id']) as string | undefined;
  if (!tenantId || !requireTenantMatch(req, tenantId)) {
    res.status(403).json(emitMalformedContextError('Requested tenant does not match authenticated tenant context'));
    return false;
  }
  return true;
}
