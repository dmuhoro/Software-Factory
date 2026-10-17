# The production trial

A trial answers one question: **can the loop ship small, verified changes to a real repository
unattended, for long enough to trust it?** This document fixes the criteria *before* the trial,
so the answer cannot be chosen after seeing the numbers.

## What the report derives, and how

`npm run trial:report -- --repo <path> --since <YYYY-MM-DD>` reads two sources and nothing else:

| Figure | Derived from | Exact definition |
| --- | --- | --- |
| `runs` | ledger `factoryLoopRuns` | runs whose recorded `repo` resolves to `--repo` and whose `startedAt` is on or after `--since` |
| `units.attempted` | the same runs | units with at least one attempt, plus units whose status is not `pending` (a unit with no attempt and `pending` status is unstarted, not attempted) |
| `units.stuck` / `blocked` / `done` | unit status | exactly the recorded status; a unit is counted in one bucket |
| `failureClasses` | failed `attempt.failureClass` | tallied per attempt; a failed attempt with no class increments `unclassifiedFailedAttempts` and is never guessed |
| `commits.verified` | git | the recorded SHA still exists (`git cat-file -e`) **and** HEAD contains it (`git merge-base --is-ancestor`); otherwise it is listed as unverified with the reason |
| `commits.reverted` | git | a later commit's body carries `This reverts commit <sha>.` naming that loop commit |
| `commits.fixedAfterMerge` | git | a non-loop commit, after the loop commit, whose subject starts with `fix`/`hotfix`/`bug`/`repair`/`correct` and which touches at least one file the loop commit touched |
| `wallTimeMs` | ledger | sum of `finishedAt − startedAt`; a run with no parseable finish makes the whole figure `null` |
| `tokens` | ledger `usageEvents` | sum of `tokens` for events recorded in the window; `null` when no event exists — the execution loop records no usage, so absence is **not** zero |
| `costUsd` | — | always `null`: no dependency in this product reports a price per call |

Anything that cannot be derived is `null` and named under **Not derivable**. The report exits 0
when it produced a report: it is a measurement, not a verdict.

The operator's judgement is not derived. Record it with:

    npm run trial:note -- --repo <path> --verdict accept|reject|hold --notes "what you concluded"

Notes are appended to `<ledger dir>/trial-notes.jsonl` labelled `source: "operator"` and printed in
their own section, so a measurement can never be mistaken for an opinion.

## Five readiness criteria

All five must hold on the same report before a trial is called a success.

1. **Verified delivery.** At least 20 loop commits in the window are `verified` — they still exist
   and HEAD contains them.
2. **Low stuck rate.** `units.stuck / units.attempted ≤ 0.10`, and `units.attempted ≥ 25` (below
   that the ratio is noise, and the report will show a wide interval).
3. **Classes, not mysteries.** `unclassifiedFailedAttempts` is 0: every failure the loop recorded
   carries a class, so the next attempt can act on it.
4. **Corrections are rare.** `commits.reverted + commits.fixedAfterMerge ≤ 2`, and neither counts a
   commit the loop itself created.
5. **Cost is known or explicitly unknown.** `tokens` is a derived number **or** the trial records in
   its operator note that metering is not wired yet. A trial that reports cost without a metered
   token count has invented it; `costUsd` is always `null` here.

A report whose `underivable` list contains any of `wallTimeMs`, `tokens`, or `commits` fails
criterion 5's spirit and cannot support a success claim until the gap is closed.

## Success definition

> A trial succeeds when, over its window, **delivery is verified (1), the loop gets most units
> through on its own (2), every failure is classed (3), the loop's own commits mostly survive
> review (4), and spend is measured rather than assumed (5)** — and the operator records an
> `accept` note that cites the report's `generatedAt` and the exact figures it relied on.

A success claim must name the report file it came from. A claim that cannot name one is not
evidence. This mirrors the constitution's rule that a capability claim needs a named command.

## Running the trial

    # one window, one repository
    npm run trial:report -- --repo /path/to/target --since 2026-10-01 --out artifacts/trials/<date>.md
    npm run trial:report -- --repo /path/to/target --since 2026-10-01 --json --out artifacts/trials/<date>.json

    # the operator's judgement, recorded once the criteria are read
    npm run trial:note -- --repo /path/to/target --verdict accept --notes "criteria 1-4 met; tokens not metered"

`artifacts/` is not committed for archives, but trial reports are small text files; keep them where
the operator can cite them. Do not delete a rejected trial's report: a failed trial is the most
useful evidence the loop has.

## Client paths

The trial covers the loop. The two client paths are verified separately:

- **Web**: the built server serves the UI and the API. Reachability from a physical phone over
  Tailscale is recorded in `sprints/sprint-34-first-orders.md` (WP-6) with the exact URL and the
  command that observed it.
- **Mobile**: the Flutter client is a thin, read-only consumer of `GET /api/factory/health`,
  `/api/factory/metrics`, and the tenant-authenticated routes. Its prerequisites and the exact
  `flutter run` invocation are recorded in the same sprint entry; it holds no credentials of its
  own and speaks only to the Tailscale address of the executor host.
