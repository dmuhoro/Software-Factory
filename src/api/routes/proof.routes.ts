import { Router } from 'express';
import type { Response as ExpressResponse } from 'express';
import { respondWithError } from '../../utils/respondWithError';
import { validateTenantRequest } from '../middleware/tenantAuth';
import { ReadinessEvidenceService, ReadinessLevel } from '../../services/readinessEvidenceService';

const router = Router();
const tenant = (req: any): string => String(req.body?.tenantId || req.query.tenantId || req.headers['x-tenant-id']);
const fail = (res: ExpressResponse, error: unknown) => respondWithError(res, error, 'PROOF_OPERATION_FAILED');
router.get('/criteria/:level', (req, res) => { if (!validateTenantRequest(req, res)) return; try { const level = req.params.level as ReadinessLevel; return res.json({ status: 'success', criteria: ReadinessEvidenceService.criteria(level) }); } catch (error) { return fail(res, error); } });
router.get('/:level', (req, res) => { if (!validateTenantRequest(req, res)) return; const level = req.params.level as ReadinessLevel; return res.json({ status: 'success', summary: ReadinessEvidenceService.summary(tenant(req), level), evidence: ReadinessEvidenceService.list(tenant(req), level), digest: ReadinessEvidenceService.evidenceDigest(tenant(req), level) }); });
router.post('/', (req, res) => { if (!validateTenantRequest(req, res)) return; try { return res.status(201).json({ status: 'success', evidence: ReadinessEvidenceService.record({ ...req.body, tenantId: tenant(req) }) }); } catch (error) { return fail(res, error); } });
export default router;
