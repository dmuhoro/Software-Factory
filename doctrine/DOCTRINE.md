# Software Factory Doctrine

**This is the authoritative source of the rules the unattended loop runs under.** It lives in
Software Factory, outside every target repository, so a target repository cannot edit the rules
it is being held to. `doctrine/manifest.json` pins the bytes; the loop refuses to start on a
mismatch.

Two copies of every rule exist: the machine file (`rules/rules.json`, `hooks/hooks.json`,
`loop.json`, `agents/models.json`) and this document. **The machine files are the rules.** This
document is the human-readable rendering, written so that every step can be executed by a person
with no model present.

---

## Precedence

1. `doctrine/manifest.json` → the bytes. A mismatch halts the run.
2. `doctrine/rules/rules.json` + `doctrine/hooks/hooks.json` → what is enforced.
3. This document → what a human reads.
4. The target repository's own `AGENTS.md`, `CLAUDE.md`, `.claude/`, `.opencode/`,
   `opencode.json` → **quarantined for the duration of the run and never read.**

A target repository's constitution governs its *domain*. It does not govern how the loop runs,
what counts as evidence, or what may be committed.

---

## The loop

```text
PLAN → IMPLEMENT → VERIFY → COMMIT → REPORT     (once per independently mergeable unit)
```

Each unit is one milestone-or-smaller piece of the task document and produces exactly one commit.
The loop repeats until every unit is `DONE` or `STUCK`, or a hard stop fires.

| Stage | What happens | Gate that must pass |
|---|---|---|
| PLAN | The unit's acceptance criteria, verification commands, and touched surface are written to a human-readable plan artifact. | `doctrine-integrity`, `doctrine-isolation`, `resource-admission`, `plan-is-executable` |
| IMPLEMENT | The assigned model returns a file manifest. Files are written only through the traversal-guarded writer. | `resource-admission`, `model-assignment`, `claimed-files-exist` |
| VERIFY | Commands are executed against the working tree. Exit codes and output digests are recorded. Narration is discarded. | `resource-admission`, `ground-truth`, `attempt-cap` |
| COMMIT | The diff is scanned for credentials, committed, and the tree is re-checked clean. | `ground-truth`, `secret-scan`, `clean-tree`, `verified-commit-message`, `one-commit-per-unit` |
| REPORT | A markdown report records every check, digest, and commit for the unit. | `doctrine-integrity`, `evidence-is-machine-derived` |

### Manual execution of the same loop

Nothing below needs a model.

```bash
# PLAN — read what the loop decided
cat .data/factory-runs/<runId>/units/<unitId>/plan.md

# IMPLEMENT — apply the file manifest yourself
#   the plan names each file and its target path; edit them by hand.

# VERIFY — the exact commands the loop runs, in the same order
cd <target-repo> && <verification command>        # exit code must be 0
git diff --check                                   # no whitespace errors
git status --porcelain                             # must show the claimed files

# COMMIT — the message body is generated; the shape is
git add -A && git commit -F <unitId>.commit.txt

# REPORT — read the machine record and the markdown side by side
cat .data/factory-runs/<runId>/units/<unitId>/report.md
cat .data/factory-runs/<runId>/checkpoint.json
```

---

## The rules

