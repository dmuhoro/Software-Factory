# Sprint 23 — Evidence first: close every open finding, then prove the loop

Status: done. Base: the five open findings recorded at the end of
[`sprint-22-trustworthy-unattended-loop.md`](sprint-22-trustworthy-unattended-loop.md).
Every claim below is tied to a commit, a run id, or a named test. Nothing is claimed from a
model's account of itself.

## L1 — All five sprint-22 findings closed

Each finding was closed with a failing-first test, a real-behaviour change, and a replay against
the artifact that produced the finding. Suite grew 211 → 219; lint and doctrine manifest green.

### L1a — opaque exit-1 refusals became named codes (`3fbabf2`)

35 message-only domain errors now carry a stable code and a fixed, leak-free message. The
coverage test (`test/l3-error-contract.test.ts`) widened to three throw-form patterns so a new
uncoded error fails the build; a CLI replay test (`test/loop-cli-refusal-codes.test.ts`) spawns
the real CLI for the two real cases that previously printed `INTERNAL_ERROR` plus an incident id.
Negative evidence: pre-fix, the coverage test listed 35 uncovered codes and the CLI test failed
2/2.

### L1b — a failed command reaches the next attempt with its file:line (`98bebdf`)

`extractLocators` (`groundTruthService.ts`) pulls `file.ext:12:3`, `file.ext(12,3)`, and node
stack frames out of a failed command's output tail; the ground-truth gate appends them to the
refusal detail. Negative control: with `loopGates.ts` stashed, the new end-to-end test failed
with a bare `cmd:unit-M1 exit 1` and no location.

### L1c — `diff:comment-claim` refuses a comment its code contradicts (`22e4c81`)

A new ground-truth check reads `git diff --unified=0` for added comment lines, then reads the
**working tree file** to find the annotated line and its string literals (a `--unified=0` diff
never shows the unchanged annotated line, which is why the first implementation missed the real
case). A comment naming a value the annotated line does not use refuses the unit.

Replay against the real artifact: the false comment recorded by `f32dde2`
(introduced in `c5d6a47`, `scripts/run-pilot.ts:17`) — "the comment names the empty string, but
the annotated line uses 'default'" — now yields `proof.passed = false`. Negative evidence: both
new tests failed pre-fix asserting the check must exist.

### L1d — `no-op-unit` refuses a unit whose proof already holds (`3d24567`)

A unit whose own `verify:` command already exits 0 on the starting tree is a no-op: every retry
reproduces the same committed state, so the attempt cap can only be burned. The gate refuses it
once, before the implementer is dialled, and the loop records the unit `stuck` and stops. This
required a targeted `break` in the driver, which otherwise retried regardless of status — proven
by the RED result `a futile check was retried / 3 !== 1`.

Replay against the real Daftari M2 (`looprun_baabd8f138d822bca628cb29`): its exact command now
exits 0 on the starting tree and `runGate('no-op-unit', …)` returns `passed = false` naming the
command. Doctrine moved with the code: `R-15-NO-OP-UNIT`, the `no-op-unit` hook at
`implement.before`, `DOCTRINE.md`, and `manifest.json` re-pinned.

### L1e — a sandbox-masked toolchain is named, not a bare exit 127 (`1eb653b`)

The sandbox masks `/home`; this machine's `npm` lives under it. A sandboxed verify died with
`sh: 1: npm: not found` (exit 127) and burned all three attempts. `runCommand` now turns a
sandboxed exit 127 into `SANDBOX_TOOLCHAIN_HIDDEN: …`, naming the masked mounts and the fix; the
loop treats it as terminal for the unit; `no-op-unit` also refuses a declared verify that exits
127, so the model is never dialled for a command that cannot run.

Replay against the real artifact: the exact pre-remediation M1 verify from `30a1bf5`, run under
the real sandbox in this repository, returns exit 127 with `SANDBOX_TOOLCHAIN_HIDDEN`. Negative
evidence: the sandbox test failed on "the refusal must be named, not a bare exit code"; the loop
test failed with the model dialled and the cap burned.

## L2 — die-and-resume drill, live

A real CLI run against a scratch repository with a slow verification command was **SIGKILLed
mid-verification** (last event `verify.before`, no commit, one untracked path). Resume:

- run `looprun_875b855f07096ade7d02c68d`; `resumed run was interrupted mid-work; restored 1
  path(s) to the last committed state`;
- reshaped to exactly **one commit** (`7d53719cff8b feat(m1): create-greeting-txt`), `completed`,
  25 gates executed, 0 refused, clean tree.

A guard also proved itself: resuming a *different* run whose task/repo had since changed was
refused with `LOOP_RUN_INCOMPATIBLE`. And the first drill attempt produced a second, unplanned
piece of evidence — because its verify left a residue file, the reviewer refused the unit **3/3**
for touching a file no criterion requested (run `looprun_3a8160da31a7d5884bdd6fd9`). That is the
review gate doing the job no automated check can.

## L3 — adversarial review's true scope (`8152ff0`)

[`docs/ADVERSARIAL_REVIEW_SCOPE.md`](../docs/ADVERSARIAL_REVIEW_SCOPE.md) states what the review
stage is (an LLM reading a diff, criteria, derived evidence, and an architecture brief, returning
`{approved, findings}`), what surrounds it (real commands, real exit codes, narration discarded),
and what it is **not**: a security audit, a correctness proof, an independent verifier, or a
deterministic gate. It names the diff truncation bound (60,000 characters) beyond which a change
is not read.

## L4 — a real throughput batch on Daftari

Task `tasks/daftari-throughput-i18n-batch.md`: four independent, real i18n units, each with a
verify command that fails before the work and passes after.

Run `looprun_e8c12bcd603a16fe1dd9d02c68d`: **4 / 4 committed, all on attempt 1**, 66 gates
executed, 0 refused, 217.6s wall — **54.4s per unit ≈ 66 units/hour** on `gpt-oss:20b-cloud` over
Ollama. Daftari's own `check-i18n` (430/430 keys) and `tsc --noEmit` pass at the resulting HEAD.

Honest caveat: this is a bounded batch of four small units, not a literal eight-hour day; the
per-unit cost is what matters and it is measured, not estimated.

## L5 — release 4.11.0

`package.json`, `package-lock.json`, `CHANGELOG.md`, and `README.md` updated together; annotated
tag `v4.11.0`. The README's loop section now names only the loop's recorded runs (self-hosted
2/2, Daftari 4/4, the resume drill), the unit-level refusals added this sprint, and links the
review scope. Full suite 219/219, lint clean, doctrine manifest clean.

## L6 — public evidence site

`site/` is a self-contained static page summarising the runs, guards, verification, and limits
above. Deployed to Vercel: **https://site-puce-eight-83.vercel.app** (production alias),
publicly reachable, content verified against the same figures without host paths or secrets.

## What is now safe, and what is still open

Safe: the five findings are closed with tests and replays; the reviewer's limits are written down
rather than implied; the loop has been killed and resumed for real, and has run a real four-unit
batch with green results; the release is pinned and tagged.

Still open, and named rather than hidden:

- The throughput figure is a four-unit batch; a multi-hour run across mixed unit sizes is not yet
  recorded.
- The reviewer remains an LLM with correlated blind spots and a 60,000-character diff ceiling.
- The Vercel project was linked to the GitHub repository on deploy; confirm whether push-to-deploy
  is desired or should be disabled.
- The public site is a static evidence page only; no live loop execution is exposed.