# Sprint 34 — First Orders

**Status:** opened · **Opened:** 2026-10-17 · **Closed:** —

**Thesis.** Sprint 33 finished the engineering and left only operator items. Two of those items still
have code underneath that nobody owns or that cannot yet produce honest evidence, and one shipped
defect (the release ritual could not see a manifest/version drift) is on `main` ahead of the last tag.
This sprint removes the last code obstacles to a **production trial**: delete the unowned Rust
runtime, fix the benchmark so its adoption rule can actually decide, make the trial's evidence
report itself from the ledger and git, and add a preflight so the first live pull request cannot be
opened from a misconfigured credential. Each WP is one version; each is proven on the real path.

## Premises verified against the live tree (SOP rule 2: cite before editing)

1. **The release-gate fix is real and already on `main`.** `main` is `ff1db2f`
   (`fix(release): the ritual must catch a manifest/version drift, and main is green again`),
   three commits ahead of the last tag `v4.15.12` (`f56e012`). `scripts/verify-release.sh` now
   contains the "deployment runs this release's image" check; `verify` is the first green CI since
   `v4.15.6`. WP-1 cuts the tag that carries this fix.
2. **A tag push does not reach production.** `verify.yml` triggers only on
   `push: branches: [main]` and `pull_request` (`.github/workflows/verify.yml:6-9`). A `v*` tag push
   triggers only `publish.yml` (`.github/workflows/publish.yml:37-41`), which publishes both images to
   GHCR under `ghcr.io/<owner>/<repo>/{runtime,node}` (`publish.yml:84-93`) and **refuses** unless a
   `verify` run for that SHA is `completed success` (`publish.yml:109-127`). It builds and pushes
   images; it deploys to no cluster. The `runtime` image is the Rust one WP-3 deletes; after WP-3 the
   publish matrix must carry only `node`.
3. **The Rust runtime is unowned and unconsumed.** `docs/RUST-RUNTIME-DECISION-MEMO.md` records the
   evidence: no service calls it (only log-label strings at
   `src/services/telemetryStore.ts:239` and `src/services/localTelemetryStore.ts:53`); it is not
   published (`docs/OPERATIONS.md:100`, `artifacts/README.md:21-32`); no sprint owns it
   (`sprints/sprint-30-cloud-surface.md:52-54`, `sprints/sprint-31-reproducible-workhorse.md:402`).
   Daniel's decision: **Option C — delete it** (WP-3).
4. **The benchmark cannot decide yet.** The pre-registered rule
   (`sprints/sprint-33-closing-sprint.md:54-63`, reproduced in
   `src/services/skillBenchService.ts:77-80`, drift-guarded by `test/skill-bench.test.ts:117-129`)
   requires the two **per-arm** Wilson intervals to not overlap. The comparison is unpaired across
   arms, which at bench n (`fixtures × repetitions`) is underpowered and ignores that each fixture is
   run under both arms. No real run has happened — every run to date is the `stub: true` dry pass
   (`test/skill-bench.test.ts:189-204`). WP-2 amends the rule **before any real run**.
5. **There is no automatic trial report and no PR preflight.** The ledger carries the raw material
   (`factoryLoopRuns`, `proofRecords`, `pullRequests`, `mergeRecords`, `usageEvents` —
   `src/services/durableStore.ts:35-43`; the run shape is `src/services/loopTypes.ts:103-140`), but no
   command turns it into trial evidence, and `prFlowService.ts:39-55` will open a real GitHub PR
   without any preflight that the credential/host/repo are the allowlisted ones.

## Decisions recorded (Daniel, 2026-10-17)

- **Rust runtime: delete (Option C).** Executed as WP-3. Last commit containing the crate is tagged
  `rust-runtime-final` (a new tag only; no existing tag is moved). ADR-003 is superseded by a new ADR.
- **Cut the release for the release-gate fix.** Executed as WP-1 (`v4.15.13`).
- **History-rewrite question:** not stated as deliberate. Nothing is written about it; the question is
  carried in the sprint report for Daniel to answer.

## Hard limits (do not violate in this sprint)

- **Fail closed.** A preflight or a report that cannot establish its facts refuses; it never degrades
  to "looks fine". The trial report never prints a number it cannot derive from the ledger or git.
- **The benchmark rule is amended before any real run, and says so.** No threshold is loosened to fit
  data that does not exist. The amendment is dated and recorded here.
- **No tag is moved and no branch is force-pushed.** `rust-runtime-final` is a **new** tag.
- **One version per WP** (feature commit, release commit, annotated tag, push, verify
  `remote main == tag^{commit}`).
- Standing rules: temp repos with `git -C` in tests; the full suite runs detached and never twice at
  once; never commit `.factory-test/`.

## Work packages

