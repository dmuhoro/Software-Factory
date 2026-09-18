/**
 * Telemetry Ingestion & Transformation Routes
 * POST /api/telemetry/ingest - Ingest, validate, transform via Gemini, update Appwrite DB.
 * GET /api/telemetry/history - Retrieve historical transformations partitioned by tenant.
 */

import { Router, Request, Response } from 'express';
import { PipelineOrchestrator } from '../../services/pipelineOrchestrator';
import { AppwriteService } from '../../services/appwriteService';
import { validateTenantRequest } from '../middleware/tenantAuth';

const router = Router();

router.post('/ingest', async (req: Request, res: Response) => {
  try {
    const result = await PipelineOrchestrator.execute(req.body);
    if (result.status === 'error') {
      return res.status(400).json(result.error);
    }
    return res.status(200).json(result);
  } catch (error: any) {
    const diagnosticMessage = error?.message || 'Asynchronous pipeline execution failed';
    return res.status(500).json({
      status: 'error',
      code: 'PIPELINE_FAILURE',
      message: diagnosticMessage,
    });
  }
});

router.get('/history', (req: Request, res: Response) => {
  const tenantId = (req.query.tenantId as string) || (req.headers['x-tenant-id'] as string);
  if (!tenantId || !validateTenantRequest(req, res)) return;
  const records = AppwriteService.getTransformationsByTenant(tenantId);
  return res.json({ status: 'success', tenantId, count: records.length, records });
});

router.get('/audit', (req: Request, res: Response) => {
  const tenantId = req.query.tenantId as string;
  if (!tenantId || !validateTenantRequest(req, res)) return;
  const logs = AppwriteService.getAuditLogs(tenantId);
  return res.json({ status: 'success', count: logs.length, logs });
});

export default router;
