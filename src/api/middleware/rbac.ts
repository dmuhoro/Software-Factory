/**
 * RBAC authorization middleware.
 *
 * Wires `RbacService.check` into route handlers so that role/permission bindings
 * are enforced, not just reported. A principal with no binding holds no role and
 * no permission; a binding that does not reach the resource is refused. Fail
 * closed: an unrecognised permission or a missing binding is a 403, not a pass.
 *
 * Usage:
 *   router.post('/runs', rbacRequire('loop:submit'), ...);
 *
 * The `resource` argument, when given, is read from `req.params.resourceId` or
 * `req.body.resourceId` so a binding limited to named resources is honoured.
 */

import { Request, Response, NextFunction } from 'express';
import { RbacService, type Permission } from '../../services/rbacService';
import type { AuthenticatedPrincipal } from '../middleware/tenantAuth';
import { emitSecurityError } from '../../utils/validation';
import { classifyApiError, toErrorBody } from '../../utils/apiError';

/** Middleware factory: require `permission` on `resource` (optional, derived from the request). */
export function rbacRequire(permission: Permission, resourceFrom?: (req: Request) => string | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const principal = (req as { principal?: AuthenticatedPrincipal }).principal;
    if (!principal) {
      res.status(401).json(emitSecurityError('UNAUTHORIZED', 'A valid credential is required.'));
      return;
    }

    const resource = resourceFrom ? resourceFrom(req) : undefined;
    const decision = RbacService.check(principal, permission, resource);

    if (!decision.allowed) {
      const classified = classifyApiError(new Error(decision.reason ?? 'RBAC_PERMISSION_DENIED'));
      res.status(classified.status).json(toErrorBody(classified));
      return;
    }
    next();
  };
}

export { type Permission };