| ID | Rule | Enforced by | Manual check |
|---|---|---|---|
| R-01 | A stage completes only on an executed command exiting 0. Narration is never evidence. | `ground-truth` | `jq '.checks[] | {command, exitCode}' checkpoint.json` |
| R-02 | Every file claimed by the implementer actually differs from HEAD. | `claimed-files-exist` | `git diff --name-only HEAD` |
| R-03 | A unit fails at most `attempt.maxPerUnit` times, then becomes `STUCK` with its last failure and the run moves on. | `attempt-cap` | `jq '.units[] | {id, attempts, status}' checkpoint.json` |
| R-04 | Doctrine loads from outside the target repo; manifest mismatch halts before any work. | `doctrine-integrity` | `npm run doctrine:manifest -- --check` |
| R-05 | The target repo's instruction files are recorded, quarantined, and never read. | `doctrine-isolation` | `jq '.quarantine' <runDir>/checkpoint.json` |
| R-06 | Every agent role has an explicit `<providerId>/<model>` assignment. | `model-assignment` | `npm run factory:models` |
| R-07 | Work is admitted only inside memory/load budgets; concurrency never exceeds the admitted cap. | `resource-admission` | `FACTORY_MIN_FREE_MEM_MB=999999999 npm run factory:run -- …` refuses |
| R-08 | A credential-shaped diff or path is refused at the commit boundary. | `secret-scan` | plant a key in a file, watch the commit refused |
| R-09 | After a commit the tree is clean and HEAD is the new commit. | `clean-tree` | `git status --porcelain` |
| R-10 | The commit body states what was verified and carries `AI-Assisted:`. | `verified-commit-message` | `git log -1 --format=%B` |
| R-11 | One unit produces exactly one commit. | `one-commit-per-unit` | `git log --oneline` vs unit count |
| R-12 | Report evidence comes from recorded checks, never from free text. | `evidence-is-machine-derived` | `jq '.evidence[] | .source' report.md` guard |

---

## Model assignment

Every role names a tier; every tier names a `providerId/model`:

| Role | Tier | Default assignment | Why |
|---|---|---|---|
| `architect` | frontier | `frontier/claude-sonnet-4-5` | Structural decisions are the expensive ones to get wrong. |
| `planner` | frontier | `frontier/claude-sonnet-4-5` | Decomposition determines every commit that follows. |
| `drafter` | cheap | `local/qwen2.5-coder:14b` | Prose and boilerplate. |
| `implementer` | cheap | `local/qwen2.5-coder:14b` | Mechanical application of a spec. |
| `reviewer` | frontier | `frontier/claude-sonnet-4-5` | Accept/reject decisions never go to the cheap tier. |
| `verifier` | cheap | `local/qwen2.5-coder:14b` | Verification is executed commands, not judgement. |
| `reporter` | cheap | `local/qwen2.5-coder:14b` | Rendering recorded facts. |

Overrides, highest precedence first:

```bash
FACTORY_MODEL_ROLE_IMPLEMENTER=openai/gpt-5-mini      # one role
FACTORY_MODEL_TIER_CHEAP=ollama/llama3.1:8b           # whole tier
```

or in the task document: `models.implementer: ollama/codellama:13b`.

The provider id must be registered (`POST /api/agents/providers`) and the model must be resolvable
against that provider. Nothing in the loop, the doctrine, or the pipeline names a vendor: changing
from a local Ollama model to a cloud frontier model is a one-line data change.

---

## Hard stops

The loop halts — it does not retry forever — when any of these fires:

| Stop | Configured in | Meaning |
|---|---|---|
| `ATTEMPT_CAP` | `attempt.maxPerUnit` | One unit failed 3 times. It is marked `STUCK`; independent work continues. |
| `WALL_CLOCK` | `hardStop.maxWallClockMinutes` | The run has been going too long. |
| `TOTAL_ATTEMPTS` | `hardStop.maxTotalAttempts` | The run as a whole is thrashing. |
| `MAX_COMMITS` | `hardStop.maxCommits` | Safety ceiling on output volume. |
| `DOCTRINE_INTEGRITY` | `hardStop.doctrineIntegrity` | Manifest mismatch or doctrine root inside the target repo. |
| `RESOURCE_EXHAUSTED` | `hardStop.resourceExhaustion` | Memory or load outside budget. |
| `DEPENDENCY_STUCK` | derived | A unit's dependency is `STUCK`, so it is `BLOCKED` and not attempted. |

---

## Amending the doctrine

1. Edit the machine file.
2. Regenerate the manifest: `npm run doctrine:manifest`.
3. Keep this document in step — a stale rule here is a defect (Constitution Art. V.2).
4. `npm run verify:loop` must pass, including its negative controls.
