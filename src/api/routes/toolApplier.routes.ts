/**
 * Tool Applier Routes.
 *
 * POST   /api/tool-apply/apply     — apply structured edits in a worktree, verify, request approval
 * POST   /api/tool-apply/approve   — merge an approved apply into the target branch
 * POST   /api/tool-apply/reject    — reject a pending apply and clean up
 * GET    /api/tool-apply/records   — list apply records for audit
 *
 * Every route is tenant-authenticated and RBAC-protected:
 *   - apply/approve/reject require `loop:submit` (mutating repository state)
 *   - records requires `loop:read` (audit read)
 * Merge (approve) additionally requires the MODIFY_BRANCH harness action — a human
 * must decide via POST /api/factory-jobs/approvals/:approvalId/decision.
 */

import { Router, Request, Response } from 'express';
import { respondWithError } from '../../utils/respondWithError';
import { validateTenantRequest } from '../middleware/tenantAuth';
import { rbacRequire } from '../middleware/rbac';
import { ToolApplierService, ToolApplyRequest, StructuredEdit } from '../../services/toolApplierService';
import { classifyApiError, toErrorBody } from '../../utils/apiError';

const router = Router();
const tenant = (req: Request): string => String(req.body?.tenantId || req.query.tenantId || req.headers['x-tenant-id']);
const ok = (res: Response, body: Record<string, unknown>, code = 200) => res.status(code).json({ status: 'success', ...body });
const fail = (res: Response, error: unknown) => respondWithError(res, error, 'TOOL_APPLY_FAILED');

function parseEdits(body: unknown): StructuredEdit[] {
  const raw = (body as { edits?: unknown })?.edits;
  if (!Array.isArray(raw)) throw new Error('TOOL_APPLY_INVALID: edits must be an array');
  return raw.map((item, index) => {
    const e = item as Record<string, unknown>;
    if (typeof e.path !== 'string' || !e.path.trim()) throw new Error(`TOOL_APPLY_INVALID: edits[${index}].path required`);
    if (!['create', 'modify', 'delete'].includes(String(e.operation))) {
      throw new Error(`TOOL_APPLY_INVALID: edits[${index}].operation must be create, modify, or delete`);
    }
    return {
      path: e.path.trim(),
      operation: e.operation as 'create' | 'modify' | 'delete',
      content: typeof e.content === 'string' ? e.content : undefined,
    };
  });
}

router.post('/apply', (req: Request, res: Response) => {
  if (!validateTenantRequest(req, res)) return;
  if (!rbacRequire(req, res, 'loop:submit')) return;
  const { branch, verificationCommand, requestedBy, rationale } = req.body ?? {};
  if (!branch || typeof branch !== 'string') return fail(res, { message: 'TOOL_APPLY_INVALID: branch required' });
  if (!requestedBy || typeof requestedBy !== 'string') return fail(res, { message: 'TOOL_APPLY_INVALID: requestedBy required' });
  if (!rationale || typeof rationale !== 'string') return fail(res, { message: 'TOOL_APPLY_INVALID: rationale required' });

  let edits: StructuredEdit[];
  try { edits = parseEdits(req.body); } catch (error) { return fail(res, error); }

  const request: ToolApplyRequest = {
    tenantId: tenant(req),
    repo: req.body.repo as string,
    branch,
    edits,
    verificationCommand: typeof verificationCommand === 'string' ? verificationCommand : undefined,
    requestedBy,
    rationale,
  };
  if (!request.repo) return fail(res, { message: 'TOOL_APPLY_INVALID: repo required' });

  try {
    const result = ToolApplierService.apply(request);
    return ok(res, result as unknown as Record<string, unknown>, result.applied ? 201 : 400);
  } catch (error: any) {
    const classified = classifyApiError(error);
    return res.status(classified.status).json(toErrorBody(classified));
  }
});

router.post('/approve', (req: Request, res: Response) => {
  if (!validateTenantRequest(req, res)) return;
  if (!rbacRequire(req, res, 'loop:submit')) return;
  const { approvalId, decidedBy } = req.body ?? {};
  if (!approvalId || typeof approvalId !== 'string') return fail(res, { message: 'TOOL_APPLY_INVALID: approvalId required' });

  try {
    const result = ToolApplierService.approve(tenant(req), approvalId, decidedBy || 'founder');
    return ok(res, result);
  } catch (error: any) {
    const classified = classifyApiError(error);
    return res.status(classified.status).json(toErrorBody(classified));
  }
});

router.post('/reject', (req: Request, res: Response) => {
  if (!validateTenantRequest(req, res)) return;
  if (!rbacRequire(req, res, 'loop:submit')) return;
  const { approvalId, note, decidedBy } = req.body ?? {};
  if (!approvalId || typeof approvalId !== 'string') return fail(res, { message: 'TOOL_APPLY_INVALID: approvalId required' });
  if (!note || typeof note !== 'string') return fail(res, { message: 'TOOL_APPLY_INVALID: note required' });

  try {
    const result = ToolApplierService.reject(tenant(req), approvalId, note, decidedBy || 'founder');
    return ok(res, result);
  } catch (error: any) {
    const classified = classifyApiError(error);
    return res.status(classified.status).json(toErrorBody(classified));
  }
});

router.get('/records', (req: Request, res: Response) => {
  if (!validateTenantRequest(req, res)) return;
  if (!rbacRequire(req, res, 'loop:read')) return;
  const records = ToolApplierService.list(tenant(req));
  return ok(res, { records, count: records.length });
});

export default router;
