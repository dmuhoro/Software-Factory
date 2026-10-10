/**
 * `GET /api/usage` — the caller's own metered consumption.
 *
 * The service declares an AI-token budget per tier. This endpoint reports the measured side of
 * that: how many tokens the caller's tenant actually consumed, per UTC day, and the running
 * total for today. Enforcement of the budget is not here — it lands with real model usage
 * (WP-5) — but a budget with no readable meter is unenforceable anyway.
 *
 * It answers for the caller and nobody else. There is no `?tenantId=` here: an endpoint that
 * reported another tenant's consumption would be an information leak wearing a helpfully named
 * route.
 */

import { Router, Request, Response } from 'express';
import type { AuthenticatedPrincipal } from '../middleware/tenantAuth';
import { UsageMeteringService } from '../../services/usageMeteringService';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  const principal = (req as Request & { principal?: AuthenticatedPrincipal }).principal;
  if (!principal || !principal.tenantId) {
    res.status(401).json({ status: 'error', code: 'UNAUTHORIZED', message: 'A valid credential is required.' });
    return;
  }
  res.status(200).json({
    status: 'success',
    tenantId: principal.tenantId,
    today: UsageMeteringService.daily(principal.tenantId),
    days: UsageMeteringService.summaries(principal.tenantId),
  });
});

export default router;
