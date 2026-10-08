# Sprint 24 — The Remote Control Plane

**Goal.** Make the unattended loop drivable and observable from a browser or a phone instead of
only from an operator's terminal: describe an end goal, submit it, watch it run, retrieve the
verified result. This is the last mile between a proven local loop (sprint 23) and a service a
person can run their paid work on.

## Phase 0 — Ground truth (verified against the code before any edit)

Five premises were stated. All five hold; none contradicts the directive.

| Premise | Verdict | Evidence |
|---|---|---|
| The loop is CLI-only | **true** | `ExecutionLoopService` is called from exactly one place: `scripts/run-factory-loop.ts:119`. No route module imports it. |
| No live streaming to a browser | **true** | No `EventSource`, `text/event-stream`, or WebSocket anywhere in `src/` or `server.ts`. The loop already emits a JSONL event stream to disk (`executionLoopService.ts:647-653`) and exposes `onEvent`, but nothing serves it over HTTP. |
| The durable store is single-writer | **true** | `durableStore.ts` takes a process writer lock on every access (`ensureLoaded`/`acquireLock`, `:171-195`); a contended writer raises `LEDGER_ANOTHER_WRITER_ACTIVE` before the first write. `server.ts:59-74` maps an unusable/contended ledger to exit 75 (`EX_TEMPFAIL`) so a supervisor retries rather than runs two writers forever. |
| Execution is sandboxed with `bwrap`; the cheap tier is local Ollama | **true** | Doctrine hard-rejects any sandbox backend other than `bwrap` (`doctrineService.ts:196`); `groundTruthService` refuses to run a verification command that cannot be sandboxed. `doctrine/agents/models.json` defaults `cheap` → `local/qwen2.5-coder:14b`. |
| A real HTTP API, React UI and Dockerfile already exist | **true** | `server.ts` is an Express app that fails closed without config (`:14-19`), mounts 12 tenant-authed route groups (`src/api/index.ts`), and serves the built Vite bundle with an SPA fallback (`:138-145`). `Dockerfile` builds `node:22-slim`, `npm ci`, `npm start`. |

### The actual gap

The loop driver already persists its run record to the `factoryLoopRuns` collection and already
publishes a live event stream. It is reachable by `getRun`/`listRuns` (`executionLoopService.ts:209-215`).
What is missing is the thin layer that (a) starts a run from an authenticated request, (b) exposes
the run record and its event stream over HTTP, and (c) turns a natural-language goal into the
strict task document the loop already knows how to parse. Phase 1's and Phase 2's work is that
layer, not a rewrite.

### Execution-boundary note carried forward

The loop sandboxes *verification commands* with `bwrap` and dials models from the doctrine
registry. Neither is guaranteed inside a plain Railway container. This sprint does **not** weaken
that boundary: it adds the remote control plane while keeping the boundary fail-closed, and the
container-boundary work is tracked separately (see Open Items). A remote run against a repository
that lives on the serving host's workspace is supported; a remote run that assumes `bwrap`+Ollama
inside an arbitrary container is not, and is named as such rather than silently attempted.

## Layers (one concern per commit)

1. **L1 — Phase 0 record** (this document).
2. **L2 — Storage/deploy posture proven, not asserted** (Phase 1.4): two live processes over one
   data directory; the second must refuse. Plus the Railway build/run contract.
3. **L3 — The control-plane service** (Phase 2.1/2.2): authenticated run submission and a bounded
   worker that drives the real `ExecutionLoopService`.
4. **L4 — The HTTP surface** (Phase 2.1/2.3): `POST /api/loop/runs`, `GET /api/loop/runs`,
   `GET /api/loop/runs/:id`, and an SSE `GET /api/loop/runs/:id/events`.
5. **L5 — Goal intake** (Phase 3): end goal → validated task document via the architect/planner
   roles, proven to be accepted by the loop's own parser.
6. **L6 — UI** (Phase 2.4): the React surface consumes the new endpoints.
7. **L7 — Client pattern** (Phase 5): a token-in-memory browser extension pointing at the service.
8. **L8 — Documentation and release.**

## Open items (blocked on operator-owned resources, stated honestly)

- **Phase 1.1 sustained throughput**: needs a real hosted model key and hours of wall clock. The
  control plane makes this a single remote submission once the key exists.
