# Vendored skills — provenance and review

This directory holds skills the factory may be *shown*. A skill here is not fetched at run time: it is
committed, pinned by sha256 in `../skills-lock.json`, and refused unless the bytes on disk are the bytes
reviewed (ADR-013 §2/§3). Skills are advisory and default **OFF** (`doctrine/loop.json` → `skills.inject`).

Regenerate with `npx tsx scripts/vendor-skill.ts`; verify the pins with
`npx tsx scripts/vendor-skill.ts --check` (no network).

## Review rule

Every vendored file was read in full and asked one question: **does it tell the agent to run network
calls, edit config, skip approval, or loop indefinitely?** A "yes" excludes it. Network means *external
egress* — a local dev server and a local replay are not egress. The regex the injection seam refuses with
(ADR-013 §6) is `\b(?:https?|wss?|ftp)://`.

## Vendored (source: `mattpocock/skills`, MIT, commit `49dd158d1076134a641b33efb035946536778336`)

Each entry: network / config-edit / skip-approval / unbounded-loop.

| Skill | Reviewed verdict | Notes |
|---|---|---|
| `tdd` | no / no / no / no | Inlines its referenced `tests.md` and `mocking.md` (URL-free). Coaching prose only. |
| `diagnosing-bugs` | no / no / no / no | Build-feedback-loop discipline. Its loop menu names a *local* dev server and a captured-trace replay (localhost, not egress); its `scripts/` are stripped. Required by WP-3's advisory block. |
| `to-spec` | no / no / no / no | Turns a conversation into a spec. No egress. |
| `to-tickets` | no / no / no / no | Splits a spec into tickets. May *fetch* a user-supplied reference when one is passed, but the drafter is passed none and the body names no endpoint. |
| `code-review` | no / no / no / no | Local diff review against the repo's own standards. |
| `improve-codebase-architecture` | no / no / no / no | Its referenced `HTML-REPORT.md` names CDN endpoints (tailwindcss, jsdelivr) and was **omitted**, not copied; the skill ships its prose only. |
| `grilling` | no / no / no / no | Asks one question at a time to sharpen a plan. No egress. |
| `handoff` | no / no / no / no | Writes a temporary summary document. No egress. |

## Excluded (named, with the reason)

Source `davidondrej/skills`, MIT, commit `5083f54980ca1bbaa6d31bdac6c526d54910fe61`:

| Skill | Excluded because |
|---|---|
| `total-review` | Instructs "full permission mode … bypass permissions … YOLO mode (no approvals)" — **skips approval**. |
| `global-agent-guardrails` | Instructs editing the agent's own config, settings and hooks — **edits config**. |
| `risky-changes` | Instructs "use available research tools" and to "run 10–20+ realistic cases against the real endpoint or provider" — **network egress**. |

Source `mattpocock/skills`: `research` — **research-and-web**, excluded by the sprint's hard limit.
Source `davidondrej/skills`: `research-and-web`, `goal-loop` — the first is **research-and-web**; the second
"auto-continues instead of waiting for input" (**loops indefinitely**), which conflicts with the bounded
loop that governs this repository.

**Finding:** the brief's Ondrej starter set (`total-review`, `risky-changes`, `global-agent-guardrails`)
is excluded *in full* by the brief's own exclusion rule. No Ondrej skill is vendored.

## Licences

`pocock-skills-LICENSE` is the upstream MIT licence, copied verbatim. No `LICENSE` file exists in
`skills/` for the opencode tooling pins; those carry their licence in the lock.
