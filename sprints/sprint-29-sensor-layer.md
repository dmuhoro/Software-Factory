# Sprint 29 — The Sensor Layer

**Status:** in flight (WP-0 governance, WP-1 leak guard · 4.13.26, WP-2 egress door · 4.13.27, WP-3 failure classification · 4.13.28, WP-4 foundation readiness · 4.13.29, WP-5 unrelated-writes guard · 4.13.30) · **Opened:** 2026-10-14

**Thesis:** Sprint 28 joined the orchestration layer — planning, concurrency, and a reviewable
change set — onto the unattended loop. What the loop cannot yet do is *feel*: it does not check
the foundation it stands on, it does not name why an attempt failed in a machine-readable way, it
carries a security guard that is never called, and it keeps a record of every run that nothing
ever reads back. This sprint adds **sensors and closes verified holes.** It does not add autonomy.

Two decisions must be ratified before any code (WP-0): the model-egress path has two doors and
must have one (ADR-011), and learning from recorded outcomes must be bounded, deterministic, and
off by default (ADR-012). WP-0 stops for founder sign-off; WP-1 does not begin until both are
approved.

Follows `docs/CONSTITUTION.md`, the ADRs in `docs/adr/`, `CONTRIBUTING.md`, and the cross-repo SOP.

---

## The finding that scoped this sprint

A Google-AI "civil-engineering doctrine" chat was audited against the live code. Roughly four
fifths of it restated mechanisms this repository already has (single-writer ledger and exit-75
refusal, `--unshare-net` sandbox, two-axis review, `diff:comment-claim` narration rejection). The
audit's value was the fifth that named **real gaps**, and the two security drifts that surfaced
while checking its claims:

- **A second egress door.** `src/utils/egressGuard.ts:1-19` declares itself the single authority
  for outbound model egress, and it has exactly three callers
  (`frontierModelService.ts:2`, `prFlowService.ts:16`, `issueTrackerService.ts:17`).
  `src/services/geminiService.ts` is a second door: it imports `@google/genai` directly (`:6`),
  reads `process.env.GEMINI_API_KEY` (`:23`), constructs the SDK client (`:28-35`) and calls
  `client.models.generateContent` (`:104`) — never through the guard — and it sits on the live
  telemetry path (`pipelineOrchestrator.ts:131-139`).
- **A dead guard.** `DoctrineIsolationService.assertNoTargetInstructionContent`
  (`doctrineIsolationService.ts:213-225`) exists to refuse a run whose payload contains a
  quarantined target instruction file, and its error code `TARGET_DOCTRINE_LEAKED_INTO_RUN`
  (`apiError.ts:276`) is registered — but the only callers are tests
  (`test/loop-doctrine.test.ts:189,191`). The loop never calls it. A protection the doctrine
  implies is live is not.

Both are the exact failure Part Two of the Constitution exists to prevent: code that claims a
protection it does not provide, and a control that is not asserted (ADR-008).

## Work packages

| WP | Objective | Proof | Status |
|---|---|---|---|
| **WP-0** | Governance: this sprint file + ADR-011 (one egress door) + ADR-012 (bounded learning) | `npm run verify:docs` green; ADRs presented for sign-off | **done** |
| WP-1 | Wire the dead leak guard + persist isolation evidence | planted target-instruction content refuses the run; manifest survives `--resume` | **done — 4.13.26** |
| WP-2 | One egress door (implements ADR-011) | architectural assertion test fails pre-fix, passes post-fix | **done — 4.13.27** |
| WP-3 | Durable failure classification for the loop | classes persist, survive resume, appear in the report; exhaustive classifier tests | **done — 4.13.28** |
| WP-4 | Foundation readiness check (disk space + write/fsync) | full/read-only `FACTORY_DATA_DIR` reports fail; server refuses (exit 75) | **done — 4.13.29** |
| WP-5 | Unrelated-writes guard, **shadow mode only** | shadow log names an unrelated edit; allowlisted lockfile not flagged; flag flips enforcement | **done — 4.13.30** |
| WP-6 | Learning digest, read-only, injection OFF | determinism, size-bound, tenant-isolation, insufficient-data, flag-off no-op | pending |

