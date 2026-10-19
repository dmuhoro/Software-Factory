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
import { hashTenantCredential } from '../../utils/tenantCredentials';
import type { AuthenticatedPrincipal } from '../middleware/tenantAuth';
import { IndustryNiche, TenantSubscriptionTier, TenantStatus } from '../../models/tenant';
import { SUBSCRIPTION_QUOTAS } from '../../configurations/factory.config';
import { randomBytes } from 'node:crypto';

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

/** Generates a tenant-scoped identifier (lowercase kebab, bounded length). */
function makeTenantId(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'tenant';
  const suffix = randomBytes(4).toString('hex');
  return `tenant_${base}_${suffix}`;
}

/** Generates a root API key plaintext (shown once at provisioning, never stored). */
function makeRootKey(): string {
  return `sfk_${randomBytes(24).toString('base64url')}`;
}

/** Minimum root key length enforced by runtime config. */
const MIN_ROOT_KEY_LEN = 24;

router.post('/', async (req: Request, res: Response) => {
  const { name, niche, tier } = req.body ?? {};
  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    return res.status(400).json(emitSecurityError('INVALID_TENANT', 'name must be a non-empty string of at least 2 characters'));
  }
  const nicheValues = Object.values(IndustryNiche) as string[];
  if (!niche || !nicheValues.includes(niche)) {
    return res.status(400).json(emitSecurityError('INVALID_NICHE', `niche must be one of: ${nicheValues.join(', ')}`));
  }
  const tierValues = Object.values(TenantSubscriptionTier) as string[];
  const requestedTier = tier && tierValues.includes(tier) ? tier : TenantSubscriptionTier.STARTER;

  const id = makeTenantId(name);
  // Refuse duplicate names before committing: scan existing tenants rather than
  // guessing an id, since makeTenantId adds a random suffix that can never collide.
  const existing = TenantService.listTenants().find((t) => t.name === name.trim());
  if (existing) {
    return res.status(409).json(emitSecurityError('TENANT_EXISTS', `A tenant named '${name}' already exists`));
  }

  const plaintextKey = makeRootKey();
  if (plaintextKey.length < MIN_ROOT_KEY_LEN) {
    return res.status(500).json(emitSecurityError('KEY_GENERATION_FAILED', 'generated key is too short'));
  }
  const apiKeyHash = await hashTenantCredential(plaintextKey);

  const now = new Date().toISOString();
  const profile = {
    id,
    name: name.trim(),
    niche,
    tier: requestedTier,
    status: TenantStatus.ACTIVE,
    apiKeyHash,
    quota: SUBSCRIPTION_QUOTAS[requestedTier as keyof typeof SUBSCRIPTION_QUOTAS],
    customGuardrails: [],
    encryptionKeyId: `enc-${id}`,
    createdAt: now,
    updatedAt: now,
  };
  TenantService.registerTenant(profile);

  // The plaintext key is returned exactly once. It is not persisted, logged, or recoverable.
  res.status(201).json({
    status: 'success',
    tenant: summarise(profile),
    credentials: [
      { kind: 'root', id: `root-${id}`, apiKey: plaintextKey, expiresAt: null },
    ],
    notice: 'Save the root API key now. It is shown once and cannot be recovered.',
  });
});

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
