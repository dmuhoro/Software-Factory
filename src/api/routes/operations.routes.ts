import { Router } from 'express';
import type { Response as ExpressResponse } from 'express';
import { respondWithError } from '../../utils/respondWithError';
import { validateTenantRequest } from '../middleware/tenantAuth';
import { AgentRunnerService } from '../../services/agentRunnerService';
import { SandboxPolicyService } from '../../services/sandboxPolicyService';
import { ObservationService } from '../../services/observationService';
import { MergeService } from '../../services/mergeService';
import { QualityGateService } from '../../services/qualityGateService';
import { AgentExecutionService } from '../../services/agentExecutionService';
import { DoctrineService } from '../../services/doctrineService';
import { ExecutionLoopService } from '../../services/executionLoopService';
import { prFlowService } from '../../services/prFlowService';

const router = Router();
const tenant = (req: any): string => String(req.body?.tenantId || req.query.tenantId || req.headers['x-tenant-id']);
const fail = (res: ExpressResponse, error: unknown) => respondWithError(res, error, 'OPERATION_FAILED');
router.get('/queue', (req, res) => { if (!validateTenantRequest(req, res)) return; return res.json({ status: 'success', jobs: AgentRunnerService.list(tenant(req), String(req.query.runId || '') || undefined) }); });
router.post('/runs/:runId/enqueue', (req, res) => { if (!validateTenantRequest(req, res)) return; try { return res.status(201).json({ status: 'success', jobs: AgentRunnerService.enqueue(tenant(req), req.params.runId, req.body.maxAttempts) }); } catch (error) { return fail(res, error); } });
router.post('/queue/claim', (req, res) => { if (!validateTenantRequest(req, res)) return; return res.json({ status: 'success', job: AgentRunnerService.claim(tenant(req), String(req.body.worker || 'worker'), req.body.leaseMs) ?? null }); });
router.post('/queue/:id/complete', (req, res) => { if (!validateTenantRequest(req, res)) return; try { return res.json({ status: 'success', job: AgentRunnerService.complete(tenant(req), req.params.id, req.body) }); } catch (error) { return fail(res, error); } });
router.post('/queue/:id/cancel', (req, res) => { if (!validateTenantRequest(req, res)) return; try { return res.json({ status: 'success', job: AgentRunnerService.cancel(tenant(req), req.params.id) }); } catch (error) { return fail(res, error); } });
router.post('/queue/execute-proposal', async (req, res) => { if (!validateTenantRequest(req, res)) return; try { return res.json({ status: 'success', execution: await AgentExecutionService.executeClaimed(tenant(req), String(req.body.worker || 'worker'), { providerId: String(req.body.providerId), model: String(req.body.model), repo: String(req.body.repo), branch: String(req.body.branch || ''), system: req.body.system, maxOutputTokens: req.body.maxOutputTokens }) }); } catch (error) { return fail(res, error); } });
router.post('/sandbox/policies', (req, res) => { if (!validateTenantRequest(req, res)) return; try { return res.status(201).json({ status: 'success', policy: SandboxPolicyService.createPolicy({ ...req.body, tenantId: tenant(req) }) }); } catch (error) { return fail(res, error); } });
router.post('/sandbox/policies/:id/runs', (req, res) => { if (!validateTenantRequest(req, res)) return; try { return res.status(201).json({ status: 'success', run: SandboxPolicyService.planRun(tenant(req), req.params.id) }); } catch (error) { return fail(res, error); } });
router.post('/deployments/:id/observe', (req, res) => { if (!validateTenantRequest(req, res)) return; try { return res.status(201).json({ status: 'success', observation: ObservationService.start(tenant(req), req.params.id, req.body) }); } catch (error) { return fail(res, error); } });
router.post('/observations/:id/check', (req, res) => { if (!validateTenantRequest(req, res)) return; try { return res.json({ status: 'success', observation: ObservationService.record(tenant(req), req.params.id, req.body) }); } catch (error) { return fail(res, error); } });
router.post('/observations/:id/rollback', (req, res) => { if (!validateTenantRequest(req, res)) return; try { return res.json({ status: 'success', deployment: ObservationService.rollback(tenant(req), req.params.id) }); } catch (error) { return fail(res, error); } });
router.post('/runs/:runId/merge-next', (req, res) => { if (!validateTenantRequest(req, res)) return; try { return res.json({ status: 'success', merge: MergeService.mergeNext(tenant(req), req.params.runId, req.body.targetBranch) }); } catch (error) { return fail(res, error); } });
router.get('/runs/:runId/merges', (req, res) => { if (!validateTenantRequest(req, res)) return; return res.json({ status: 'success', merges: MergeService.list(tenant(req), req.params.runId) }); });
router.post('/quality/adapters', (req, res) => { if (!validateTenantRequest(req, res)) return; try { return res.status(201).json({ status: 'success', adapter: QualityGateService.detect(tenant(req), req.body.projectId, req.body.repositoryPath) }); } catch (error) { return fail(res, error); } });
router.post('/quality/scans', (req, res) => { if (!validateTenantRequest(req, res)) return; try { return res.status(201).json({ status: 'success', scan: QualityGateService.scan(tenant(req), req.body.repositoryPath, req.body.projectId) }); } catch (error) { return fail(res, error); } });
router.get('/quality/scans', (req, res) => { if (!validateTenantRequest(req, res)) return; return res.json({ status: 'success', scans: QualityGateService.list(tenant(req)) }); });

router.post('/runs/:runId/pr', async (req, res) => {
  if (!validateTenantRequest(req, res)) return;
  try {
    const pullRequest = DoctrineService.load().loop.pullRequest;
    if (!pullRequest?.enabled) throw new Error('PR_MODE_UNSUPPORTED');
    const record = ExecutionLoopService.getRun(req.params.runId);
    if (!record) throw new Error('LOOP_RUN_NOT_FOUND');
    const pr = prFlowService.draft({ tenantId: tenant(req), run: record, repo: record.repo, mode: pullRequest.mode });
    if (pullRequest.mode === 'github') {
      const remote = prFlowService.githubTarget(record.repo);
      const opened = await prFlowService.openGithub({
        tenantId: tenant(req),
        run: record,
        repo: record.repo,
        mode: 'github',
        owner: remote?.owner ?? '',
        repoName: remote?.repoName ?? '',
        head: pr.branch,
        tokenSecretRef: pullRequest.github.tokenSecret,
        baseUrl: pullRequest.github.baseUrl || undefined,
      });
      return res.status(201).json({ status: 'success', pr: opened });
    }
    return res.status(201).json({ status: 'success', pr });
  } catch (error) {
    return fail(res, error);
  }
});

router.get('/runs/:runId/pr', (req, res) => {
  if (!validateTenantRequest(req, res)) return;
  try {
    const pr = prFlowService.getRecord(tenant(req), req.params.runId);
    if (!pr) throw new Error('PR_NOT_FOUND');
    return res.json({ status: 'success', pr });
  } catch (error) {
    return fail(res, error);
  }
});
export default router;
