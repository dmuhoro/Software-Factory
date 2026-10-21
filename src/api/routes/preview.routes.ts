/**
 * Preview plane API (Layer 2 Agency).
 *
 * Tenant-authenticated routes that create, list, inspect, and stop preview
 * sessions. Each session renders a target repo at a given commit inside an
 * ephemeral git worktree with its dev server running on an ephemeral port.
 * Additive only: no loop, doctrine, or gate is touched.
 */
import { Router, Request, Response } from 'express';
import { respondWithError } from '../../utils/respondWithError';
import { validateTenantRequest } from '../middleware/tenantAuth';
import { rbacRequire } from '../middleware/rbac';
import { previewPlaneService } from '../../services/previewPlaneService';

const router = Router();
const tenant = (req: Request): string => String(req.headers['x-tenant-id']);

/** Create a preview session for a repo at a commit. */
router.post('/sessions', async (req: Request, res: Response) => {
  if (!validateTenantRequest(req, res)) return;
  if (!rbacRequire(req, res, 'loop:read')) return;
  try {
    const { repo, commit } = req.body ?? {};
    if (typeof repo !== 'string' || !repo) {
      return res.status(400).json({ status: 'error', code: 'PREVIEW_MISSING_REPO', message: 'repo is required' });
    }
    if (typeof commit !== 'string' || !commit) {
      return res.status(400).json({ status: 'error', code: 'PREVIEW_MISSING_COMMIT', message: 'commit is required' });
    }
    const session = await previewPlaneService.createSession({ tenantId: tenant(req), repo, commit });
    return res.status(201).json({ status: 'success', session });
  } catch (error) {
    return respondWithError(res, error, 'PREVIEW_SESSION_FAILED');
  }
});

/** List preview sessions for the authenticated tenant. */
router.get('/sessions', async (req: Request, res: Response) => {
  if (!validateTenantRequest(req, res)) return;
  if (!rbacRequire(req, res, 'loop:read')) return;
  try {
    const sessions = previewPlaneService.list(tenant(req));
    return res.status(200).json({ status: 'success', sessions });
  } catch (error) {
    return respondWithError(res, error, 'PREVIEW_LIST_FAILED');
  }
});

/** Get a single preview session by id. */
router.get('/sessions/:id', async (req: Request, res: Response) => {
  if (!validateTenantRequest(req, res)) return;
  if (!rbacRequire(req, res, 'loop:read')) return;
  try {
    const session = previewPlaneService.get(req.params.id);
    if (!session) {
      return res.status(404).json({ status: 'error', code: 'PREVIEW_SESSION_NOT_FOUND', message: 'session not found' });
    }
    if (session.tenantId !== tenant(req)) {
      return res.status(403).json({ status: 'error', code: 'PREVIEW_TENANT_MISMATCH', message: 'session belongs to another tenant' });
    }
    return res.status(200).json({ status: 'success', session });
  } catch (error) {
    return respondWithError(res, error, 'PREVIEW_GET_FAILED');
  }
});

/** Stop a preview session and remove its worktree. */
router.delete('/sessions/:id', async (req: Request, res: Response) => {
  if (!validateTenantRequest(req, res)) return;
  if (!rbacRequire(req, res, 'loop:read')) return;
  try {
    const session = previewPlaneService.get(req.params.id);
    if (!session) {
      return res.status(404).json({ status: 'error', code: 'PREVIEW_SESSION_NOT_FOUND', message: 'session not found' });
    }
    if (session.tenantId !== tenant(req)) {
      return res.status(403).json({ status: 'error', code: 'PREVIEW_TENANT_MISMATCH', message: 'session belongs to another tenant' });
    }
    const stopped = previewPlaneService.stop(req.params.id);
    return res.status(200).json({ status: 'success', stopped });
  } catch (error) {
    return respondWithError(res, error, 'PREVIEW_STOP_FAILED');
  }
});

/** Take a best-effort screenshot of a ready preview session. */
router.get('/sessions/:id/screenshot', async (req: Request, res: Response) => {
  if (!validateTenantRequest(req, res)) return;
  if (!rbacRequire(req, res, 'loop:read')) return;
  try {
    const session = previewPlaneService.get(req.params.id);
    if (!session) {
      return res.status(404).json({ status: 'error', code: 'PREVIEW_SESSION_NOT_FOUND', message: 'session not found' });
    }
    if (session.tenantId !== tenant(req)) {
      return res.status(403).json({ status: 'error', code: 'PREVIEW_TENANT_MISMATCH', message: 'session belongs to another tenant' });
    }
    const shot = await previewPlaneService.screenshot(req.params.id);
    if (!shot) {
      return res.status(200).json({ status: 'success', screenshot: null, reason: 'no browser available or session not ready' });
    }
    return res.status(200).json({ status: 'success', screenshot: shot });
  } catch (error) {
    return respondWithError(res, error, 'PREVIEW_SCREENSHOT_FAILED');
  }
});

export default router;
