/**
 * Operator Controls Routes
 *
 * POST/DELETE /api/operator/tenants/:id/caps - write or clear a tenant's tighten-only operational
 *   cap override (concurrency, daily AI tokens); GET dumps the effective caps.
 *
 * These are platform-operator controls. A tenant operator may read its own allowance through the
 * tenant profile routes, but only an operator who can act for every tenant may change the run
 * controls of one. Every change is persisted in the durable ledger (`operatorCaps`) and recorded
 * in the audit trail with the acting principal, so a cap that throttles a tenant is attributable
 * and survives a restart.
 *
 * The tighten-only property is enforced here twice: `OperatorCapService.set` refuses a value that
 * raises a cap above the base allowance (`OPERATOR_CAP_NOT_TIGHTENING`), and every consumer reads
 * the effective cap as `Math.min(base, override)` — so even a value that slipped past validation
 * could not enlarge an allowance. The base is re-derived from the live tenant profile at write
 * time, so an override can never silently lock in an allowance the tenant is no longer entitled to.
 */

import { Router, Request, Response } from 'express';
import { OperatorCapService, type CapCeiling } from '../../services/operatorCapService';
import { TenantService } from '../../services/tenantService';
import { TenantQueueService } from '../../services/tenantQueueService';
import { recordAuditEvent } from '../../services/auditEventService';
import { resolveEnforcementMode } from '../../utils/enforcement';
import { classifyApiError, toErrorBody } from '../../utils/apiError';
import { DurableStore } from '../../services/durableStore';
import type { AuthenticatedPrincipal } from '../middleware/tenantAuth';

const router = Router();

type PrincipalRequest = Request & { principal?: AuthenticatedPrincipal };

/** Re-derives the base a tighten-only override is measured against, from the live tenant profile. */
function ceilingFor(tenantId: string): CapCeiling | null {
  const profile = TenantService.getTenant(tenantId);
  if (!profile) return null;
  return {
    concurrency: TenantQueueService.tierLimit(profile.tier),
    dailyAiTokens: typeof profile.quota?.maxDailyAiTokens === 'number' ? profile.quota.maxDailyAiTokens : null,
  };
}

function capsView(tenantId: string) {
  const ceiling = ceilingFor(tenantId);
  if (ceiling === null) return null;
  const effective = OperatorCapService.effective(tenantId, ceiling);
  return {
    tenantId,
    tier: TenantService.getTenant(tenantId)?.tier,
    base: ceiling,
    concurrency: effective.concurrency,
    dailyAiTokens: effective.dailyAiTokens,
    override: effective.override,
  };
}

async function writeAudit(input: { tenantId: string; actor: string; action: 'set' | 'clear'; details: Record<string, unknown> }): Promise<void> {
  await recordAuditEvent(
    {
      tenantId: input.tenantId,
      kind: 'tenant.cap.change',
      actor: input.actor,
      action: input.action,
      target: input.tenantId,
      outcome: 'allowed',
      timestamp: new Date().toISOString(),
      details: input.details,
    },
    resolveEnforcementMode(process.env.FACTORY_ENFORCEMENT_MODE),
    async (event) => { DurableStore.appendAudit(event as unknown as Record<string, unknown>); },
  );
}

/** The audit trail names who acted: the scoped credential id when present, otherwise the operator identity. */
function actorOf(principal: AuthenticatedPrincipal): string {
  return principal.credentialId ?? principal.tenantId;
}

function refuseNonOperator(res: Response, req: Request): boolean {
  const principal = (req as PrincipalRequest).principal;
  if (principal?.role === 'platform_operator') return false;
  res.status(403).json(toErrorBody(classifyApiError(new Error('OPERATOR_ROLE_REQUIRED:'))));
  return true;
}

router.get('/tenants/:id/caps', (req: Request, res: Response) => {
  if (refuseNonOperator(res, req)) return;
  const view = capsView(req.params.id);
  if (view === null) {
    return res.status(404).json(toErrorBody(classifyApiError(new Error('TENANT_NOT_FOUND:'))));
  }
  res.json({ status: 'success', ...view });
});

router.post('/tenants/:id/caps', async (req: Request, res: Response) => {
  if (refuseNonOperator(res, req)) return;
  const principal = (req as PrincipalRequest).principal as AuthenticatedPrincipal;
  const tenantId = req.params.id;
  try {
    const body: unknown = req.body;
    if (typeof body !== 'object' || body === null) throw new Error('OPERATOR_CAP_INVALID:no-payload');
    const given = body as Record<string, unknown>;
    for (const key of ['concurrency', 'dailyAiTokens'] as const) {
      if (given[key] !== undefined && (typeof given[key] !== 'number' || Number.isNaN(given[key] as number))) {
        throw new Error(`OPERATOR_CAP_INVALID:${key}=${String(given[key])}`);
      }
    }
    const cap = OperatorCapService.set({
      tenantId,
      actor: actorOf(principal),
      ceiling: (() => {
        const ceiling = ceilingFor(tenantId);
        if (ceiling === null) throw new Error('TENANT_NOT_FOUND:');
        return ceiling;
      })(),
      ...(given.concurrency !== undefined ? { concurrency: given.concurrency as number } : {}),
      ...(given.dailyAiTokens !== undefined ? { dailyAiTokens: given.dailyAiTokens as number } : {}),
    });
    await writeAudit({
      tenantId,
      actor: cap.updatedBy,
      action: 'set',
      details: {
        concurrency: cap.concurrency ?? null,
        dailyAiTokens: cap.dailyAiTokens ?? null,
        revision: cap.revision,
      },
    });
    res.json({ status: 'success', ...capsView(tenantId) });
  } catch (error) {
    const classified = classifyApiError(error);
    res.status(classified.status).json(toErrorBody(classified));
  }
});

router.delete('/tenants/:id/caps', async (req: Request, res: Response) => {
  if (refuseNonOperator(res, req)) return;
  const principal = (req as PrincipalRequest).principal as AuthenticatedPrincipal;
  const tenantId = req.params.id;
  try {
    if (!TenantService.getTenant(tenantId)) throw new Error('TENANT_NOT_FOUND:');
    const removed = OperatorCapService.clear(tenantId, actorOf(principal));
    await writeAudit({
      tenantId,
      actor: actorOf(principal),
      action: 'clear',
      details: { revision: removed?.revision ?? 0, cleared: removed !== undefined },
    });
    res.json({ status: 'success', ...capsView(tenantId) });
  } catch (error) {
    const classified = classifyApiError(error);
    res.status(classified.status).json(toErrorBody(classified));
  }
});

export default router;