### Scope limits (hard — do not implement in this sprint)

- No autonomous schema rewrites, no auto-hot-swap of generated patches, no "spawn a clean node"
  replacing rollback, no production-data cloning, no per-unit dynamic network mutation, no second
  constitution file.
- No prompt injection of learning this sprint (WP-6 wires it behind a default-OFF flag only).
- The hosted-model layer (Sprint 28 WP-5) stays untouched: operator-blocked.

### Evidence plan (per WP)

Each WP follows the repository's discipline: a **failing-first test** (shown to fail without its
fix, the negative result recorded in the WP write-up), a **replay** against the real case, a green
full suite, and a release. One version per WP: a feature commit, then a separate release commit
(`package.json` + `package-lock.json` + `CHANGELOG.md` + this sprint file), annotated tag
`v4.13.x`, push `main` + tag, and verify remote `main == HEAD == tag`.

Specific proofs:

- **WP-1** — plant a quarantined instruction file's distinctive line into an implementer payload;
  the loop must refuse with `TARGET_DOCTRINE_LEAKED_INTO_RUN` and record it. Persist the isolation
  manifest (paths + `sha256`) on the run record (not only `quarantineCount`,
  `loopTypes.ts:111`), and re-verify it on `--resume` (`executionLoopService.ts:966-1004`).
- **WP-2** — an architectural assertion that fails if any module outside the sanctioned boundary
  imports a vendor model SDK or a raw network client, or reads a provider secret outside
  `resolveSecretRef`. Run it against the pre-fix tree to record the failure.
- **WP-3** — a pure classifier over the refusal code and stage, with no LLM. Every existing refusal
  code either maps to a class or the test fails. `failureClass` joins `AttemptRecord`,
  `UnitRecord`, and `LoopRunRecord` (`loopTypes.ts:30-125`) and appears in `renderReport`
  (`executionLoopService.ts:1078-1144`).
- **WP-4** — extend `classifyReadiness` (`healthService.ts:88-93`) with a bounded disk-space +
  write/fsync probe; a failure is `fail`, and the existing startup refusal path
  (`server.ts`, exit 75) already treats `unhealthy` as fatal.
- **WP-5** — the gate reads `Proof.claimedFiles/observedFiles` (`loopTypes.ts:145-155`) plus a
  doctrine-defined allowlist. It ships recording "would refuse" with the file named; the
  enforcement flag is a doctrine value defaulting **off**. Do not enable enforcement this sprint.
- **WP-6** — `LearningDigestService` reads `factoryLoopRuns`
  (`executionLoopService.ts:257-259`) and builds a bounded, deterministic digest per ADR-012.
  Injection into `GoalIntakeService`/`IssueIntakeService`
  (`goalIntakeService.ts:104-116`) is behind a doctrine flag default OFF; the OFF arm proves zero
  prompt change.

## Named blockers (not worked around)

- **Sprint 28 WP-5 — hosted frontier answer (owner: operator):** needs an allowlisted secret ref
  present in the environment (`FACTORY_ALLOWED_SECRET_REFS`), its host permitted
  (`FACTORY_MODEL_ALLOWED_HOSTS`), and spend. Code half complete; parked, not stubbed.
- **Sprint 28 WP-4 — real GitHub pull request (owner: operator):** a live open needs an
  operator-appointed allowlisted token and an egress permit; only refusal-before-socket and the
  loopback path are proven.
- **Sandbox in the shipped container (owner: operator):** the runtime image installs no
  `bubblewrap`, so sandboxed execution fails closed there (ADR-010). Enabling it is an operator
  decision (`--privileged` or a host permitting unprivileged user namespaces).

## Parked for Sprint 30 (recorded, not started)

Before parking, the earlier carry-overs were checked against their sprint records:

