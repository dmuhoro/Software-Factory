# ADR-013: Skills are advisory, vendored, and hash-pinned

- **Status**: Proposed (Sprint 31, WP-0 — implemented as the skills bridge in WP-6)
- **Date**: 2026-10-15
- **Resolves**: what an adopted external skill is allowed to be, and how it may influence a run
  without relaxing a gate (Sprint 30 built the registry; it never decided the trust stance)
- **Supersedes**: nothing (narrows the intent of ADR-006; see the tension below)
- **Implementation**: `src/services/skillRegistryService.ts` (existing parser), a provenance lock
  (`skills-lock.json`, extended), `DoctrineService` role wiring, and a pin check on load

## Context

Sprint 30 added a declarative skills registry: a strict parser for `SKILL.md`-style files loaded from a
governed directory (`skillRegistryService.ts`; default `<cwd>/skills`, override `FACTORY_SKILLS_DIR`),
with unknown fields refused by code. One skill ships (`skills/repo-hygiene.skill.md`). The registry is
**display-only**: its single consumer is `GET /api/factory/skills` (`factory.routes.ts:81`), and nothing
in the loop reads a skill.

The ecosystem question this ADR answers is what happens when the factory adopts **external** skill
content — for example the Pocock set (`grill-me`, `to-prd`, `to-issues`, `tdd`, `diagnose`, `handoff`,
`improve-codebase-architecture`) or the Ondrej set (`agent-orchestration`, `ops-and-setup`). Three
hazards make "just drop the files in" unacceptable:

1. **Prompt injection.** A skill body is text that reaches a model. Adopted from a third party, it is
   untrusted content that could instruct a run to skip verification or narrate success. The doctrine
   already quarantines a *target repository's* instruction files for this reason
   (`doctrineIsolationService.ts`; the dead guard `TARGET_DOCTRINE_LEAKED_INTO_RUN` at `apiError.ts:276`
   was built for the same class); a skill must not be a new, unquarantined door for it.
2. **Supply chain.** A skill vendored without a pin can change silently between the review and the run,
   or drift from what was reviewed. The repository already holds this stance for its own doctrine
   (`doctrine/manifest.json`, sha256 per file) and for its installed skills (`skills-lock.json`).
3. **Gate erosion.** A skill is guidance. If a skill could alter a rule, a hook, a model assignment, or
   a gate's verdict, it would be a way to change the factory's behaviour without a code review —
   exactly the coupling the Constitution's governance order forbids.

There is a tension with ADR-006 (repository-as-knowledge-base over MCP): that ADR lets the factory
*read* a target repository's context. Reading is not obeying. ADR-013 keeps reading and refuses
obedience: adopted skills are content the loop may be **shown**, never instructions it must follow.

## Decision

**1. Skills are advisory.** A skill shapes guidance a role may be given. It cannot relax, bypass,
reorder, or replace a rule, a hook, a model assignment, a gate, or a doctrine verdict. No code path may
treat a skill's text as authority; the doctrines in `doctrine/` remain the only authority.

**2. Skills are vendored.** A skill lives in this repository (`skills/`), committed, not fetched at run
time. No live pull from an external repository or URL. Vendoring is a reviewed commit, so the exact
bytes that will run are the bytes that were reviewed.

**3. Skills are hash-pinned.** Each skill records its provenance — source, source commit, licence, and
sha256 — in a lock (`skills-lock.json`, extended with the fields the existing entries carry plus a
licence). On load, a skill whose bytes do not match its pin is **refused with a code**, and the refusal
is reported beside the installed set, never silently dropped (the stance WP-2 already set for a
malformed skill).

**4. Wiring is declared in doctrine, default OFF.** Which role or stage may be shown which skill is
declared in the manifest-pinned doctrine, behind a flag that defaults **off**. OFF must be a provable
no-op: zero prompt change, assertable, as ADR-012 §6 requires for learning injection.

**5. Skill content is fenced and never executed.** A skill body that reaches a prompt is delimited and
labelled as untrusted reference text. It is never run as a command, never interpolated into a path or a
shell invocation, and never allowed to name an egress endpoint. Any skill attempting to do so is a
refusal, not a capability.

**6. No new egress.** A skill may not introduce a network dependency of its own. Skills that name a
third-party inference gateway (the reason the Ondrej `research-and-web` set is excluded) are out of
scope: they would bypass the single egress door (ADR-011).

**7. Adoption is a decision from data.** A skill is adopted into the run path only after Sprint 31 WP-7
shows it moving a measured number (first-attempt rate, STUCK rate, wall time, or cost per verified
commit). Preference is not evidence.

## Consequences

- WP-6 (Sprint 31) implements the vendored, pinned bridge and the default-OFF role wiring, and flips
  this ADR's status to **Accepted** in the same change (Constitution Scope rule 2).
- The existing `skills-lock.json` (currently the `appwrite/skills` tooling entries) gains provenance and
  licence fields; the loader refuses a file with no pin or a mismatched pin.
- Definition of done for WP-6: an unpinned skill refuses; a modified skill refuses; a pin-off run is a
  byte-identical prompt; a skill cannot alter a gate verdict; the loop reads a skill only when the flag
  is on and the role is declared.
- The registry stays a read surface for inspection (`GET /api/factory/skills`) regardless of whether
  wiring is on; inspection and influence are separate switches.

## Alternatives rejected

**Fetch skills at run time from the source repository.** Rejected. Unpinned, unreviewable, and a live
egress path outside the one door (ADR-011).

**Let a skill override a rule or a gate.** Rejected outright. It would make behaviour changeable without
a code review and give an untrusted file the factory's authority.

**Trust a skill because its source is reputable.** Rejected. Reputation is not a pin; the same file can
change after review. The manifest and lock exist because trust is a hash, not a name.

**Wire all adopted skills on by default.** Rejected. It would change runs before any measurement, and it
violates the "OFF is a provable no-op" discipline ADR-012 set.
