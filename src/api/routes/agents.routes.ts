import { Router } from 'express';
import { validateTenantRequest } from '../middleware/tenantAuth';
import { FrontierModelService } from '../../services/frontierModelService';
import { ParallelWorktreeService } from '../../services/parallelWorktreeService';

const router = Router();
const tenant = (req: any): string => String(req.body?.tenantId || req.query.tenantId || req.headers['x-tenant-id']);
const fail = (res: any, error: any) => res.status(409).json({ status: 'error', code: error?.message || 'AGENT_OPERATION_FAILED', message: error?.message || 'Agent operation failed' });
router.get('/providers', (req, res) => { if (!validateTenantRequest(req, res)) return; return res.json({ status: 'success', providers: FrontierModelService.list(tenant(req)) }); });
router.post('/providers', (req, res) => { if (!validateTenantRequest(req, res)) return; try { return res.status(201).json({ status: 'success', provider: FrontierModelService.register({ ...req.body, tenantId: tenant(req) }) }); } catch (error) { return fail(res, error); } });
router.post('/providers/:id/discover', async (req, res) => { if (!validateTenantRequest(req, res)) return; try { return res.json({ status: 'success', provider: await FrontierModelService.discover(tenant(req), req.params.id) }); } catch (error) { return fail(res, error); } });
router.post('/runs', (req, res) => { if (!validateTenantRequest(req, res)) return; try { return res.status(201).json({ status: 'success', run: ParallelWorktreeService.plan({ ...req.body, tenantId: tenant(req) }) }); } catch (error) { return fail(res, error); } });
router.get('/runs', (req, res) => { if (!validateTenantRequest(req, res)) return; return res.json({ status: 'success', runs: ParallelWorktreeService.runs(tenant(req)) }); });
router.post('/runs/:id/worktrees', (req, res) => { if (!validateTenantRequest(req, res)) return; try { return res.status(201).json({ status: 'success', ...ParallelWorktreeService.prepareWorktrees(tenant(req), req.params.id) }); } catch (error) { return fail(res, error); } });
router.get('/runs/:id/worktrees', (req, res) => { if (!validateTenantRequest(req, res)) return; return res.json({ status: 'success', worktrees: ParallelWorktreeService.list(tenant(req), req.params.id) }); });
router.post('/worktrees/:id/status', (req, res) => { if (!validateTenantRequest(req, res)) return; try { return res.json({ status: 'success', worktree: ParallelWorktreeService.markTask(tenant(req), req.params.id, req.body.status) }); } catch (error) { return fail(res, error); } });
export default router;
