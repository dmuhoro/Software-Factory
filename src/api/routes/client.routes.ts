import { Router } from 'express';
import { validateTenantRequest } from '../middleware/tenantAuth';
import { ClientDeliveryService } from '../../services/clientDeliveryService';

const router = Router();
const tenant = (req: any): string => String(req.body?.tenantId || req.query.tenantId || req.headers['x-tenant-id']);
const fail = (res: any, error: any) => res.status(409).json({ status: 'error', code: error?.message || 'CLIENT_OPERATION_FAILED', message: error?.message || 'Client operation failed' });
router.get('/workspaces', (req, res) => { if (!validateTenantRequest(req, res)) return; return res.json({ status: 'success', workspaces: ClientDeliveryService.listWorkspaces(tenant(req)) }); });
router.post('/workspaces', (req, res) => { if (!validateTenantRequest(req, res)) return; try { return res.status(201).json({ status: 'success', workspace: ClientDeliveryService.registerWorkspace({ ...req.body, tenantId: tenant(req) }) }); } catch (error) { return fail(res, error); } });
router.post('/projects/:projectId/handover', (req, res) => { if (!validateTenantRequest(req, res)) return; try { return res.status(201).json({ status: 'success', handover: ClientDeliveryService.createHandover(tenant(req), req.params.projectId, req.body) }); } catch (error) { return fail(res, error); } });
router.get('/acceptances', (req, res) => { if (!validateTenantRequest(req, res)) return; return res.json({ status: 'success', acceptances: ClientDeliveryService.listAcceptances(tenant(req)) }); });
router.post('/projects/:projectId/handovers/:handoverId/accept', (req, res) => { if (!validateTenantRequest(req, res)) return; try { return res.json({ status: 'success', acceptance: ClientDeliveryService.accept(tenant(req), req.params.projectId, req.params.handoverId, req.body) }); } catch (error) { return fail(res, error); } });
export default router;
