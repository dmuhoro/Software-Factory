# Sprint 35 — Six Layers, One Groundwork

**Status:** opened · **Opened:** 2026-10-22 · **Closed:** —

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
| WP-4 | L5 | Cloudflare: machine-readable security audit findings over repository source | pending |
| WP-5 | L6 | Opik: every model call traced through the door, with token, latency, and cost | pending |
| WP-6 | L7 | Headroom: context compression on the live model-context path | pending |

## Negative results recorded (SOP rule 4: a test that cannot fail proves nothing)

| WP | Test | Without the fix | With the fix |
|---|---|---|---|
| WP-1 | `test/ast-structural-gate.test.ts` (ASG-1..4), driven through `runGate` | the pre-fix gate restored from `git show HEAD:src/services/loopGates.ts` → **1 pass, 3 fail** (ASG-1 refused a legitimate file, ASG-3 refused an import of an unchanged module, ASG-2's refusal carried no file:line) | **4 pass, 0 fail** |
| WP-3 | `test/cross-run-memory.test.ts` (two live runs) | the memory wiring neutralised in `executionLoopService.ts` → **0 pass, 1 fail** (nothing was written to the ledger, so nothing could be read back) | **1 pass, 0 fail**, plus 4 pass in `test/loop-memories-route.test.ts` |
| WP-2 | `test/loop-execution.test.ts` (the live loop) + `test/parallel-read.test.ts` (PR-1..7) | the sequential staging restored in `executionLoopService.run` → **16 pass, 1 fail** (the run record said `sequential`, so the live path had not moved) | **17 pass, 0 fail**, plus 8 pass in `test/parallel-read.test.ts` |

## Hard limits (do not violate in this sprint)

- **No second writer.** Parallelism is read-only; the loop remains the only writer of a target
  tree, and commits stay single-writer.
- **Fail closed.** A check that cannot establish its facts refuses or says it could not run; it
  never degrades to "looks fine", and it never reports a figure it cannot derive.
- **No fabricated cost.** A trace carries a cost only when the operator declared a price for that
  provider. An unpriced provider yields an unknown cost, not a plausible constant.
- **Every new test is shown to fail without its fix**, and the negative result is recorded here
  with the commit that carries it.