- **Phase 1.2 container/microVM execution boundary**: a doctrine change to the highest-risk code
  in the repository and a new ADR. Out of scope here by the STOP condition.
- **Phase 1.3 hosted provider**: the registry already accepts any OpenAI-compatible provider;
  registering a live one needs the operator's key.
- **Phase 4 live Railway deployment**: needs the operator's Railway account and secrets. The
  build/run contract and runbook are delivered; the deploy itself is the operator's step.
## Evidence (as landed)

Every claim below names the command that demonstrated it and what to look at.

### L2 — single-writer lock across processes (`d141f4b`)

- `node_modules/.bin/tsx scripts/durable-writer-probe.ts` in a holder process → `WRITE_OK`.
  A second process against the same `FACTORY_DATA_DIR` → `REFUSED:LEDGER_ANOTHER_WRITER_ACTIVE`,
  exit 1.
- `test/durable-store-writer-lock.test.ts` pins both directions (holder writes; child refused).
- `railway.json` + `docs/DEPLOY_RAILWAY.md`: the deploy contract (one replica, a persistent volume
  at `/var/lib/software-factory`, a hosted provider). The live deploy is the operator's step.

### L3 — authenticated control plane (`3b124a5`)

- `test/loop-control-plane.test.ts` (5 cases) drives the real `ExecutionLoopService` against a
  stub provider and real git repositories:
  - a repository outside the approved workspace is refused (`LOOP_REPO_OUTSIDE_WORKSPACE`);
  - a directory that is not a git repository is refused (`LOOP_REPO_NOT_GIT`);
  - a submitted run reaches `status: 'completed'` with one commit, and a foreign tenant gets a miss
    from `get`/`summaries`;
  - a second submission while a run is live is refused (`LOOP_RUN_ALREADY_ACTIVE`).
- The same file boots the real `apiRouter` over an ephemeral HTTP port and asserts, with `fetch`:
  `POST /api/loop/runs` is `401` with no credential, `403` for a credential claiming another
  tenant, `202` with the owner's; `GET /api/loop/runs/:id` is `200` for the owner and `404` for
  another tenant; and `GET /api/loop/runs/:id/events` streams `text/event-stream` to `event: done`
  with `"status":"completed"`.
- Negative proof: with `router.use('/loop', loopRoutes)` commented out, the HTTP case fails; with it
  restored, it passes.

### L5 — goal intake (`2198b44`)

- `test/loop-control-plane.test.ts` (4 more cases): an empty goal is refused (`LOOP_GOAL_REQUIRED`),
  a missing provider/model is refused (`LOOP_GOAL_MODEL_REQUIRED`), a draft the loop parser rejects
  is refused (`LOOP_GOAL_DRAFT_INVALID`), and a valid draft is written inside the workspace, is
  re-parsed by `parseTaskDocument` as `M1`, then submitted unchanged and run to a real commit.
- Over HTTP: `POST /api/loop/goals` is `401` without a credential and `201` with one.

### L6 — operator panel (React)

- `src/components/LoopControlPanel.tsx`, mounted as a new **Unattended Loop** tab in `src/App.tsx`.
  It lists runs, submits a run, drafts a goal, and tails the SSE stream for a selected run.
- **Credential model: memory only.** The API key the operator pastes lives in component state. It
  is not written to localStorage, sessionStorage, a cookie, or the URL, and it is dropped on
  unmount. The panel says so on screen. This is the deliberate trade-off: a surface that can start
  work must not persist a credential in the browser.
- The stream is read with `fetch` + `ReadableStream`, not `EventSource`, because `EventSource`
  cannot send the `x-api-key` header this API requires.
- Proven by `npm run build` (vite + esbuild, clean) and `npm run lint` (`tsc --noEmit`, clean, and
  the tsconfig has no `include`, so it type-checks `.tsx`). There is no browser test harness in
  this repository, so the panel is proven to compile and type-check, not to render; the API
  behaviour it calls is proven by the HTTP cases above.

### Regression

- `npm run lint` (`tsc --noEmit`) clean.
- `npm test` → 230/230 passing (`# fail 0`).

### Still not done here

- **L7 (token-in-memory browser extension client)** is complete (`clients/forge-style-extension/`, Manifest V3, RAM-only token).
- **L8** release bump/tag not cut.
