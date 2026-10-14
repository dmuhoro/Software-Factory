# Sprint 30 — The Cloud Surface

**Status:** opened (WP-0 governance only; no production code yet) · **Opened:** 2026-10-14

**Thesis.** Sprint 29 gave the factory senses: it checks the ground it stands on, names why an
attempt failed, records a write it would have refused, and reads its own ledger back as a bounded
digest. Sprint 30 gives it a **face and a floor**: a product surface a human can point at one tenant
from a browser or a phone and watch real work, deployed on a runtime that refuses to start if it
cannot serve. Every capability the surface shows must be backed by a named command that demonstrates
it — no claim the code cannot honour (Constitution Part Two).

Follows `docs/CONSTITUTION.md`, the ADRs in `docs/adr/`, `CONTRIBUTING.md`, and the cross-repo SOP.

---

## The finding that scoped this sprint

Three external references were presented as "the infrastructure to bring to life":

- `https://github.com/davidondrej/cloudroom-core` — a Rust cloud-agent runtime (Apache-2.0).
- `https://github.com/davidondrej/skills` — an MIT library of `SKILL.md` capability definitions.
- `https://www.cloudroom.dev/` — a hosted product.

Audited against this repository, the factory **already owns the hard half**: a tenant-authenticated
remote control plane (`loop.routes.ts`, Sprint 24), a durable single-writer ledger (NC-2), the
unattended loop (Sprints 20–28), and the sensor layer plus a read-only learning digest (Sprint 29).
What it does **not** own, and must not pretend to, is another project's runtime and its hosted
product. Those are a different trust boundary, a different deployable, and — for any live call —
operator-supplied credentials and spend.

The corrected scope, therefore, is **the surface over the control plane this repository already
owns**, plus the *patterns* those references name (declarative capabilities; a deployable that fails
closed). Adopting an external repository wholesale is explicitly out of scope (see the blockers).

## Work packages

Each WP is bounded to this repository, carries a failing-first test, and is independently
releasable. Order is a dependency order: declare, then adopt, then surface, then deploy, then tell
the truth about it.

| WP | Objective | Proof | Status |
|---|---|---|---|
| **WP-0** | Governance: this sprint file | `npm run verify:docs` green; no production code | **done** |
| WP-1 | Capability manifest: one machine-readable declaration of what the factory can do, each entry tied to a command that demonstrates it | a test that refuses a declared capability with no named command; served read-only | pending |
| WP-2 | Skills adoption: load declarative `SKILL.md`-style definitions from a governed directory, validate them, expose the installed set; refuse unknown fields | a malformed skill refuses with a code; an installed one is surfaced; no dependency on the external repo | pending |
| WP-3 | Fleet read surface: tenant-scoped summaries across runs plus the learning digest, for a thin web/mobile client; **no new writes** | a foreign tenant sees nothing; the surface adds no mutating route | pending |
| WP-4 | Cloud deployment readiness: a preflight that the runtime can serve (config, single-writer ledger, persistence path, required env), fail closed; the documented Docker/Railway path verified | a misconfigured container refuses at startup; the documented path boots | pending |
| WP-5 | Public evidence page: `site/` states what is **live**, **planned**, or **blocked**, each live item linked to its proving command | the page names no capability the manifest does not declare | pending |

### Scope limits (hard — do not implement in this sprint)

- **No second runtime.** The Rust service (`software_factory/`) stays as-is; this sprint does not
  make it a production engine or route traffic to it. Two live runtimes without one owner is the
  drift the Constitution forbids.
- **No external repository import.** `cloudroom-core`, `skills`, and `cloudroom.dev` are not vendored
  or called live. WP-2 adopts the *pattern* of a declarative capability file, not the repository.
- **No new egress.** Any model call still goes through the single egress door (ADR-011); no vendor
  SDK outside `modelEgress.ts`.
- **No autonomy beyond the loop.** No auto-deploy, no self-modifying schema, no production-data
  cloning, no prompt injection of learning (ADR-012 stays at `inject: false`).
- **No horizontal scale claim.** The ledger is single-writer (NC-2); the surface must not imply
  multi-replica writes it cannot support.

### Evidence plan (per WP)

The repository's discipline, unchanged: a **failing-first test** (shown to fail without its fix, the
negative result recorded in the WP write-up), a **replay** against the real case, a green full suite,
and a release. One version per WP: a feature commit, then a separate release commit (`package.json` +
`package-lock.json` + `CHANGELOG.md` + this sprint file), annotated tag `v4.14.x`, push `main` + tag,
and verify remote `main == HEAD == tag`.

## Named blockers (not worked around)

- **Hosted frontier model (owner: operator).** Needs an allowlisted secret ref, a permitted host, and
  spend (Sprint 28 WP-5). Parked, not stubbed.
- **Live GitHub pull request (owner: operator).** A real open needs an appointed allowlisted token
  and an egress permit (Sprint 28 WP-4). Only refusal-before-socket and loopback are proven.
- **Sandbox in the shipped container (owner: operator).** The runtime image installs no `bubblewrap`;
  sandboxed execution fails closed there (ADR-010).
- **Any live use of `cloudroom-core` / `cloudroom.dev` (owner: operator).** A different repository's
  trust boundary and credentials. This sprint depends on none of them; the surface is built over the
  control plane this repo owns.

## What this means for the ecosystem

Sprint 29 answered *"can the factory feel?"*; Sprint 30 answers *"can a person use it, and will it
stand up?"* When it lands, a tenant can be created, authenticate, submit a goal or an issue, watch a
run live, read a bounded learning digest, see a declared capability only where a command proves it,
load a skill declaratively, and run the whole thing in a container that refuses to start if it cannot
serve. What it still cannot do — call a hosted frontier model, merge a real GitHub PR, sandbox inside
the shipped image, or drive an external cloud runtime — is named above with its owner, as an
operator decision rather than an engineering backlog.

## WP-0 — Governance (this change, no production code)

- This sprint file.

**Evidence:** `npm run verify:docs` green. Full suite unaffected (no production code touched).

**Stopping point:** WP-1 does not begin until this scope is ratified. WP-2's exact shape (the skill
file schema and its governance directory) benefits from founder direction on whether skills are a
product feature or an internal tooling concept before code is written.
