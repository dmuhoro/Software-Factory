import { Router, Request, Response } from 'express';
import { FactoryJobService, FactoryJobStatus } from '../../services/factoryJobService';
import { validateTenantRequest } from '../middleware/tenantAuth';

const router = Router();
const tenant = (req: Request): string => String(req.body?.tenantId || req.query.tenantId || req.headers['x-tenant-id']);

router.get('/', (req, res) => res.json({ status: 'success', jobs: FactoryJobService.list(tenant(req)), count: FactoryJobService.list(tenant(req)).length }));

router.post('/', (req: Request, res: Response) => {
  if (!validateTenantRequest(req, res)) return;
  const { title, problem, desiredOutcome, acceptanceCriteria } = req.body ?? {};
  if (![title, problem, desiredOutcome].every((value) => typeof value === 'string' && value.trim())) return res.status(400).json({ status: 'error', code: 'INVALID_FACTORY_JOB', message: 'title, problem, and desiredOutcome are required' });
  const job = FactoryJobService.create({ tenantId: tenant(req), title, problem, desiredOutcome, acceptanceCriteria });
  return res.status(201).json({ status: 'success', job });
});

router.post('/:id/transition', (req: Request, res: Response) => {
  if (!validateTenantRequest(req, res)) return;
  try { return res.json({ status: 'success', job: FactoryJobService.transition(tenant(req), req.params.id, req.body.status as FactoryJobStatus) }); }
  catch (error: any) { return res.status(409).json({ status: 'error', code: 'INVALID_FACTORY_TRANSITION', message: error.message }); }
});

router.post('/:id/evidence', (req: Request, res: Response) => {
  if (!validateTenantRequest(req, res)) return;
  const { kind, description, uri } = req.body ?? {};
  if (!kind || !description) return res.status(400).json({ status: 'error', code: 'INVALID_EVIDENCE', message: 'kind and description are required' });
  try { return res.json({ status: 'success', job: FactoryJobService.addEvidence(tenant(req), req.params.id, { kind, description, uri }) }); }
  catch (error: any) { return res.status(404).json({ status: 'error', code: error.message, message: 'Factory job was not found for this tenant' }); }
});

export default router;
