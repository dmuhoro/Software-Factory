import { timingSafeEqual } from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { emitMalformedContextError, emitSecurityError } from '../../utils/validation';
import { TenantService } from '../../services/tenantService';
import { IndustryNiche } from '../../models/tenant';

function secureEquals(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isAuthenticated(req: Request): boolean {
  const configured = process.env.FACTORY_API_KEY;
  const supplied = (req.headers['x-api-key'] as string | undefined) || req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (configured && supplied && secureEquals(supplied, configured)) return true;
  const localDev = process.env.NODE_ENV !== 'production' && process.env.ALLOW_INSECURE_LOCAL === 'true';
  const remote = req.ip || req.socket.remoteAddress || '';
  return localDev && (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1');
}

export function tenantAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  if (req.path.startsWith('/health') || req.path.startsWith('/schemas')) return next();
  if (!isAuthenticated(req)) return res.status(401).json(emitSecurityError('UNAUTHORIZED', 'Valid API credentials are required'));

  const tenantId = (req.headers['x-tenant-id'] as string) || req.body?.tenantId || (req.query.tenantId as string);
  const niche = (req.headers['x-industry-niche'] as string) || req.body?.niche;
  const correlationId = (req.headers['x-correlation-id'] as string) || `req_${Date.now()}`;
  if (!tenantId) return res.status(401).json(emitSecurityError('TENANT_CONTEXT_REQUIRED', 'A tenant context is required'));

  const profile = TenantService.getTenant(tenantId);
  if (!profile) return res.status(403).json(emitSecurityError('TENANT_NOT_FOUND', `Tenant '${tenantId}' is not registered`));
  if (niche) {
    const resolution = TenantService.resolveContext(tenantId, niche as IndustryNiche, correlationId);
    if (resolution.error) return res.status(403).json(resolution.error);
    (req as Request & { tenantContext?: unknown }).tenantContext = resolution.context;
  } else {
    (req as Request & { tenantContext?: unknown }).tenantContext = { tenantId: profile.id, niche: profile.niche, tier: profile.tier, correlationId, authenticatedRole: 'tenant_operator', quota: profile.quota };
  }
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
