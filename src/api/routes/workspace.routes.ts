import { Router, Request, Response } from 'express';
import { validateTenantRequest } from '../middleware/tenantAuth';
import { WorkspaceService } from '../../services/workspaceService';
import { FactoryJobService } from '../../services/factoryJobService';

const router = Router();
const tenant = (req: Request): string => String(req.body?.tenantId || req.query.tenantId || req.headers['x-tenant-id']);
const fail = (res: Response, error: any, code = 409) => res.status(code).json({ status: 'error', code: error?.message || 'WORKSPACE_OPERATION_FAILED', message: error?.message || 'Workspace operation failed' });
router.get('/inbox', (req, res) => { if (!validateTenantRequest(req, res)) return; return res.json({ status: 'success', inbox: WorkspaceService.inbox(tenant(req)) }); });
router.get('/projects', (req, res) => { if (!validateTenantRequest(req, res)) return; return res.json({ status: 'success', projects: WorkspaceService.list(tenant(req)) }); });
router.post('/projects', (req, res) => { if (!validateTenantRequest(req, res)) return; try { return res.status(201).json({ status: 'success', project: WorkspaceService.register({ ...req.body, tenantId: tenant(req) }) }); } catch (error: any) { return fail(res, error); } });
router.post('/projects/:id/lifecycle', (req, res) => { if (!validateTenantRequest(req, res)) return; try { return res.json({ status: 'success', project: WorkspaceService.updateLifecycle(tenant(req), req.params.id, req.body.lifecycle) }); } catch (error: any) { return fail(res, error); } });
router.post('/backup', (req, res) => { if (!validateTenantRequest(req, res)) return; try { return res.status(201).json({ status: 'success', backup: WorkspaceService.backup(tenant(req)) }); } catch (error: any) { return fail(res, error); } });
router.post('/restore/:backupId', (req, res) => { if (!validateTenantRequest(req, res)) return; try { return res.json({ status: 'success', restore: WorkspaceService.restore(tenant(req), req.params.backupId) }); } catch (error: any) { return fail(res, error); } });
router.post('/jobs/:id/tasks', (req, res) => { if (!validateTenantRequest(req, res)) return; try { return res.status(201).json({ status: 'success', job: FactoryJobService.addCompletionTask(tenant(req), req.params.id, req.body) }); } catch (error: any) { return fail(res, error); } });
router.post('/jobs/:id/tasks/:taskId', (req, res) => { if (!validateTenantRequest(req, res)) return; try { return res.json({ status: 'success', job: FactoryJobService.updateCompletionTask(tenant(req), req.params.id, req.params.taskId, req.body.status, req.body.evidenceKinds) }); } catch (error: any) { return fail(res, error); } });
router.get('/jobs/:id/continuation', (req, res) => { if (!validateTenantRequest(req, res)) return; try { return res.json({ status: 'success', report: FactoryJobService.continuationReport(tenant(req), req.params.id) }); } catch (error: any) { return fail(res, error); } });
export default router;