- **Real throughput day** — *prior work closed, a fresh measurement is parked.* Sprint 22 L7 ran
  the loop for real (Daftari `looprun_baabd8f138d822bca628cb29` → commit `0dfec9c`; self-hosted
  `looprun_cd5b2f682f3ca0f7c99ab731` → `3aa864f`, `c5d6a47`; second Daftari unit
  `looprun_d2cd0d0263cbe10f95d38a9c` → `3c277d7146e6`). Sprint 23 recorded a **four-unit batch**,
  not a multi-hour day, and named that gap. Parked: a real throughput day on a real backlog,
  reporting the measured number.
- **Die-and-resume drill** — *prior work closed, the named three-point re-run is parked.* Sprint
  22 D2 killed at **mid-attempt, mid-verify, mid-commit** (commit `dde3494`, 4/4). Parked: a drill
  at **mid-gate, mid-commit, mid-retry**, pass/fail with evidence.
- **Public evidence site** — *closed.* Sprint 23 L6 deployed `site/` to
  `https://site-puce-eight-83.vercel.app`. Open sub-item: confirm whether push-to-deploy is
  desired or should be disabled.
- **Idempotency audit** of every mutating route and the resume path.
- **Graduate WP-5** from shadow to enforce, based on the observed false-positive rate.
- **Enable learning injection** once real data exists (ADR-012 §6).
- **Sprint 28 WP-5** hosted frontier model — blocked on operator.

## WP-0 — Governance (this change, no production code)

- This sprint file.
- **ADR-011: Model egress has one door** — presents the three options, states the ADR-002 tension,
  recommends fail-closed routing through the guard, requires an architectural assertion, and is
  recorded **Proposed** pending sign-off.
- **ADR-012: Learning from run outcomes is bounded, deterministic, and off by default** — defines
  the digest, its size bound, its determinism, its data-sufficiency threshold, and that injection
  stays OFF until a later sprint.

**Evidence:** `npm run verify:docs` (the docs gate) green. Full suite unaffected (no production
code touched in WP-0).

**Stopping point:** WP-1 does not begin until the founder approves ADR-011 and ADR-012. The
Constitution requires the code that satisfies a decision to land with it; WP-2 lands ADR-011's
code and flips its status in the same change, and WP-6 lands ADR-012's code likewise.

## WP-1 — Wire the dead leak guard (4.13.26)

**Executive summary.** `DoctrineIsolationService.assertNoTargetInstructionContent` existed and its
code `TARGET_DOCTRINE_LEAKED_INTO_RUN` was registered, but the only callers were tests. The live
loop never asserted its payloads, so a target's own instruction file — pulled in by the
reference-file reader when a criterion's `check` names it — could reach an implementer and be
obeyed. The guard now runs at the real boundary, before any socket, and the run keeps durable
evidence of what it isolated.

**What was built.**

- `ExecutionLoopService.runUnit` builds the implementer payload and both review-axis payloads,
  asserts each against the isolation manifest, and only then dials the model. A leak throws
  `TARGET_DOCTRINE_LEAKED_INTO_RUN`; the attempt loop treats it as fatal, so the run **halts**,
  commits nothing, and leaves the tree clean.
- `ImplementerService.implement` and `ReviewService.review` accept pre-built `prompts`, so the
  asserted bytes are the sent bytes (no second prompt construction to drift).
