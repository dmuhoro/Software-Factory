import { Router, Request, Response } from 'express';
import { FactoryJobService, FactoryJobStatus } from '../../services/factoryJobService';
import { validateTenantRequest } from '../middleware/tenantAuth';

const router = Router();
const tenant = (req: Request): string => String(req.body?.tenantId || req.query.tenantId || req.headers['x-tenant-id']);
const ok = (res: Response, job: unknown, code = 200) => res.status(code).json({ status: 'success', job });
const fail = (res: Response, error: any, code = 409) => res.status(code).json({ status: 'error', code: error?.message || 'FACTORY_OPERATION_FAILED', message: error?.message || 'Factory operation failed' });

router.get('/', (req, res) => { const jobs = FactoryJobService.list(tenant(req)); return res.json({ status: 'success', jobs, count: jobs.length }); });
router.get('/:id', (req, res) => { const job = FactoryJobService.get(tenant(req), req.params.id); return job ? ok(res, job) : fail(res, { message: 'FACTORY_JOB_NOT_FOUND' }, 404); });

router.post('/', (req: Request, res: Response) => {
  if (!validateTenantRequest(req, res)) return;
  const { title, problem, desiredOutcome, acceptanceCriteria } = req.body ?? {};
  if (![title, problem, desiredOutcome].every((value) => typeof value === 'string' && value.trim())) return fail(res, { message: 'INVALID_FACTORY_JOB: title, problem, and desiredOutcome are required' }, 400);
  return ok(res, FactoryJobService.create({ tenantId: tenant(req), title, problem, desiredOutcome, acceptanceCriteria }), 201);
});

router.post('/:id/brief', (req: Request, res: Response) => {
  if (!validateTenantRequest(req, res)) return;
  const { audience, valueHypothesis, wedge, nonGoals } = req.body ?? {};
  if (![audience, valueHypothesis, wedge].every((value) => typeof value === 'string' && value.trim())) return fail(res, { message: 'INVALID_PRODUCT_BRIEF: audience, valueHypothesis, and wedge are required' }, 400);
  try { return ok(res, FactoryJobService.createProductBrief(tenant(req), req.params.id, { audience, valueHypothesis, wedge, nonGoals })); } catch (error: any) { return fail(res, error); }
});

router.post('/:id/plan', (req: Request, res: Response) => { if (!validateTenantRequest(req, res)) return; try { return ok(res, FactoryJobService.createImplementationPlan(tenant(req), req.params.id)); } catch (error: any) { return fail(res, error); } });
router.post('/:id/repository', (req: Request, res: Response) => { if (!validateTenantRequest(req, res)) return; try { return ok(res, FactoryJobService.prepareRepository(tenant(req), req.params.id, req.body)); } catch (error: any) { return fail(res, error); } });
router.post('/:id/modify', (req: Request, res: Response) => { if (!validateTenantRequest(req, res)) return; try { return ok(res, FactoryJobService.modifyRepository(tenant(req), req.params.id, req.body)); } catch (error: any) { return fail(res, error); } });
router.post('/:id/verify', (req: Request, res: Response) => { if (!validateTenantRequest(req, res)) return; try { return ok(res, FactoryJobService.verifyRepository(tenant(req), req.params.id)); } catch (error: any) { return fail(res, error); } });
router.post('/:id/preview', (req: Request, res: Response) => { if (!validateTenantRequest(req, res)) return; try { return ok(res, FactoryJobService.createPreview(tenant(req), req.params.id)); } catch (error: any) { return fail(res, error); } });
router.post('/:id/transition', (req: Request, res: Response) => { if (!validateTenantRequest(req, res)) return; try { return ok(res, FactoryJobService.transition(tenant(req), req.params.id, req.body.status as FactoryJobStatus)); } catch (error: any) { return fail(res, error); } });
router.post('/:id/evidence', (req: Request, res: Response) => { if (!validateTenantRequest(req, res)) return; const { kind, description, uri } = req.body ?? {}; if (!kind || !description) return fail(res, { message: 'INVALID_EVIDENCE: kind and description are required' }, 400); try { return ok(res, FactoryJobService.addEvidence(tenant(req), req.params.id, { kind, description, uri })); } catch (error: any) { return fail(res, error, 404); } });

export default router;
