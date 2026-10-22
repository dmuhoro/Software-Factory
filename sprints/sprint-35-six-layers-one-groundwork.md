# Sprint 35 — Six Layers, One Groundwork

**Status:** closed · **Opened:** 2026-10-22 · **Closed:** 2026-10-22

**Thesis.** Six capabilities were adopted as modules in the previous sprint: an AST knowledge graph
(Graphify), a compression adapter (headroom), security audit findings (the cloudflare
security-audit-skill shape), read-only parallelism (orca), persistent cross-run memory
(ai-memory), and LLM call tracing (opik). Every one of them had a file, a test file, and a
green suite — and every one of them was **outside the live path**. The adapter modules were
reachable only from their own tests. A capability that only a test can reach is a claim, not a
capability, and the Constitution's second part exists to stop exactly that.

This sprint puts those six on the real paths, in layer order, one work package per commit, and
repairs the two live defects the audit found on the way.

## Premises verified against the live tree (SOP rule 2: cite before editing)

1. **The AST structural verification gate was duplicated and wrong.** `src/services/loopGates.ts`
   carried its own copy of the AST check (`:241-322` at `bb3eca3`) while
   `src/services/astVerificationAdapter.ts` carried a second one. The gate's copy reported a
   **method call** (`fs.readFileSync()`) as a call to an undefined symbol, and looked for
   definitions **only among the changed files**, so importing an unchanged module looked
   undefined. The gate is wired into the live loop at `doctrine/hooks/hooks.json` (`verify.after`),
   so both false positives were refusals on legitimate units.
2. **The compression adapter had no caller.** `src/services/compressionAdapter.ts` and
   `src/utils/outputCompression.ts` were imported by `test/compression-adapter.test.ts` and
   nothing else: no model payload was ever compressed.
3. **The persistent memory service had no caller.** `src/services/persistentMemoryService.ts`
   exported `record`/`query`/`consult`, and `src/services/` never imported it: no run wrote a
   memory and no run read one.
4. **The tracing service covered one door of two.** `src/services/llmTracingService.ts` was
   called from `src/services/frontierModelService.ts` (the guarded door,
   `src/utils/egressGuard.ts`), but the Gemini path leaves through the SDK door
   (`src/utils/modelEgress.ts`, ADR-011) and was never traced, and no trace carried a cost.
5. **The read-only parallelism did not exist.** `src/services/parallelWorktreeService.ts` runs
   *writing* agents in git worktrees; nothing parallelised the read-only inspections the loop
   actually performs.
6. **The security audit findings were message-shaped, not source-shaped.**
   `src/services/bugDetectiveService.ts` produced findings from the refusal text and from a
   hardcoded-secret regex over one file's source; it had no repository-level rule set, and no
   file:line resolution for anything but the first symbol in the file.

## Decisions recorded (2026-10-22)

- **Adopt directly:** the Graphify AST graph, the headroom compression, the cloudflare
  security-audit-skill finding shape.
- **Improvise inside SF constraints:** orca-style parallelism is restricted to read-only work
  with single-writer commits (NC-2); ai-memory is a TypeScript port with no Rust (ADR-016);
  opik-style tracing goes through the ADR-011 door and records token, latency, and cost.
- **Leave out:** multi-agent fleets writing to the shared tree (NC-2), general third-party RE
  (ADR-005), Rust dependencies and hosted SaaS (ADR-016).
- **Severity is part of the contract.** A structural finding that is *provable* refuses; a
  finding that a later unit in the same plan could satisfy is advisory. A gate that blocks a
  legitimate run is worse than no gate, because operators learn to bypass it.

## Work packages

| WP | Layer | Work | Status |
|---|---|---|---|
| WP-1 | L2/L5/L7 | Graphify: repository knowledge index, import-closure resolution, one AST implementation behind the gate | done |
| WP-2 | L2/L3 | Orca: read-only parallel inspection service, wired into the real paths | done |
| WP-3 | L3 | ai-memory: persistent cross-run memory wired into the loop runtime | done |
| WP-4 | L5 | Cloudflare: machine-readable security audit findings over repository source | done |
| WP-5 | L6 | Opik: every model call traced through the door, with token, latency, and cost | done |
| WP-6 | L7 | Headroom: context compression on the live model-context path | done |

## Negative results recorded (SOP rule 4: a test that cannot fail proves nothing)