- `LoopRunRecord.isolation: IsolationEvidence` (doctrine root + digest, target repo, `stagedAt`,
  and each quarantined file's `relativePath`, `sha256`, `bytes`) replaces the bare
  `quarantineCount`; `renderReport` prints an **Isolation** section.
- `resume()` re-verifies the persisted manifest against the current tree and refuses
  `LOOP_RUN_INCOMPATIBLE` on drift, before any worktree cleanup.

**Verification evidence (ground truth).**

- Failing-first: with `assertNoTargetInstructionContent` removed from the implementer path, the new
  test **fails** (`# fail 1`) — the leaky payload reaches the stub model. Restored, it passes.
- `test/loop-execution.test.ts` — the leak test asserts `stub.prompts` is empty (the model was never
  dialled), zero commits, `rev-list --count HEAD == 1`, and an empty `git status --porcelain`; the
  resume test asserts the persisted `AGENTS.md` entry carries `sha256:[0-9a-f]{64}` and a byte
  count, then tampers the file and asserts `LOOP_RUN_INCOMPATIBLE … instruction files changed`.
- Full suite green: **386 tests, 386 pass, 0 fail** (up from 384). `tsc --noEmit` clean.

**Remaining gaps.** WP-2 does not yet exist, so `geminiService.ts` is still a second egress door.
The hosted-model and live-GitHub paths remain operator-blocked.

**Next.** WP-2 — one egress door, with an architectural assertion that fails on the pre-fix tree.

## WP-2 — One egress door (4.13.27)

**Executive summary.** The guard declared itself the single authority for model egress, but
`geminiService.ts` was a second door on the live telemetry path: it imported the `@google/genai`
client, read `GEMINI_API_KEY`, and called Google without ever consulting the allowlists. ADR-011 is
now Accepted and implemented: every vendor SDK client is built in one module that resolves the key
and validates the endpoint through the guard first, and an architectural assertion makes the
invariant live.

**What was built.**

- `src/utils/modelEgress.ts` (new): the sole importer of a vendor SDK client constructor. It calls
  `resolveOptionalSecretRef('GEMINI_API_KEY')` and `authorizeProviderEndpoint(GeminiConfig.baseUrl,
  'gemini-native')` before constructing the client; no key mounted → `null` (deterministic path).
- `egressGuard.ts`: `resolveOptionalSecretRef` (absence → `undefined`; mounted-but-unpermitted →
  throw) and `authorizeProviderEndpoint` (the guard's name-and-address checks applied to a socket the
  guard does not own).
- `geminiService.ts`: no longer imports `@google/genai` or reads the key; awaits `createGeminiClient()`.
- `gemini.config.ts`: `baseUrl` names the endpoint the operator must allowlist.
- `test/egress-confinement.test.ts` (new): the assertion ADR-011 requires.
- Docs: `.env.example` and `README.md` state the two allowlist entries live Gemini needs; ADR-011
  flipped Proposed → Accepted with its implementation referenced.

**Verification evidence (ground truth).**

- Failing-first: against the pre-fix tree the assertion reported `src/services/geminiService.ts
  imports GoogleGenAI from @google/genai` (rule A) and `src/services/geminiService.ts reads
  GEMINI_API_KEY` (rule B), plus the two positive assertions — 4 of 5 failed. Post-fix: 10/10 pass.
- Rule C (raw network client confinement) passed pre- and post-fix, as it should: the only
  `node:http` import is the process's own listener in `server.ts`.
- Behavioral fail-closed: a mounted key without an allowlist refuses `MODEL_PROVIDER_SECRET_REF_NOT_ALLOWED`;
  an allowlisted key whose host is not permitted refuses `MODEL_PROVIDER_HOST_NOT_ALLOWED`; both
  before the SDK client is constructed. The fallback path is unchanged.
- Full suite green: **396 tests, 396 pass** (up from 386). `tsc --noEmit` clean; docs gate 6/6.

**Remaining gaps.** The Appwrite serverless function and the Rust runtime (`software_factory/`) are
separate deployables with their own trust boundaries; ADR-011 names them out of scope. Tenant webhook
egress (`webhookService.ts`) is a different egress class and is unchanged.

**Next.** WP-3 — durable failure classification, so an attempt's reason persists as a machine-readable class.

## WP-3 — Durable failure classification (4.13.28)

**Executive summary.** An attempt recorded why it failed as a free-text reason — the first token of
the thrown refusal — plus a truncated detail. A human can read that; a count cannot. Nothing could
answer how often a repository fails verification versus review versus a policy gate. ADR-012 turns
recorded outcomes into a bounded digest, and a class must exist before it can be counted. The
classifier is now the loop's second sensor, and it is pure: no model, no clock, no randomness.

**What was built.**

- `src/services/loopFailureClass.ts` (new): `classifyLoopFailure` returns one of `security |
  verification | review | model | environment | policy | unknown` from the refusal code, stage, gate
  ids, and message. `GATE_FAILURE_CLASSES` maps every gate id; `unclassifiedGateIds()` makes a
  missing mapping a visible, testable fact.
- `failureClass` joins `AttemptRecord` (assigned at the moment of failure in the driver),
  `UnitRecord` (the last failed attempt while stuck; cleared once the unit is done), and
  `LoopRunRecord` (the dominant class, or the class of a run-level hard stop when no attempt
  failed). `summariseFailureClasses` orders counts by count then severity; `runFailureClass`
  resolves the run-level class.
- `renderReport` gains a **Failure classes** section and names the class beside each failed
  attempt. `README.md` documents the class set in the loop's safety model.

**Verification evidence (ground truth).**

- Failing-first: with the `attempt.failureClass = …` wiring removed, the three integration
  assertions fail (**3 tests, 3 fail**); restored they pass. The pure classifier tests are not
  vacuous: removing a gate's mapping fails `every gate id the registry knows has a failure class`.
- `test/loop-failure-class.test.ts` — registry completeness, every real refusal code, gate-id
  parsing, determinism (50 repeats), and summary ordering/dominance.
- `test/loop-execution.test.ts` — a failed verification classifies `verification` (3 attempts, unit
  and run carry the class, the report shows `- verification: 3`); a reviewer refusal classifies
  `review`; a credential in the diff classifies `security`.
- Full suite green: **407 tests, 407 pass** (up from 396). `tsc --noEmit` clean.

**Remaining gaps.** The class is recorded; nothing yet reads it back. WP-6's `LearningDigestService`
is the consumer, and ADR-012 stays Proposed until that code lands.

**Next.** WP-4 — foundation readiness (disk space + write/fsync), so an unwritable data directory
refuses at startup (exit 75) instead of failing mid-run.

## WP-4 — Foundation readiness (4.13.29)

**Executive summary.** `classifyReadiness` probed the ledger's own write path — whether the store
could read and write its file — but not the ground the store stands on. A data directory that is
read-only, not creatable, or nearly full fails the *next* whole-file rewrite, not the probe that
just ran: the service could report healthy and lose the ledger minutes later. The data directory is
now its own readiness check, and a failure there refuses startup with exit 75.

**What was built.**

- `healthService.ts`: a `storage` check beside the ledger, configuration, and runtime checks. It
  writes a bounded payload into `path.dirname(DurableStore.dataFile())`, `fsync`s it, reads it back,
  and always removes the probe file. It then measures free space via `statfsSync` and applies a
  64 MiB floor (`MIN_FREE_BYTES`), because a near-full volume accepts the probe write and fails the
  whole-file rewrite that follows.
- `evaluateFreeSpace(freeBytes)` is pure and exported so the threshold boundary is unit-tested.
  A `statfs` failure degrades to `warn`, not `fail`, because the write/fsync probe already proved
  durability.
- No new environment variable; no behaviour change to the healthy path. `README.md` documents the
  check.

**Verification evidence (ground truth).**

- Failing-first: with `checkStorage()` removed from `classifyReadiness`, the writable-directory,
  read-only-directory, and uncreatable-directory assertions all fail (**3 fail**); the pure
  free-space boundary and the server-refusal assertions do not depend on the wiring and stay green.
- `test/health-storage.test.ts` — the floor boundary (`MIN_FREE_BYTES - 1` fails, exactly
  `MIN_FREE_BYTES` passes, `NaN`/negative warn), a writable directory passing with no `.health-*`
  litter left behind, a read-only directory (`chmod 0o500`, skipped under root) failing with
  `not writable or not fsync-durable`, an uncreatable directory (`ENOTDIR`, root-proof) failing,
  and `server.ts` reading `unhealthy` into `refuseWhileLedgerUnusable` → `process.exit(75)`.
- Full suite green: **412 tests, 412 pass** (up from 407). `tsc --noEmit` clean; docs gate 6/6.

**Remaining gaps.** The floor is a fixed 64 MiB constant, not operator-configurable — deliberately,
so it cannot be silently lowered to silence the check. The loop's own worktree directories sit under
`FACTORY_WORKSPACE_ROOT`, a different filesystem that this probe does not cover.

**Next.** WP-5 — unrelated-writes guard, shipped in shadow mode only, naming an edit it would have
refused without refusing it.

## WP-5 — Unrelated-writes guard, shadow mode (4.13.30)

**Executive summary.** Every commit stages the whole working tree, so the diff that reaches git is
the implementer's claim *plus whatever else landed in the tree*. `claimed-files-exist` refused a
claimed file that did not change; nothing looked the other way — a file that changed and was never
claimed. That is the cross-cutting write: a formatter's rewrite, a codegen side effect, residue from
a tool the unit ran, all committed under a message that describes only the claimed work. This WP
adds the sensor and, deliberately, not yet the enforcer.

**What was built.**

- `unrelated-writes`, a new gate at `commit.before`. It reads `Proof.claimedFiles` (the
  implementer's manifest) and `Proof.observedFiles` (`git status --porcelain
  --untracked-files=all`), subtracts the claimed set and the allowlist, and names any file that
  changed without being claimed. Wired end to end: `gateIds.ts:unrelated-writes` →
  `REGISTRY` in `loopGates.ts` → `doctrine/hooks/hooks.json:commit.before` →
  `doctrine/rules/rules.json:R-16` (mapping `policy` in `loopFailureClass.ts`). A gate with no
  implementation, a rule with no gate, or a gate no stage runs is a test failure.
- `loop.json:unrelatedWrites` is a validated, optional doctrine block: `{ enforce, allow }`.
  Absent → `{ enforce: false, allow: [] }`. `parseUnrelatedWritesBlock` refuses any other shape.
  The allowlist matches a full path or a basename via the commit boundary's own glob
  (`pathMatchesPattern`).
- **Shadow is the default.** With `enforce: false`, the gate records
  `SHADOW: would refuse N unrelated write(s): <files>` and returns `passed: true` — recorded, not
  refused. `enforce: true` returns `passed: false` with the same list. No proof → inert
  (`passed: true`, "no proof"), never a fabricated refusal.
- Docs: `README.md` loop safety model and `doctrine/DOCTRINE.md` (stage table + R-16).

**Verification evidence (ground truth).**

- Failing-first, unit: with the `REGISTRY` entry removed, **7 assertions fail** — the whole
  `test/unrelated-writes.test.ts` suite (the gate has no implementation) plus the loop-doctrine
  wiring test. Restored, all pass.
- Failing-first, end to end: with `unrelated-writes` removed from `hooks.json` (and the manifest
  re-pinned), the real loop test fails with `gates never executed during a real run:
  ['unrelated-writes']` — the happy-path assertion that every `GATE_ID` actually runs during a run.
- `test/unrelated-writes.test.ts` (new, 8 tests): the shadow record, the enforced refusal,
  allowlist-by-basename and by-pattern, a fully claimed tree passing, a missing proof staying inert,
  the registry/classification wiring (`registeredGateIds`, `unclassifiedGateIds`, `GATE_IDS`), and
  the doctrine boundary (shipped default, absent block, malformed `enforce`, malformed `allow`).
- `test/loop-failure-class.test.ts` — the gate→class map test now pins `unrelated-writes → policy`.
- Full suite green: **420 tests, 420 pass** (up from 412). `tsc --noEmit` clean; `doctrine:manifest
  --check` verified (6 files).

**Remaining gaps.** The guard is a sensor: `enforce` is `false`, so a real unrelated write is
recorded and still committed. Graduating it to enforce is parked for a later sprint, gated on the
observed false-positive rate. The allowlist is empty in the shipped doctrine — an operator adds
their repository's generated files before turning enforcement on.

**Next.** WP-6 — a bounded, deterministic learning digest over `factoryLoopRuns` (read-only,
injection behind a default-OFF flag), and the flip of ADR-012 Proposed → Accepted with it.
