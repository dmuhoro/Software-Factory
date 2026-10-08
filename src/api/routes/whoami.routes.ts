/**
 * `GET /api/whoami` — self-describing authorisation.
 *
 * A client should never have to guess what it is allowed to do. This endpoint answers,
 * for the caller's own credential, everything the enforcement layers already know:
 * which tenant it belongs to, whether it is the root credential or a scoped one, what
 * scopes it holds, what role it carries, and which permissions follow from that role.
 *
 * This is the shape that makes the earlier phases usable. Phase 3 narrowed a credential
 * and phase 7 constrained its role, but a client could only discover either by being
 * refused. Discovery by refusal is a support ticket; discovery by asking is a feature.
 *
 * It answers for the caller and nobody else. There is no `?tenantId=` here: an endpoint
 * that reports another tenant's posture would be an information leak wearing a helpfully
 * named route.
 *
 * ## What it deliberately does not return
 *
 * The credential, the credential's digest, and any secret. A caller already holds its
 * own credential; it does not need to be handed it back, and a response that echoes
 * secrets is one log line away from being a leak.
 */

import { Router, Request, Response } from 'express';
import type { AuthenticatedPrincipal } from '../middleware/tenantAuth';
import { RbacService, PERMISSIONS } from '../../services/rbacService';
import { resolveEnforcementMode } from '../../utils/enforcement';

const router = Router();

interface WhoAmI {
  tenantId: string;
  role: string | null;
  credential: { kind: 'root' | 'scoped'; id: string | null };
  scopes: string[];
  permissions: string[];
  enforcementMode: 'enforce' | 'log-only';
}

router.get('/', (req: Request, res: Response) => {
  // The PRINCIPAL's tenant, never a claimed one. An endpoint that answered for a
  // claimed tenant id would be an information leak wearing a helpfully named route.
  const principal = (req as Request & { principal?: AuthenticatedPrincipal }).principal;
  if (!principal || !principal.tenantId) {
    // The middleware guarantees both, but a missing one is a refusal, not a default.
    res.status(401).json({ status: 'error', code: 'UNAUTHORIZED', message: 'A valid credential is required.' });
    return;
  }

  const rbacRole = RbacService.roleFor(principal);
  const body: WhoAmI = {
    tenantId: principal.tenantId,
    role: rbacRole ?? null,
    credential: { kind: principal.kind, id: principal.credentialId ?? null },
    scopes: [...principal.scopes],
    permissions: rbacRole ? RbacService.permissionsFor(rbacRole) : [],
    enforcementMode: resolveEnforcementMode(process.env.FACTORY_ENFORCEMENT_MODE),
  };
  res.status(200).json(body);
});

/**
 * The permission catalogue, so a client can render controls it has never seen before
 * without hard-coding the list. Read-only and identical for every caller: a catalogue
 * is a schema, not a capability, so it is not tenant-scoped.
 */
router.get('/permissions', (_req: Request, res: Response) => {
  res.status(200).json({ permissions: [...PERMISSIONS], note: 'Holding a permission is decided per principal; this is the closed set.' });
});

export default router;
