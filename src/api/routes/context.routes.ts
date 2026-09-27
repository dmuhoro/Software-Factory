import { Router, Request, Response } from 'express';
import { respondWithError } from '../../utils/respondWithError';
import { ContextIndexService, seedBuiltInContexts } from '../../services/contextIndexService';
import { validateTenantRequest } from '../middleware/tenantAuth';

const router = Router();

// Examples are seeded lazily inside the read handler. A module-scope call here
// made importing this router touch the durable ledger, which turned a corrupt
// ledger into a process that could not start at all. Import must stay side-effect free.

router.get('/repositories', (_req: Request, res: Response) => {
  seedBuiltInContexts();
  return res.json({ status: 'success', contexts: ContextIndexService.list(), importedCount: ContextIndexService.listImported().length, baselineQualityScore: ContextIndexService.qualityBaseline() });
});
router.get('/search', (req: Request, res: Response) => { seedBuiltInContexts(); const query = String(req.query.q || '').trim(); return res.json({ status: 'success', query, contexts: query ? ContextIndexService.search(query) : [] }); });
router.get('/quality', (req: Request, res: Response) => { if (!validateTenantRequest(req, res)) return; return res.json({ status: 'success', summary: ContextIndexService.qualitySummary(String(req.query.tenantId || req.headers['x-tenant-id'])), history: ContextIndexService.qualityHistory(String(req.query.tenantId || req.headers['x-tenant-id'])) }); });
router.post('/quality', (req: Request, res: Response) => { if (!validateTenantRequest(req, res)) return; const { productName, score, dimensions, evidenceKinds, jobId } = req.body ?? {}; if (typeof productName !== 'string' || typeof score !== 'number' || !dimensions || !Array.isArray(evidenceKinds)) return res.status(400).json({ status: 'error', code: 'INVALID_QUALITY_SNAPSHOT', message: 'productName, numeric score, dimensions, and evidenceKinds are required' }); const snapshot = ContextIndexService.recordQuality({ tenantId: String(req.body.tenantId || req.headers['x-tenant-id']), jobId, productName, score, baselineScore: ContextIndexService.qualityBaseline(), dimensions, evidenceKinds }); return res.status(201).json({ status: 'success', snapshot }); });
router.post('/refresh', (req: Request, res: Response) => { if (!validateTenantRequest(req, res)) return; const { repository, sourcePath } = req.body ?? {}; if (typeof repository !== 'string' || typeof sourcePath !== 'string') return res.status(400).json({ status: 'error', code: 'INVALID_CONTEXT_REFRESH', message: 'repository and sourcePath are required' }); try { return res.json({ status: 'success', context: ContextIndexService.refreshRepository(repository, sourcePath) }); } catch (error: unknown) { return respondWithError(res, error, 'CONTEXT_REFRESH_FAILED'); } });
router.post('/promote', (req: Request, res: Response) => { if (!validateTenantRequest(req, res)) return; const { repository, pattern, adapter } = req.body ?? {}; if (![repository, pattern, adapter].every((value) => typeof value === 'string' && value.trim())) return res.status(400).json({ status: 'error', code: 'INVALID_PATTERN_PROMOTION', message: 'repository, pattern, and adapter are required' }); try { return res.status(201).json({ status: 'success', context: ContextIndexService.promotePattern(repository, pattern, adapter) }); } catch (error: unknown) { return respondWithError(res, error, 'PATTERN_PROMOTION_FAILED'); } });

export default router;
