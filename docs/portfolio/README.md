# Portfolio Principle Index

The organisation applies a shared set of engineering principles across several repositories.
This file is the **index** that says which repository owns the canonical text of each
principle. It exists to prevent one real failure mode: a principle copied into three places,
edited in two, and quietly meaning two different things.

## The drift rule

> **A principle has exactly one canonical home.** Other repositories **reference** it. A
> repository that restates a principle marks the copy clearly and names the source. If a copy
> and its source ever disagree, the source is authoritative and the copy is a bug.

Nobody may edit a canonical text in one repository while another repository's copy is left
stale. Change the source, then update the copies, in the same change.

## Canonical sources

| Repo | Governing file | Role |
|---|---|---|
| `Software-Factory` | `docs/CONSTITUTION.md` | Platform constitution. Part Two adopts the execution-safety standard by reference. |
| `kays-wellness-centre` | `docs/engineering/CONSTITUTION.md` | **Canonical owner of the six execution-safety principles** (Article I). Self-declared highest authority for its repo. |
| `afropay-network` | `AGENTS.md` | **Canonical owner** of the ten engineering invariants: database finality, decimal math, idempotency, double-entry, fabricated-claims ban, corridor fence, vendor independence, data sovereignty, provenance, parameter privacy. Enforced by `scripts/lint-security-claims.sh` and `lint-provider-imports.sh`. |
| `daftari` | `AGENTS.md` + `ai-context/architect.md` | **Canonical owner** of the five Absolute Laws (offline-first, money safety, repository isolation, type safety, dependency discipline), the seven non-negotiables, and the release-and-tagging procedure. |

## Principle-to-source map

| Principle | Canonical source | Adopted in SF as |
|---|---|---|
| Never claim a protection you don't provide | Kays Art. I.1 / AfroPay inv. 5 | I.1 |
| Enforcement at the real boundary | Kays Art. I.2 | I.2 |
| Fail closed, never fail open | Kays Art. I.3 / AfroPay inv. 8 | I.3 |
| Proof must exercise the real path | Kays Art. I.4 | I.4 |
| Say no early, loudly | Kays Art. I.5 | I.5 |
| No silent drops | Kays Art. I.6 | I.6 |
| Release + tag every change | Daftari `AGENTS.md` | IV.1 |
| One product, one version | — (SF-derived) | IV.2 |
| Commit provenance footers | AfroPay inv. 9 | IV.3 |
| Shape in VCS, parameters private | AfroPay inv. 10 | IV.4 |
| No fabricated data in code paths | AfroPay inv. 5 | V.1 |
| Docs matching code is a defect | Kays `AGENTS.md` | V.2 |
| Claim requires a demonstrating command | — (SF-derived) | V.3 |
| Honest zero over false representation | AfroPay inv. 5 | V.4 |
| No new dependency without justification | Daftari Law 5 | VI.1 |
| No `any` / unsafe casts | Daftari Law 4 | VI.2 |
| No float on money or quotas | AfroPay inv. 2 | VI.3 |
| Idempotency at the storage boundary | AfroPay inv. 3 | VI.4 |
| One provider abstraction | AfroPay inv. 7 | VI.5 |
| Never weaken a test to pass | Kays `AGENTS.md` §4 | VII.1 |
| Pass count ≠ defect resolved | Kays `AGENTS.md` §9 | VII.2 |
| New test must fail without its fix | — (SF-derived) | VII.3 |
| Gates over prose | — (SF-derived) | VII.4 |
| In-memory state is not a store | AfroPay inv. 1 | **SF currently violates this — NC-1** |
| Offline-first (Daftari only) | Daftari Law 1 | Not applicable to SF; recorded so its absence is a decision, not an oversight |
| Money arithmetic only via `money.ts` | Daftari Law 2 | Not applicable until SF holds money; applies to any future payments adapter (Wave 4) |

## What this index is not

It is not a claim that the four repositories share a codebase. They do not: they run
TypeScript/Supabase, Go/Postgres, Go+Python+Next, and TypeScript+Rust respectively. The
transferable asset across them is the **discipline and the evidence standard**, not code.

## Standing cross-portfolio observations

Recorded 2026-09-29, because a portfolio index that only flatters itself is not an index.

- **Release discipline is the most common failure.** At the time of writing, `kays-wellness-centre`
  and `afropay-network` both have **zero git tags** and both still declare version `1.0.0`
  despite shipped work. Software Factory is currently the only repository in the portfolio
  with a release tag. `scripts/verify-release.sh` exists to make that check mechanical.
- **Two repositories contain claims their own rules forbid.** `afropay-network` hardcodes a
  capital-retention figure that two commits were tuned to reach, which its invariant 5
  prohibits; Software Factory routed `CustomB2B` to the real-estate adapter, which is
  recorded as NC-8. Both are the same failure: a number or a mapping that nobody re-derives.
- **Both paused projects are paused at a credential wall.** `afropay-network` (last commit
  2026-07-18) and `kays-wellness-centre` (last commit 2026-08-30) are blocked on
  owner-held credentials — Safaricom, WhatsApp, live deploy. No amount of engineering removes
  this class of blocker, and it should not be described as an engineering backlog.
