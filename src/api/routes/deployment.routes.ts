import { Router } from 'express';
import { validateTenantRequest } from '../middleware/tenantAuth';
import { HostedDeploymentService } from '../../services/hostedDeploymentService';

const router = Router();
const tenant = (req: any): string => String(req.body?.tenantId || req.query.tenantId || req.headers['x-tenant-id']);
const fail = (res: any, error: any) => res.status(409).json({ status: 'error', code: error?.message || 'DEPLOYMENT_OPERATION_FAILED', message: error?.message || 'Deployment operation failed' });
router.get('/targets', (req, res) => { if (!validateTenantRequest(req, res)) return; return res.json({ status: 'success', targets: HostedDeploymentService.listTargets(tenant(req)) }); });
router.post('/targets', (req, res) => { if (!validateTenantRequest(req, res)) return; try { return res.status(201).json({ status: 'success', target: HostedDeploymentService.registerTarget({ ...req.body, tenantId: tenant(req) }) }); } catch (error) { return fail(res, error); } });
router.get('/deployments', (req, res) => { if (!validateTenantRequest(req, res)) return; return res.json({ status: 'success', deployments: HostedDeploymentService.listDeployments(tenant(req)) }); });
router.post('/targets/:targetId/deploy', (req, res) => { if (!validateTenantRequest(req, res)) return; try { return res.status(201).json({ status: 'success', deployment: HostedDeploymentService.deploy(tenant(req), req.params.targetId, req.body.sourcePath, { approved: req.body.approved === true, sourceCommit: String(req.body.sourceCommit || 'unknown') }) }); } catch (error) { return fail(res, error); } });
router.post('/deployments/:id/observe', (req, res) => { if (!validateTenantRequest(req, res)) return; try { return res.json({ status: 'success', deployment: HostedDeploymentService.observe(tenant(req), req.params.id, { passed: req.body.passed === true, detail: String(req.body.detail || '') }) }); } catch (error) { return fail(res, error); } });
router.post('/deployments/:id/rollback', (req, res) => { if (!validateTenantRequest(req, res)) return; try { return res.json({ status: 'success', deployment: HostedDeploymentService.rollback(tenant(req), req.params.id) }); } catch (error) { return fail(res, error); } });
export default router;
