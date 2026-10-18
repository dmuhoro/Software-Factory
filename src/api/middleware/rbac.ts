/**
 * RBAC authorization.
 *
 * Wires `RbacService.check` into route handlers so role/permission bindings are
 * enforced, not just reported. Fail closed: an unrecognised permission or a missing
 * binding is a refusal, not a pass.
 *
 * Usage:
 *   if (!rbacRequire(req, res, 'loop:submit')) return;
 *
 * The `resource` argument, when given, is read from `req.params.resourceId` or
 * `req.body.resourceId` so a binding limited to named resources is honoured.
 */

import { Request, Response } from 'express';
import { RbacService, type Permission } from '../../services/rbacService';
import type { AuthenticatedPrincipal } from '../middleware/tenantAuth';
import { emitSecurityError } from '../../utils/validation';
import { classifyApiError, toErrorBody } from '../../utils/apiError';

type PrincipalRequest = Request & { principal?: AuthenticatedPrincipal };

/** Require `permission` on `resource` (optional). Returns false and sends a 403/401
 *  response when the check fails; returns true when the caller may proceed. */
export function rbacRequire(req: Request, res: Response, permission: Permission, resource?: string): boolean {
  const principal = (req as PrincipalRequest).principal;
  if (!principal) {
    res.status(401).json(emitSecurityError('UNAUTHORIZED', 'A valid credential is required.'));
    return false;
  }

  const decision = RbacService.check(principal, permission, resource);
  if (!decision.allowed) {
    const classified = classifyApiError(new Error(decision.reason ?? 'RBAC_PERMISSION_DENIED'));
    res.status(classified.status).json(toErrorBody(classified));
    return false;
  }
  return true;
}

export { type Permission };
