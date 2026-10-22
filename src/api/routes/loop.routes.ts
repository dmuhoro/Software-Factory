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
import { rbacRequire } from '../middleware/rbac';
import { LoopControlService } from '../../services/loopControlService';
import { GoalIntakeService } from '../../services/goalIntakeService';
import { IssueIntakeService } from '../../services/issueIntakeService';
import { GrillSessionService } from '../../services/grillSessionService';
import { LearningDigestService } from '../../services/learningDigestService';
import { PersistentMemoryService } from '../../services/persistentMemoryService';

const router = Router();
const tenant = (req: Request): string => String(req.body?.tenantId || req.query.tenantId || req.headers['x-tenant-id']);

/** Submit a run. Resolves with the run id as soon as the record exists; the work continues. */
router.post('/runs', async (req: Request, res: Response) => {
  if (!validateTenantRequest(req, res)) return;
  if (!rbacRequire(req, res, 'loop:submit')) return;
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

/** Draft a task document from a goal, validated by the loop's own parser. */
router.post('/goals', async (req: Request, res: Response) => {
  if (!validateTenantRequest(req, res)) return;
  try {
    const draft = await GoalIntakeService.draft({
      tenantId: tenant(req),
      repo: req.body?.repo,
      goal: req.body?.goal,
      providerId: req.body?.providerId,
      model: req.body?.model,
      maxOutputTokens: typeof req.body?.maxOutputTokens === 'number' ? req.body.maxOutputTokens : undefined,
    });
    return res.status(201).json({ status: 'success', ...draft });
  } catch (error) {
    return respondWithError(res, error, 'LOOP_GOAL_DRAFT_FAILED');
  }
});

/** Draft a task document from a tracker issue (local file or GitHub), validated by the parser. */
router.post('/issues', async (req: Request, res: Response) => {
  if (!validateTenantRequest(req, res)) return;
  try {
    const draft = await IssueIntakeService.draft({
      tenantId: tenant(req),
      repo: req.body?.repo,
      source: req.body?.source,
      providerId: req.body?.providerId,
      model: req.body?.model,
      maxOutputTokens: typeof req.body?.maxOutputTokens === 'number' ? req.body.maxOutputTokens : undefined,
      timeoutMs: typeof req.body?.timeoutMs === 'number' ? req.body.timeoutMs : undefined,
    });
    return res.status(201).json({ status: 'success', ...draft });
  } catch (error) {
    return respondWithError(res, error, 'LOOP_ISSUE_DRAFT_FAILED');
  }
});

/**
 * Start an interactive intake ("grill session"): the factory asks one clarifying question and the
 * operator answers, turn by turn, until a task document can be drafted. Tenant-scoped and durable —
 * a restart mid-session resumes from the ledger.
 */
router.post('/grills', async (req: Request, res: Response) => {
  if (!validateTenantRequest(req, res)) return;
  try {
    const result = await GrillSessionService.start({
      tenantId: tenant(req),
      repo: req.body?.repo,
      goal: req.body?.goal,
      providerId: req.body?.providerId,
      model: req.body?.model,
    });
    return res.status(201).json({ status: 'success', ...result });
  } catch (error) {
    return respondWithError(res, error, 'LOOP_GRILL_FAILED');
  }
});

/** One session's full record, so a thin client can review the turn so far. */
router.get('/grills/:id', (req: Request, res: Response) => {
  if (!validateTenantRequest(req, res)) return;
  const session = GrillSessionService.get(tenant(req), req.params.id);
  if (!session) return res.status(404).json({ status: 'error', code: 'LOOP_GRILL_NOT_FOUND', message: 'No such grill session for this tenant.' });
  return res.json({ status: 'success', session });
});

/** Answer the outstanding question; the reply is the next question, or `done` at the cap. */
router.post('/grills/:id/answers', async (req: Request, res: Response) => {
  if (!validateTenantRequest(req, res)) return;
  try {
    const result = await GrillSessionService.answer({
      tenantId: tenant(req),
      sessionId: req.params.id,
      answer: req.body?.answer,
    });
    return res.json({ status: 'success', ...result });
  } catch (error) {
    return respondWithError(res, error, 'LOOP_GRILL_FAILED');
  }
});

/** Finish the session: draft the task document through the loop's own parse-or-refuse path. */
router.post('/grills/:id/finish', async (req: Request, res: Response) => {
  if (!validateTenantRequest(req, res)) return;
  try {
    const draft = await GrillSessionService.finish({ tenantId: tenant(req), sessionId: req.params.id });
    return res.status(201).json({ status: 'success', ...draft, sessionId: req.params.id });
  } catch (error) {
    return respondWithError(res, error, 'LOOP_GRILL_FAILED');
  }
});

/**
 * Eligibility pre-check for cancellation: may this run be stopped, and if not, why not.
 *
 * The shape is borrowed from WorkOS's `workspaceDeletionCheck` / `environmentDeletionEligibility`
 * family - ask before you attempt, so a caller learns the reason without having to trigger the
 * operation and parse a failure.
 */
router.get('/runs/:id/cancel', (req: Request, res: Response) => {
  if (!validateTenantRequest(req, res)) return;
  const tenantId = tenant(req);
  const run = LoopControlService.get(tenantId, req.params.id);
  if (!run) return res.status(404).json({ status: 'error', code: 'LOOP_RUN_NOT_FOUND', message: 'No such loop run.' });

  const cancellable = run.status === 'running';
  return res.json({
    status: 'success',
    eligible: cancellable,
    runId: run.runId,
    runStatus: run.status,
    ...(cancellable
      ? { reason: 'The run is executing; stopping it takes effect at the next unit boundary.' }
      : { reason: `A run that is ${run.status} has already settled and cannot be cancelled.` }),
    ...(cancellable
      ? { next: `POST /api/loop/runs/${run.runId}/cancel to receive a confirmation token.` }
      : {}),
  });
});

/**
 * Cancel a running run. Two phases, because stopping is irreversible:
 *
 *   1. POST with no token   -> 202 + a single-use `confirmationToken`. Nothing happens to the run.
 *   2. POST with the token  -> 202 + the loop stops at its next unit boundary.
 *
 * Work already committed stays committed. There is no configuration that skips phase one.
 */
router.post('/runs/:id/cancel', (req: Request, res: Response) => {
  if (!validateTenantRequest(req, res)) return;
  const tenantId = tenant(req);
  const runId = req.params.id;

  if (req.body?.confirmationToken === undefined) {
    try {
      const issued = LoopControlService.requestCancel(tenantId, runId);
      return res.status(202).json({
        status: 'pending_confirmation',
        runId,
        effect: 'Stops the run at its next unit boundary. Commits already made are kept.',
        ...issued,
      });
    } catch (error) {
      return respondWithError(res, error, 'LOOP_CANCEL_FAILED');
    }
  }

  try {
    const result = LoopControlService.confirmCancel(tenantId, runId, req.body?.confirmationToken);
    return res.status(202).json({
      status: 'success',
      runId,
      cancellationRequested: !result.alreadySettled,
      ...(result.alreadySettled ? { note: 'The run settled before the cancellation was applied.' } : {}),
    });
  } catch (error) {
    return respondWithError(res, error, 'LOOP_CANCEL_FAILED');
  }
});

/** Every run this tenant has submitted, newest first. */
router.get('/runs', (req: Request, res: Response) => {
  if (!validateTenantRequest(req, res)) return;
  return res.json({ status: 'success', runs: LoopControlService.summaries(tenant(req)) });
});

/**
 * The bounded learning digest for this tenant (ADR-012). Read-only: it is derived from the durable
 * run records and crosses no tenant boundary. Below the sufficiency threshold it returns an explicit
 * `insufficient-data` record rather than a conclusion.
 */
router.get('/learning-digest', (req: Request, res: Response) => {
  if (!validateTenantRequest(req, res)) return;
  const digest = LearningDigestService.build(tenant(req));
  return res.json({ status: 'success', digest });
});

/**
 * The tenant's cross-run memory (Sprint 35, WP-3). Read-only: what earlier runs of this factory
 * learned — which units failed, in which class, and what verified. Scoped to the authenticated
 * tenant: another tenant's memory is never returned, and a filter that is not understood is
 * refused rather than ignored.
 */
router.get('/memories', (req: Request, res: Response) => {
  if (!validateTenantRequest(req, res)) return;
  const tenantId = tenant(req);
  const kind = req.query.kind;
  const failureClass = req.query.failureClass;
  const unitId = req.query.unitId;
  const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
  if (kind !== undefined && !['outcome', 'pattern', 'warning', 'fix'].includes(String(kind))) {
    return res.status(400).json({ status: 'error', code: 'MEMORY_KIND_NOT_RECOGNIZED', message: 'kind must be one of outcome, pattern, warning, fix' });
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return res.status(400).json({ status: 'error', code: 'MEMORY_LIMIT_OUT_OF_RANGE', message: 'limit must be an integer between 1 and 200' });
  }
  const memories = PersistentMemoryService.query({
    tenantId,
    kind: kind as never,
    failureClass: failureClass === undefined ? undefined : String(failureClass),
    unitId: unitId === undefined ? undefined : String(unitId),
    limit,
  });
  return res.json({ status: 'success', memories });
});

/**
 * A read-only fleet overview for a thin client: the tenant's runs by status, and the learning digest
 * beside them. Composed entirely from the durable ledger; it starts no run and writes nothing.
 */
router.get('/overview', (req: Request, res: Response) => {
  if (!validateTenantRequest(req, res)) return;
  const tenantId = tenant(req);
  return res.json({
    status: 'success',
    overview: LoopControlService.overview(tenantId),
    digest: LearningDigestService.build(tenantId),
  });
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