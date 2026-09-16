/**
 * Tenant Authentication & Context Middleware
 * Enforces API key verification and isolates tenant headers to prevent context leakage.
 */

import { Request, Response, NextFunction } from 'express';
import { emitSecurityError } from '../../utils/validation';
import { TenantService } from '../../services/tenantService';
import { IndustryNiche } from '../../models/tenant';

export function tenantAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  // Allow health check and schema inspection endpoints without tenant key
  if (req.path.startsWith('/health') || req.path.startsWith('/schemas')) {
    return next();
  }

  const tenantId = (req.headers['x-tenant-id'] as string) || req.body?.tenantId;
  const niche = (req.headers['x-industry-niche'] as string) || req.body?.niche;
  const correlationId = (req.headers['x-correlation-id'] as string) || `req_${Date.now()}`;

  if (!tenantId) {
    return res.status(401).json(emitSecurityError('UNAUTHORIZED', 'Missing required header: X-Tenant-Id or payload tenantId'));
  }

  if (niche) {
    const resolution = TenantService.resolveContext(tenantId, niche as IndustryNiche, correlationId);
    if (resolution.error) {
      return res.status(403).json(resolution.error);
    }
    (req as any).tenantContext = resolution.context;
  }

  next();
}
