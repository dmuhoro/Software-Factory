/**
 * Tenants Management & Partition Verification Routes
 * GET /api/tenants - Lists registered tenant partitions and isolation statuses.
 * GET /api/tenants/:id - Fetches specific tenant quota and guardrails.
 */

import { Router, Request, Response } from 'express';
import { TenantService } from '../../services/tenantService';
import { emitSecurityError } from '../../utils/validation';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  const tenants = TenantService.listTenants().map((t) => ({
    id: t.id,
    name: t.name,
    niche: t.niche,
    tier: t.tier,
    status: t.status,
    quota: t.quota,
    customGuardrails: t.customGuardrails,
    createdAt: t.createdAt,
  }));
  res.json({ status: 'success', count: tenants.length, tenants });
});

router.get('/:id', (req: Request, res: Response) => {
  const tenant = TenantService.getTenant(req.params.id);
  if (!tenant) {
    return res.status(404).json(emitSecurityError('TENANT_NOT_FOUND', `Tenant ${req.params.id} does not exist`));
  }
  res.json({
    status: 'success',
    tenant: {
      id: tenant.id,
      name: tenant.name,
      niche: tenant.niche,
      tier: tenant.tier,
      status: tenant.status,
      quota: tenant.quota,
      customGuardrails: tenant.customGuardrails,
      createdAt: tenant.createdAt,
    },
  });
});

export default router;
