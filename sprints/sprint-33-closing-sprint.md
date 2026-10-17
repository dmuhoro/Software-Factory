# Sprint 33 — The Closing Sprint

**Status:** WP-0 governance landed · WP-1 vendoring landed · WP-2 intake landed · WP-3..WP-7 in flight · **Opened:** 2026-10-16 · **Closed:** —

**Thesis.** Finish every remaining engineering item so that the only work left is **operator-only**, and
make each of those operator items **one command**. A "blocked" item may name an owner only if that owner
is the *only* party who can unblock it; a public MIT repository, a public harness, or a script an
operator can run is **not** a blocker and must be reclassified or built.

## Premises verified against the live tree (SOP rule 2: cite before editing)

The brief for this sprint said it "follows Sprint 31 (v4.15.5)" and named the file
`sprint-32-closing-sprint.md`. Both premises are stale; verified and corrected here:

1. **Sprint 32 is taken.** `sprints/sprint-32-doc-integrity.md` exists and shipped as **`v4.15.6`**
   (`git tag --sort=-v:refname | head -1` → `v4.15.6`; `sprints/sprint-32-doc-integrity.md` WP-5).
   This sprint is therefore **Sprint 33**, and it follows **Sprint 32 (v4.15.6)**, not v4.15.5.
   The file is `sprints/sprint-33-closing-sprint.md`. (Daniel confirmed, 2026-10-16.)
2. **The external skill sources are public and fetchable.** The brief's RULE ON BLOCKERS says public
   MIT repos are not blockers, and the best prior statement of the coordinates was wrong or missing:
   - **Pocock** = `https://github.com/mattpocock/skills` (the `engineering/*` and `productivity/*`
     paths in the brief match this repo's `skills/engineering/*`, `skills/productivity/*`).
   - **Ondrej** = `https://github.com/davidondrej/skills` (MIT; first recorded in
     `sprints/sprint-30-cloud-surface.md:21`).
   Both were reachable by `git ls-remote` from this environment on 2026-10-16. The prior owner string
   `engineering + Pocock/Ondrej` (`src/services/capabilityManifest.ts:132`, rendered to `README.md:181`)
   was therefore false: the third party gates nothing, the repository does. WP-0 corrects the owner to
   `engineering`; WP-1 does the vendoring.

## Hard limits (do not violate in this sprint)

- **No new egress outside the single door (ADR-011)**; no public ingress.
- **Skills stay advisory and default OFF (ADR-013)**; no research-and-web skills (the Ondrej
  `research-and-web` set and the Pocock `research` skill are excluded).
- **No claim of cloud-ready** until an operator drill evidence file exists.
- Standing rules: temp repos with `git -C` in tests; the full suite is run detached and never twice at
  once; never commit `.factory-test/`; one version per WP (feature commit, release commit, annotated
  tag, push, verify `remote main == tag^{commit}`).

## Work packages

| WP | Objective | Proof | Status |
|---|---|---|---|
| **WP-0** | Close Sprint 31 (status + date); correct the blocker owners (`external-skill-adoption` → engineering; `skills-adoption-evidence` → harness: engineering / model run: operator); open this sprint | owner corrected in `capabilityManifest.ts` and re-rendered into `README.md`; `verify:docs` green | **done** |
| **WP-1** | Vendor the skills: `scripts/vendor-skill.ts` clones a source at a commit, copies only referenced markdown, strips the rest, writes provenance (URL, commit, licence, sha256), keeps each LICENSE. Flip `external-skill-adoption` to **live**; injection stays **OFF**. | pin gate refuses a tampered vendored file; the registry lists every pinned skill; each vendored file read in full and cleared of network/edit/skip-approval/loop instructions | **done** |
| **WP-2** | Interactive intake ("grill session", human-in-the-loop) through the control plane: start/answer/finish, one question per turn, hard cap, durable and resumable, tenant-scoped; finish drafts a task document through the existing parse-or-refuse path. Phone panel to answer and review. | failing-first tests: the question cap, tenant isolation, resume after restart, a refused malformed draft | **done** |
| **WP-3** | Diagnose on stuck: from attempt 2 of a unit, when skills are on, the implementer prompt gains the `diagnosing-bugs` advisory block; a STUCK unit's report carries failure class, what was tried, and a next step, delivered through the settlement webhook. | prompt-assembly tests (block present only at attempt ≥ 2 and only when enabled); report-content test | **pending** |
| **WP-4** | Benchmark harness (`npm run bench:skills`): 12–15 synthetic fixture repos under `test/fixtures/bench`, paired on/off runs, ≥3 repetitions, JSON output with Wilson intervals, labelled by model; stub dry pass labelled `stub: true`; pre-registered adoption rule. | the stub dry pass runs; the capability manifest refuses stub output as evidence; the rule is in this file **before** any real run | **pending** |
| **WP-5** | Host and image hygiene: move `software_factory/host` → `deploy/host` and repoint every reference; add `bubblewrap` to the image; `verify:image` reports the runtime flags the sandbox needs and fails closed when absent; `docs/RUNBOOK_EXECUTOR_HOST.md`; `verify:host --record` writes dated evidence. | `verify:image` fails closed without bwrap; `verify:host --record` writes a dated file | **pending** |
| **WP-6** | Enforcement graduation tooling: `unrelated-writes:report` summarises the shadow log across runs (units observed, would-refuse count, each would-refuse listed). Record the flip rule; **do not flip** `enforce`. | the report runs over the shadow log and lists every would-refuse | **pending** |
| **WP-7** | Decision memo (no code): the Rust runtime (`software_factory/`) has no owner and its own tenant model. Options (archive, keep with an owner, delete) + a recommendation. | the memo; **STOP for Daniel** | **pending** |

## Pre-registered adoption rule (WP-4 — recorded BEFORE any real run)

A skill is enabled for a role **only if**, over the bench (skills on vs off, ≥3 repetitions per task):

- the first-attempt rate improves by **≥ 10 percentage points**, and
- the two Wilson intervals do **not** overlap, and
- neither the STUCK rate nor the refusal count rises.

Otherwise the skill **stays off**. This rule is written here before any real measurement so the
decision cannot be moved to fit the data (ADR-013 §7: preference is not evidence).

## Parked (named, not worked)

File splits of `executionLoopService.ts` and `App.tsx`; maintenance sweeps; mutation testing on the gate
suite; the JSON-ledger scaling trigger; learning injection (ADR-012 §6).