| WP | Test | Without the fix | With the fix |
|---|---|---|---|
| WP-1 | `test/ast-structural-gate.test.ts` (ASG-1..4), driven through `runGate` | the pre-fix gate restored from `git show HEAD:src/services/loopGates.ts` → **1 pass, 3 fail** (ASG-1 refused a legitimate file, ASG-3 refused an import of an unchanged module, ASG-2's refusal carried no file:line) | **4 pass, 0 fail** |
| WP-6 | `test/loop-execution.test.ts` (the live loop) + `test/context-compression.test.ts` (CC-1..5) | with the compression removed from the prompt builders → the live run carries no `contextCompression` evidence and the assertion fails | **17 pass, 0 fail** in the live loop, plus 5 pass in `test/context-compression.test.ts` |
| WP-5 | `test/llm-tracing.test.ts` (LT-8..14) | with the Gemini trace removed and the cost fields dropped → the cost, door and token-source assertions fail (LT-8, LT-10, LT-11) and LT-14 fails outright | **14 pass, 0 fail** |
| WP-3 | `test/cross-run-memory.test.ts` (two live runs) | the memory wiring neutralised in `executionLoopService.ts` → **0 pass, 1 fail** (nothing was written to the ledger, so nothing could be read back) | **1 pass, 0 fail**, plus 4 pass in `test/loop-memories-route.test.ts` |
| WP-2 | `test/loop-execution.test.ts` (the live loop) + `test/parallel-read.test.ts` (PR-1..7) | the sequential staging restored in `executionLoopService.run` → **16 pass, 1 fail** (the run record said `sequential`, so the live path had not moved) | **17 pass, 0 fail**, plus 8 pass in `test/parallel-read.test.ts` |

## A defect found on the way (not part of the six)

`main` was **not green** when this sprint opened: `test/l3-error-contract.test.ts` failed, because
five boundary codes raised by routes (`BUG_DIAGNOSIS_CLASS_REQUIRED`, `PREVIEW_MISSING_REPO`,
`PREVIEW_MISSING_COMMIT`, `PREVIEW_SESSION_NOT_FOUND`, `PREVIEW_TENANT_MISMATCH`) were never
registered in `src/utils/apiError.ts`. Each of them degraded to `INTERNAL_ERROR` and answered `500`
with an incident id instead of its own status. WP-4 registers them; the gate is green.

## Defects found in verification (and what they would have cost)

Two more defects surfaced when the full suite was run, after all six work packages were committed.

1. **The control plane could not start a run — and the one-writer rule had a race (regression from
   WP-2).** `LoopControlService.submit` called `ExecutionLoopService.run` and immediately read the
   run id, relying on the loop's prefix being synchronous. WP-2 introduced
   `await DoctrineIsolationService.stageAsync(...)` before the record is created, so the id was
   still empty at the check. Every submission through the control plane failed with
   *"the loop resolved without creating a run record"* — which also masked the real refusal. Worse,
   `activeByRepo` was set only after the check, so two submissions in the same tick could both pass
   the busy check and start two runs on one repository: a breach of NC-2 (one writer), the exact
   invariant the sprint promised not to touch. The fix claims the repository synchronously with a
   reservation, races the record against the run's rejection, and re-throws the refusal by name.
   Two regression tests were added (`two concurrent submissions … cannot both start a run`,
   `a refusal in the run prefix surfaces by name`); both fail on the pre-fix code.
2. **A raw HTTP client outside the egress boundary (pre-existing on `main`).**
   `src/services/previewPlaneService.ts` imported `node:http` for a loopback readiness poll,
   violating ADR-011 C. `test/egress-confinement.test.ts` was red on `bb3eca3` before the sprint
   began — the sprint record previously noted only the L3 error-contract failure. The probe never
   needed HTTP: a TCP connect to 127.0.0.1 answers "is the port listening", using `node:net` which
   the module already imports. The gate is green and the server tree has no second egress client.

## Hard limits (do not violate in this sprint)

- **No second writer.** Parallelism is read-only; the loop remains the only writer of a target
  tree, and commits stay single-writer.
- **Fail closed.** A check that cannot establish its facts refuses or says it could not run; it
  never degrades to "looks fine", and it never reports a figure it cannot derive.
- **No fabricated cost.** A trace carries a cost only when the operator declared a price for that
  provider. An unpriced provider yields an unknown cost, not a plausible constant.
- **Every new test is shown to fail without its fix**, and the negative result is recorded here
  with the commit that carries it.


## Verification (2026-10-22, after all six work packages)

| Gate | Result |
|---|---|
| `npm run lint` (`tsc --noEmit`) | clean |
| `npm test` | **773 tests, 773 pass, 0 fail** |
| `npm run knip` | clean (was red on `main` before this sprint: 16 unused exported types and 2 duplicate exports) |
| `npm run build` | ok |
| `npm run verify:docs` | 7 passed, 0 failed |
| `npm run verify:tool-agnostic-boundary` | 3 passed, 0 failed |
| `bash scripts/verify-layer4.sh` | 42 passed, 0 failed |

The knip finding was pre-existing: `main` was red on both `test/egress-confinement.test.ts` and
`npm run knip` when the sprint opened, in addition to the L3 error-contract failure this record
already noted. All three are green now. Dead export surface was removed rather than ignored; the
gate was not configured to skip anything.

## Honest handover

- **Safe now:** every one of the six adopted capabilities is on a live path with a test that fails
  without it; the AST gate no longer refuses legitimate units; read-only work runs concurrently
  while the loop remains the only writer; a run can learn from earlier runs without carrying a
  target's words; a security finding cannot carry a secret; a model call cannot claim a cost the
  operator never declared; model payloads shrink without losing evidence.
- **Still open (not blocked by this sprint):** dashboards, paging and on-call remain `blocked` and
  name their operator; the container/microVM executor for untrusted code remains `blocked`; the
  preview plane's readiness probe is a listening-socket check, not an HTTP status check, so a dev
  server that binds before it can serve reads as ready.
- **Credential-blocked work:** live Appwrite storage and hosted model providers need operator-held
  credentials; they are named as blocked, not silently skipped.
