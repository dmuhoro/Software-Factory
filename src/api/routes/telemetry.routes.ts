/**
 * Telemetry Ingestion & Transformation Routes
 * POST /api/telemetry/ingest - Ingest, validate, transform via Gemini, update Appwrite DB.
 * GET /api/telemetry/history - Retrieve historical transformations partitioned by tenant.
 */

import { Router, Request, Response } from 'express';
import { PipelineOrchestrator } from '../../services/pipelineOrchestrator';
import { AppwriteService } from '../../services/appwriteService';
import { validateTenantRequest } from '../middleware/tenantAuth';
import { OperationalError, classifyDependencyFailure } from '../../utils/operationalError';
import { TelemetryLogger } from '../../utils/telemetryLogger';

/** Reduces an upstream failure to a short, log-safe summary. Never includes credentials. */
function describeUpstream(raw: unknown): string {
  if (raw instanceof Error) return `${raw.name}${raw.message ? `: ${raw.message.slice(0, 300)}` : ''}`;
  if (typeof raw === 'string') return raw.slice(0, 300);
  try {
    return JSON.stringify(raw).slice(0, 300);
  } catch {
    return '[unserialisable upstream error]';
  }
}

const router = Router();

router.post('/ingest', async (req: Request, res: Response) => {
  try {
    const result = await PipelineOrchestrator.execute(req.body);
    if (result.status === 'error') {
      return res.status(400).json(result.error);
    }
    return res.status(200).json(result);
  } catch (error: unknown) {
    // Never forward an upstream error message. The SDK puts the entire Google API
    // response body in error.message, which leaks internal dependency detail to
    // callers. The client gets a stable code; the operator gets the raw failure in
    // the log. (Constitution Article I: no silent drops, and no internal disclosure.)
    if (error instanceof OperationalError) {
      if (error.retryAfterSeconds) res.set('Retry-After', String(error.retryAfterSeconds));
      TelemetryLogger.error('Telemetry ingest failed', {
        tenantId: (req.body as { tenantId?: string })?.tenantId,
        metadata: { code: error.code, reason: error.message, upstream: describeUpstream(error.upstream) },
      });
      return res.status(error.status).json(error.toResponse());
    }
    const safe = classifyDependencyFailure(error, {
      rawPayloadPersisted: (error as { rawPayloadPersisted?: boolean })?.rawPayloadPersisted ?? false,
      rawDocumentId: (error as { rawDocumentId?: string })?.rawDocumentId ?? null,
      deduplicated: (error as { deduplicated?: boolean })?.deduplicated ?? false,
    });
    if (safe.retryAfterSeconds) res.set('Retry-After', String(safe.retryAfterSeconds));
    TelemetryLogger.error('Telemetry ingest failed', {
      tenantId: (req.body as { tenantId?: string })?.tenantId,
      metadata: { code: safe.code, upstream: describeUpstream(error) },
    });
    return res.status(safe.status).json(safe.toResponse());
  }
});

router.get('/history', async (req: Request, res: Response) => {
  const tenantId = (req.query.tenantId as string) || (req.headers['x-tenant-id'] as string);
  if (!tenantId || !validateTenantRequest(req, res)) return;
  const records = await AppwriteService.getTransformationsByTenant(tenantId, readLimit(req));
  return res.json({ status: 'success', tenantId, count: records.length, records });
});

router.get('/audit', async (req: Request, res: Response) => {
  const tenantId = req.query.tenantId as string;
  if (!tenantId || !validateTenantRequest(req, res)) return;
  const logs = await AppwriteService.getAuditLogs(tenantId, readLimit(req));
  return res.json({ status: 'success', count: logs.length, logs });
});

/**
 * Parses `?limit=` from an untrusted query string.
 *
 * A page size is a number the caller chooses, so it is validated rather than trusted: a
 * non-numeric, negative, or absurd value is ignored in favour of the store's default, and the store
 * clamps anything that does get through. A parse failure here must not become a 500 on a query
 * parameter, and it must not become an unbounded read either.
 */
function readLimit(req: Request): number | undefined {
  const raw = (req.query.limit as string | undefined) ?? undefined;
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;
  return parsed;
}

export default router;
