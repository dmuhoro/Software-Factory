# Real-Time Work-Management View — Software Factory

Run: audit-three-product
Date: 2026-10-21

Software Factory already ships a real-time work-management surface. It is not a separate dashboard you must build — it is the product's operator panel.

---

## What exists today (live)

### Browser operator panel (in the React frontend)
- **Unattended Loop tab:** paste a tenant API key (memory-only, never persisted), draft a goal, submit a run, tail its live stream
- **Interactive Intake tab:** one clarifying question at a time (grill session), capped at `FACTORY_GRILL_MAX_QUESTIONS` (default 8), then drafts a task document

### REST API (tenant-scoped, authenticated)
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `POST /api/loop/runs` | POST | Start a run → `202 { runId, status: "running" }` |
| `GET /api/loop/runs` | GET | List all runs for the tenant |
| `GET /api/loop/runs/:id` | GET | Durable run record (404 for foreign tenant) |
| `GET /api/loop/runs/:id/events` | GET | SSE stream of recorded events, ends with `event: done` |
| `POST /api/loop/goals` | POST | Draft a parser-accepted task document from a natural-language goal |
| `POST /api/loop/grills` | POST | Start an interactive intake session |
| `GET /api/loop/grills/:id` | GET | Durable session record |
| `POST /api/loop/grills/:id/answers` | POST | Answer one question → next question or `done: true` |
| `POST /api/loop/grills/:id/finish` | POST | Draft task document from goal + transcript |
| `GET /api/workspace/inbox` | GET | Projects, blocked jobs, unfinished jobs, pending approvals, stale work |
| `GET /api/factory/capabilities` | GET | Capability manifest (14 live, 4 blocked) |
| `GET /api/factory/health` | GET | Fail-closed readiness |

### Run reports
Every run writes `<runId>.md` and `<runId>.json` to `FACTORY_LOOP_REPORT_DIR` (default `.data/loop-runs/`), including refusals. Reports carry commands, exit codes, output digests, failure classes, and commit provenance.

### Workspace management
- `POST /api/workspace/projects` — register a Git repo inside the approved workspace boundary
- `GET /api/workspace/jobs/:id/continuation` — continuation report for incomplete work (missing briefs, plans, branches, verification, previews, completion tasks)

---

## How the loop manages work in real time

The unattended loop runs `PLAN → IMPLEMENT → VERIFY → COMMIT → REPORT` per unit:

1. **PLAN** — writes acceptance criteria, verification commands, touched surface to a plan artifact. Gates: doctrine integrity, isolation, resource admission, plan-is-executable.
2. **IMPLEMENT** — model returns a file manifest; files written through a traversal-guarded writer.
3. **VERIFY** — commands executed against the working tree; exit codes and output digests recorded; narration discarded.
4. **COMMIT** — diff scanned for credentials, checked for undeclared writes, committed, tree re-checked clean.
5. **REPORT** — markdown report records every check, digest, commit.

**Failure handling:** 3 attempts per unit, then `STUCK` with failure class (`security`, `verification`, `review`, `model`, `environment`, `policy`, `unknown`) and a class-specific next step. The `loop.run.settled` webhook names stuck units and what to do. Independent work continues; a `DEPENDENCY_STUCK` unit blocks dependents.

**Hard stops:** attempt cap (3/unit), wall clock (360 min), total attempts (90), max commits (400), doctrine integrity, resource exhaustion.

**Sandbox:** verification runs in bubblewrap (system tree read-only, home not mounted, writes confined to repo, network off unless enabled). A command that can't be sandboxed is refused, never run bare.

---

## What a "preview plane" / Lovable-style UI would add

Software Factory's current panel is **operator-facing and terminal-like**: you paste an API key, submit a run, tail an SSE stream. It is not a **live visual preview of the product being built** (like Lovable's preview pane showing the React app as it's constructed).

### Gap
There is no in-browser surface that shows:
- The target app's UI rendering as units are implemented
- A side-by-side of "before / after" for each commit
- A playable preview of the repo under construction (e.g., the StashMind headless API or EasyTutor mobile screens)
- Real-time diff visualization per unit

### Is it worth building?
Only if your operators need to **see the product taking shape**, not just the loop's event stream. For a founder doing pilot work, the existing panel + run reports may suffice. For a team running many concurrent jobs across repos, a preview plane adds real value.

### Minimal viable preview plane (if you want one)
A new tab in the frontend that, per run:
- Clones the target repo to an ephemeral worktree after each commit
- Runs the target's build/dev server on an ephemeral port
- Proxies it through an iframe or screenshot endpoint
- Shows commit → preview mapping with "before/after" toggles

This is additive, not blocking. It does not change the loop, the doctrine, or any gate.

---

## Bottom line

Software Factory already manages work in real time via its REST API, SSE event stream, inbox, and browser operator panel. What it does **not** have is a live visual preview of the products under construction. Build that only if an operator explicitly needs to watch the target app render as it's built; otherwise the current panel + run reports are sufficient for a controlled pilot.
