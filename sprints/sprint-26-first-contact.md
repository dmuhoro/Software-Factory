# Sprint 26 — First Contact

**Status:** complete · **Opened:** 2026-10-08 · **Closed:** 2026-10-08

**Thesis:** a system that has only ever run against its own fixtures has not run.
This sprint took 4.13.0 to a real host and the loop to a real external
repository for the first time. Both found defects a green suite could not, and
both defects are recorded here with the command that exposed them.

Follows `docs/CONSTITUTION.md`, ADR-006, and the cross-repo SOP.

---

## 1 — The first live deployment (4.13.1)

Railway service `Forge` (project `forge`) rebuilt from `dmuhoro/Software-Factory`
with a persistent volume at `/data`. Four failures, in the order they appeared:

| # | Failure | Cause | Fix |
|---|---|---|---|
| 1 | `refusing to start: FACTORY_API_KEY is a known placeholder` | the local `.env` key is the public placeholder from `.env.example` | generated a real key, set via `railway variable set FACTORY_API_KEY --stdin` |
| 2 | `refusing to start: EACCES: mkdir '/data'` | no volume mounted | `railway volume add --mount-path /data` |
| 3 | `refusing to serve: EACCES: open '/data/…json.lock'` | image ran as `factory`, Railway mounts volumes `root:root` | `docker-entrypoint.sh` chowns then drops via `setpriv` (never serves as root) |
| 4 | banner claimed three settings "have NO effect" | `FACTORY_ENFORCEMENT_MODE`, `FACTORY_DOCTRINE_ROOT`, `FACTORY_LOOP_REPORT_DIR` are read by real code but were absent from the recognised list | registered them |

Failure 4 is the sharp one: the banner was denying a capability the system has.
That is the mirror image of claiming one it does not, and it would lead an
operator to delete a setting that is in use.

**Outcome:** `status: Online`; `/api/factory/health` → `200`,
`durableStore: healthy`. `configuration: degraded` is the honest fail-closed
default (no model secret refs permitted, no tenants provisioned), not an error.

## 2 — The first run against a real external repository (4.13.2)

Target: a scratch clone of FundiOS at `f3a0289`, driven by
`npm run verify:fundios -- --repo <clone>` — the real `GoalIntakeService.draft`
and `ExecutionLoopService.run`, against a local stub model port.

**First run: STUCK.** `M1` was refused on all three attempts:

```
GATE_REFUSED:implement:claimed-files-exist:
  claimed file is unchanged from HEAD: docs/verification/software-factory-loop-proof.md
```

The file was present and new. `git status --porcelain` collapses an untracked
directory to a single `?? dir/` entry, so the ground-truth path list held
`docs/verification/` where the gate was asked about
`docs/verification/proof.md`. Every fixture until now wrote a flat file into a
repository root, so this never fired.

**Fix at the root:** enumerate with `--untracked-files=all` in `changedPaths`
(`groundTruthService`) and in the rollback snapshot `treePaths`
(`executionLoopService`). A Daftari run had never hit it because its units edited
existing files.

**Failing-first:** `test/loop-execution.test.ts` — "a unit that creates a new file
inside a new directory is committed, not refused". Observed failing with the fix
reverted (1 fail), passing with it (1 pass).

**Evidence:** `artifacts/sprint-26/fundios-e2e-evidence.txt` — `completed`, unit
`M1:done`, 21 gates executed and 0 refused, commit `0265c7a4a9bb` carrying
`Verified:` / `Proof: sha256:` / `AI-Assisted:`.

## 3 — What is now true

- The service builds from `main`, persists to a volume, and serves on a public
  host, all under the unprivileged `factory` user.
- The loop takes a goal, produces a task document, executes it against a
  repository it has never seen, and commits only verified work.
- `npm run verify:fundios` is re-runnable and idempotent (it resets the scratch
  clone to its upstream), so the claim above is a command, not a memory.

## 4 — Still open (operator-blocked, not engineering backlog)

- No model secret refs permitted on the deployment, so model providers cannot
  authenticate; the loop runs its deterministic path. Granting `GEMINI_API_KEY`
  (or another provider) via `FACTORY_ALLOWED_SECRET_REFS` + `FACTORY_MODEL_ALLOWED_HOSTS`
  is an operator action.
- No tenant credentials provisioned; all tenant access is `platform_operator`.
- Sustained throughput and the container/microVM boundary remain as recorded in
  sprint 24.
