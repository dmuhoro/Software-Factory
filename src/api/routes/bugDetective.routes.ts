/**
 * Bug detective API (Layer 5 Diagnostic).
 *
 * Advisory, bounded, fail-closed. These endpoints produce diagnoses — root-cause hypothesis,
 * file:line pointers, remediation — but never write to a target tree and never accept a fix.
 * Any fix the diagnosis suggests still runs VERIFY → REVIEW → COMMIT through L2 gates.
 *
 * RBAC: `loop:read` (same as the preview plane — diagnostics are read-only evidence).
 */
import { Router, Request, Response } from 'express';
import { respondWithError } from '../../utils/respondWithError';
import { validateTenantRequest } from '../middleware/tenantAuth';
import { rbacRequire } from '../middleware/rbac';
import { bugDetectiveService, type DiagnosisInput } from '../../services/bugDetectiveService';

const router = Router();
const tenant = (req: Request): string => String(req.headers['x-tenant-id']);

/** Diagnose an observed failure for a unit in a run. */
router.post('/diagnose', async (req: Request, res: Response) => {
  if (!validateTenantRequest(req, res)) return;
  if (!rbacRequire(req, res, 'loop:read')) return;
  try {
    const { failureClass, reason, message, stage, location } = req.body ?? {};
    if (!failureClass) {
      return res.status(400).json({ status: 'error', code: 'BUG_DIAGNOSIS_CLASS_REQUIRED', message: 'failureClass is required' });
    }
    const input: DiagnosisInput = {
      failureClass: failureClass as import('../../services/loopFailureClass').LoopFailureClass,
      reason: typeof reason === 'string' ? reason : undefined,
      message: typeof message === 'string' ? message : undefined,
      stage: typeof stage === 'string' ? stage : undefined,
      location: typeof location === 'string' ? location : undefined,
    };
    const diagnosis = bugDetectiveService.diagnose(input);
    return res.status(200).json({ status: 'success', diagnosis });
  } catch (error) {
    return respondWithError(res, error, 'BUG_DIAGNOSIS_FAILED');
  }
});

/** Get a previously recorded diagnosis for a unit (read-only evidence). */
router.get('/diagnoses/:unitId', async (req: Request, res: Response) => {
  if (!validateTenantRequest(req, res)) return;
  if (!rbacRequire(req, res, 'loop:read')) return;
  try {
    return res.status(404).json({
      status: 'error',
      code: 'BUG_DIAGNOSIS_NOT_FOUND',
      message: 'No diagnosis exists for this unit or run. Diagnose produces evidence on demand; it does not store.',
    });
  } catch (error) {
    return respondWithError(res, error, 'BUG_DIAGNOSIS_GET_FAILED');
  }
});

export default router;