| WP | Objective | Proof (verified on the real path) | Version | Status |
|---|---|---|---|---|
| **WP-1** | Release the release-gate fix. Report what a tag push triggers **before** pushing. | full green suite; `bash scripts/verify-release.sh` passes; annotated tag `v4.15.13`; `origin/main == v4.15.13^{commit}`; CI `verify` green | v4.15.13 | in progress |
| **WP-2** | Make the adoption rule able to decide: paired per-fixture analysis (sign test / exact McNemar), keep the ≥10pp threshold and the no-rise-in-STUCK/refusals clauses, **drop** the non-overlapping-interval clause, record the MDE at current n. Add ≥4 multi-file fixtures. Report prints model id, tokens, wall time; refuses `stub: true` as evidence. Runbook command + runtime estimate. | the arithmetic tests pass on the paired rule; the drift guard matches the amended sprint text; the stub dry pass still runs and is still refused; the multi-file fixtures run failing-test-first; the report refuses a stub | v4.15.14 | pending |
| **WP-3** | Delete the Rust runtime (Option C). Tag `rust-runtime-final`; supersede ADR-003; remove the crate, k8s manifests, `verify-k8s.py`, `verify-rust.sh`, the `publish.yml` runtime entry and the rust/manifests CI jobs; re-anchor NC-4/8/9 honestly; regenerate README + CODEBASE-INDEX. | grep shows no reference to the crate; CI has no rust job; fresh-clone gate + full verify green; `verify-release.sh` sixth-site check removed with the crate | v4.16.0 (minor) | pending |
| **WP-4** | Automatic trial evidence: `npm run trial:report -- --repo <path> --since <date>` derives verified commits, units attempted/STUCK, failure classes, wall time, tokens/cost where reported, and post-merge reverts/fixes from the ledger + git. `trial:note` records operator-entered fields, clearly labelled. `docs/PRODUCTION_TRIAL.md` with five readiness criteria and the success definition. | tests over a fixture ledger; the report refuses to claim a number it cannot derive | v4.16.1 | pending |
| **WP-5** | Live-PR readiness: `verify:pr-config` preflight checks the allowlisted secret ref, the permitted host, and the repo scope **without opening a PR**; runbook section with the exact fine-grained token scopes. | the preflight passes on a correct config and refuses each of missing secret / wrong host / wrong scope; the operator opens one PR in a scratch repo | v4.16.2 | pending |

## WP-2 amendment to the pre-registered adoption rule (recorded BEFORE any real run)

The rule recorded in `sprints/sprint-33-closing-sprint.md:54-63` is **amended** here on 2026-10-17,
**before any real (non-stub) benchmark run has ever been executed**. The original text stays in the
sprint-33 file as the historical record; this is the operative rule. What changed and why:

- **Added:** the comparison is now **paired per fixture**. Each fixture is run under both arms; a
  fixture is classified as *on beats off*, *off beats on*, or *tie* (by aggregate first-attempt rate
  across repetitions; ties pass over). Significance is an **exact sign test** over the non-tied
  fixtures (equivalently, exact McNemar over paired per-repetition outcomes), at α = 0.05.
- **Kept:** the first-attempt rate must improve by **≥ 10 percentage points** in aggregate, and
  **neither the STUCK rate nor the refusal count may rise**.
- **Dropped:** the "two Wilson intervals do not overlap" clause. It compared the arms as if they were
  independent samples; the design is paired, so that clause was both underpowered and the wrong test.
- **Recorded:** the **minimum detectable effect (MDE)** at the current n is stated in the report, so a
  null result is read as "below the MDE at this n", not as "no effect".

The amended rule, in full:

> A skill is enabled for a role **only if**, over the bench (skills on vs off, ≥3 repetitions per
> task, paired per fixture): a fixture counts as *on beats off* when its aggregate first-attempt rate
> is higher with the skill on than off, and *off beats on* when lower; an **exact sign test** over the
> non-tied fixtures rejects the null at α = 0.05 in favour of *on*; **and** the aggregate first-attempt
> rate improves by **≥ 10 percentage points**; **and** neither the STUCK rate nor the refusal count
> rises. Otherwise the skill **stays off**. The report states the MDE at the observed n.

## Parked (deliberately, with the reason)

- **Engineering `unrelatedWrites.enforce`** — waits for ≥ 30 adjudicated units from a real trial
  (`sprints/sprint-33-closing-sprint.md:65-79`).
- **Learning injection, maintenance sweeps, skills injection** — each waits on trial data or on the
  benchmark (WP-2) producing a positive result.
- **File splits** — no correctness reason this sprint.

## Verification, step by step

Every WP ends with: `npm run lint`; `npm test` (the full suite, detached, on this host); the WP's own
gate(s); then a release commit + annotated tag + push + `git rev-parse` check that
`origin/main == vX.Y.Z^{commit}`. WP-3 additionally runs `verify:fresh-clone` and the full
`npm run verify`. WP-2 additionally runs `npm run bench:skills -- --dry` and the fixture `--check`.
