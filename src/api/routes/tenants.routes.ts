/**
 * Tenants Management & Partition Verification Routes
 * GET /api/tenants - Lists registered tenant partitions and isolation statuses.
 * GET /api/tenants/:id - Fetches specific tenant quota and guardrails.
 *
 * Both routes are tenant-bound. A tenant credential may read only its own profile; only a
 * platform operator (the platform key, or a loopback dev operator) may enumerate partitions.
 * The path parameter is checked here directly because `validateTenantRequest` inspects only
 * the header/body/query claim, never `req.params` -- so without this a tenant credential
 * could read any other tenant's quota and guardrails by guessing its id.
 */

import { Router, Request, Response } from 'express';
import { TenantService } from '../../services/tenantService';
import { emitSecurityError } from '../../utils/validation';
import type { AuthenticatedPrincipal } from '../middleware/tenantAuth';

const router = Router();

type PrincipalRequest = Request & { principal?: AuthenticatedPrincipal };

function summarise(t: ReturnType<typeof TenantService.listTenants>[number]) {
  return {
    id: t.id,
    name: t.name,
    niche: t.niche,
    tier: t.tier,
    status: t.status,
    quota: t.quota,
    customGuardrails: t.customGuardrails,
    createdAt: t.createdAt,
  };
}

router.get('/', (req: Request, res: Response) => {
  const principal = (req as PrincipalRequest).principal;
  const all = TenantService.listTenants();
  // A platform operator sees every partition. A tenant credential sees exactly one: its own.
  const visible = principal?.role === 'platform_operator'
    ? all
    : all.filter((t) => t.id === principal?.tenantId);
  const tenants = visible.map(summarise);
  res.json({ status: 'success', count: tenants.length, tenants });
});

router.get('/:id', (req: Request, res: Response) => {
  const principal = (req as PrincipalRequest).principal;
  if (principal && principal.role !== 'platform_operator' && principal.tenantId !== req.params.id) {
    return res.status(403).json(emitSecurityError(
      'TENANT_CREDENTIAL_MISMATCH',
      'The presented credential is not authorised for the requested tenant',
    ));
  }
  const tenant = TenantService.getTenant(req.params.id);
  if (!tenant) {
    return res.status(404).json(emitSecurityError('TENANT_NOT_FOUND', `Tenant ${req.params.id} does not exist`));
  }
  res.json({ status: 'success', tenant: summarise(tenant) });
});

export default router;
