import { Router, Request, Response } from 'express';
import { ContextIndexService, seedBuiltInContexts } from '../../services/contextIndexService';
import { validateTenantRequest } from '../middleware/tenantAuth';

const router = Router();
seedBuiltInContexts();

router.get('/repositories', (_req: Request, res: Response) => res.json({ status: 'success', contexts: ContextIndexService.list(), baselineQualityScore: ContextIndexService.qualityBaseline() }));
router.get('/search', (req: Request, res: Response) => { const query = String(req.query.q || '').trim(); return res.json({ status: 'success', query, contexts: query ? ContextIndexService.search(query) : [] }); });
router.get('/quality', (req: Request, res: Response) => { if (!validateTenantRequest(req, res)) return; return res.json({ status: 'success', summary: ContextIndexService.qualitySummary(String(req.query.tenantId || req.headers['x-tenant-id'])), history: ContextIndexService.qualityHistory(String(req.query.tenantId || req.headers['x-tenant-id'])) }); });
router.post('/quality', (req: Request, res: Response) => { if (!validateTenantRequest(req, res)) return; const { productName, score, dimensions, evidenceKinds, jobId } = req.body ?? {}; if (typeof productName !== 'string' || typeof score !== 'number' || !dimensions || !Array.isArray(evidenceKinds)) return res.status(400).json({ status: 'error', code: 'INVALID_QUALITY_SNAPSHOT', message: 'productName, numeric score, dimensions, and evidenceKinds are required' }); const snapshot = ContextIndexService.recordQuality({ tenantId: String(req.body.tenantId || req.headers['x-tenant-id']), jobId, productName, score, baselineScore: ContextIndexService.qualityBaseline(), dimensions, evidenceKinds }); return res.status(201).json({ status: 'success', snapshot }); });

export default router;
