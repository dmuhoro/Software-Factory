/**
 * The remote control plane for the unattended loop.
 *
 * Every route here is tenant-authenticated by the shared middleware before it runs, and every
 * path is scoped to the authenticated tenant: a run submitted by one tenant is not visible to
 * another, and a foreign run id is answered as a miss rather than as a forbidden resource.
 *
 * Submission starts real work on a real repository, so the repository is an allowlist enforced in
 * `LoopControlService` (inside the approved workspace, and a git repository), not a caller-chosen
 * path. The routes only translate HTTP to that service and stream its durable record back.
 */
import { Router, Request, Response } from 'express';
import { respondWithError } from '../../utils/respondWithError';
import { validateTenantRequest } from '../middleware/tenantAuth';
import { LoopControlService } from '../../services/loopControlService';

const router = Router();
const tenant = (req: Request): string => String(req.body?.tenantId || req.query.tenantId || req.headers['x-tenant-id']);

/** Submit a run. Resolves with the run id as soon as the record exists; the work continues. */
router.post('/runs', async (req: Request, res: Response) => {
  if (!validateTenantRequest(req, res)) return;
  try {
    const result = await LoopControlService.submit({
      tenantId: tenant(req),
      repo: req.body?.repo,
      taskDocument: req.body?.taskDocument,
      attemptCap: typeof req.body?.attemptCap === 'number' ? req.body.attemptCap : undefined,
    });
    return res.status(202).json({ status: 'success', ...result });
  } catch (error) {
    return respondWithError(res, error, 'LOOP_SUBMIT_FAILED');
  }
});

/** Every run this tenant has submitted, newest first. */
router.get('/runs', (req: Request, res: Response) => {
  if (!validateTenantRequest(req, res)) return;
  return res.json({ status: 'success', runs: LoopControlService.summaries(tenant(req)) });
});

/** One run's full record. */
router.get('/runs/:id', (req: Request, res: Response) => {
  if (!validateTenantRequest(req, res)) return;
  const run = LoopControlService.get(tenant(req), req.params.id);
  if (!run) return res.status(404).json({ status: 'error', code: 'LOOP_RUN_NOT_FOUND', message: 'No such loop run.' });
  return res.json({ status: 'success', run });
});

/**
 * Server-sent events for one run: the events already recorded, then each new event as the run
 * produces it, ending with `event: done` when the run leaves the running state.
 *
 * The stream is derived from the durable run record rather than from an in-memory channel, so it
 * is correct for a run this process started and equally correct after a reconnect. It is a view
 * of the ledger, not a second copy of it.
 */
router.get('/runs/:id/events', (req: Request, res: Response) => {
  if (!validateTenantRequest(req, res)) return;
  const tenantId = tenant(req);
  const runId = req.params.id;
  if (!LoopControlService.get(tenantId, req.params.id)) {
    return res.status(404).json({ status: 'error', code: 'LOOP_RUN_NOT_FOUND', message: 'No such loop run.' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let sent = 0;
  let closed = false;
  const timers: NodeJS.Timeout[] = [];
  const finish = (reason: string): void => {
    if (closed) return;
    closed = true;
    for (const timer of timers) clearInterval(timer);
    if (!res.writableEnded) {
      res.write(`event: end\ndata: ${JSON.stringify({ runId: req.params.id, reason })}\n\n`);
      res.end();
    }
  };
  const flush = (): void => {
    if (closed) return;
    const run = LoopControlService.get(tenant(req), req.params.id);
    if (!run) return finish('missing');
    for (; sent < run.events.length; sent += 1) {
      res.write(`data: ${JSON.stringify(run.events[sent])}\n\n`);
    }
    if (run.status !== 'running') {
      res.write(`event: done\ndata: ${JSON.stringify({ runId: run.runId, status: run.status })}\n\n`);
      return finish('done');
    }
  };
  const poll = setInterval(flush, 500);
  const heartbeat = setInterval(() => { if (!closed) res.write(': keep-alive\n\n'); }, 15_000);
  poll.unref();
  heartbeat.unref();
  timers.push(poll, heartbeat);
  req.on('close', () => finish('client'));
  flush();
});

export default router;