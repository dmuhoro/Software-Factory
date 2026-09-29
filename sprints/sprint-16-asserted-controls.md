# Sprint 16 — Asserted Controls

**Status:** complete · **Release:** 4.8.0-asserted-controls · **Date:** 2026-09-29

Follows `docs/CONSTITUTION.md` and ADR-006…008. Every claim below is backed by a command that
was run. Where something could not be verified here it is listed under *Not verified*, not
described as done.

---

## Why this sprint exists

Sprint 15 closed defects in the code. This sprint found a class of defect one level up: **gates
that report success without proving anything.**

The production image had never been built, and no gate noticed, because building it was never
part of the pipeline. The Kubernetes egress policy allowed the entire internet under a comment
saying it should be replaced, and all 57 manifest checks passed, because the gate asserted that
a policy of *type* `Egress` existed and never read what it permitted. The deployment pinned
`runtime:v3.2.0` while the software was at 4.7.0, and the "image must be pinned" check passed,
because an immutable wrong reference is still an immutable wrong reference.

None of these were lapses of attention. They were gaps in *instrument*. ADR-008 records the
rule that follows: a control that is not asserted is a comment.

---

## Defects closed

### Critical — the artifact that was never built

| Defect | What it actually did | Fix |
|---|---|---|
| Rust runtime image had never been built | CI typechecked and tested code and never built the image the deployment runs; it did not build at all — `rust:1.78-alpine` ships Cargo 1.78, and `Cargo.lock` pins `rand_pcg 0.10.2`, which needs `edition2024` (1.85) | Current toolchain, `Cargo.lock` copied before build, `--locked` on every invocation |
| `\|\| true` in a build step | A failed build reported success having achieved nothing | Removed; asserted statically |
| `x86_64-unknown-linux-musl` hardcoded | Image unbuildable on arm64, including Apple Silicon and Graviton | Same distro family, glibc, no cross-target |
| No `software_factory/.dockerignore` | 2.6GB `target/` sent on every build; most of a 4m24s build | Added, with `Cargo.lock` explicitly not ignored |

### Critical — egress

| Defect | What it actually did | Fix |
|---|---|---|
| `0.0.0.0/0` on 443 | Any pod could reach any host; the comment said to fix it, the gate did not | Base policy denies; deploy-time renderer resolves the two hostnames to `/32` |
| The manifest gate never read the rules | Asserted a policy of type `Egress` existed, so allow-all satisfied it | 58 structural checks, comments stripped before matching |

### Critical — image credential claims

| Defect | What it actually did | Fix |
|---|---|---|
| `verify-image.sh` claimed to walk layer history; it never called `docker history` | `RUN echo "GEMINI_API_KEY=…" > /tmp/leak` + `RUN rm /tmp/leak` leaves a credential in an intermediate layer while the final env looks clean | `assert_history_clean` walks every layer, by name and by live value; image gate 29 → 33 |
| Build tools were production dependencies | `npm ci --omit=dev` installed vite and esbuild natives into the runtime image | Classification asserted against `dist/server.cjs`; Node 119MB → 86.6MB |

### Critical — deployment drift

| Defect | What it actually did | Fix |
|---|---|---|
| `deployment.yaml` pinned `v3.2.0` | Production would run a three-year-old binary; "pinned" passed | Tag must equal the version in `package.json` |
| `ci.yml` had `push: false` and a literal `:latest` | No CI run could publish the tag the manifest referenced | Tag derived from `package.json`; push gated on `secrets.GCR_PUSH` |

### High — supply chain

| Defect | What it actually did | Fix |
|---|---|---|
| `package-lock.json` and `bun.lock` disagreed on 63 of 313 shared packages | CI ran `npm ci`, both images ran `bun install --frozen-lockfile`: the shipped tree was never tested | `bun.lock` deleted, npm canonical (ADR-007) |

### High — governance drift

| Defect | What it actually did | Fix |
|---|---|---|
| 6 of 9 NC resolutions were left in the open table | NC-1/6/7 and NC-3/4/5 were resolved and never moved; a resolution with no commit is not auditable | Every row classified; resolved rows must name a commit or wave |
| The founder playbook instructed `bun install --frozen-lockfile` | Fails with no `bun.lock`; the document whose purpose is the startup procedure did not start the product | Migrated to `npm ci`; `verify-docs.sh` asserts every documented command resolves |

---

## Controls added

| Gate | Checks | Proves |
|---|---|---|
| `scripts/verify-image.sh` | 33 | Both images build, run as uid 10001, refuse to start unconfigured, serve, carry no credential in any layer |
| `software_factory/scripts/verify-k8s.py` | 58 | Manifests structurally, not by grep; deployed image is the current release |
| `scripts/verify-integrations.sh` | 13 | No integration can report a pass it did not earn |
| `scripts/verify-docs.sh` | 6 | Every command a live document names resolves; every NC row is classified |
| `scripts/verify-release.sh` | 11 | Five version sites agree, changelog matches, release is attributable |
| `scripts/kb-mcp-server.mjs --self-test` | 6 attack paths | The context server refuses traversal, `.env`, and the tenant ledger |
| `scripts/generate-dashboard.mjs` | 13 gates + coverage assertion | Status is generated, and names any script it does not run |

---

## Negative controls

Every gate added in this release was observed to fail. Five controls passed when first written
and are recorded here, because a green negative control is as dangerous as a test that never ran:

| Control | Result on first run | Cause |
|---|---|---|
| Drop the Rust lockfile + `--locked` | **passed** | Invisible at runtime; the assertion is static |
| Restore `\|\| true` | **passed** | Build still succeeded |
| Remove `--omit=dev` | **passed** | `NODE_ENV=production` already omitted dev deps; the flag was never the control |
| Ungate Snyk | **passed** | The mutation never applied — shell escaping, not a gate hole |
| Syntax error in a gate | **passed** | Bash swallowed the next statement and printed PASS from a parse error |

Controls that failed correctly on first run: the stale `v3.2.0` tag, the `:latest` float, the
floating egress allowlist, the fork-unsafe integration, `continue-on-error`, missing Snyk
`--fail-on`, missing SonarQube `qualitygate`, CodeRabbit disconnected from the knowledge base,
restored `bun install --frozen-lockfile`, a documented script that does not exist, a
reintroduced `bun.lock`, an orphaned NC row, the echoed-then-deleted credential, and a credential
pasted into a layer with no variable name.

---

## Evidence

| Gate | Result |
|---|---|
| TypeScript typecheck + tests | 102/102 |
| Rust fmt, clippy, tests | 28/28 |
| Layer 1 / 2 / 3 / 4 harnesses | 34/34 · 26/26 · 24/24 · 42/42 |
| Image gate | 33/33 |
| Kubernetes manifests | 58/58 |
| Integration gates | 13/13 |
| Docs gate | 6/6 |
| KB MCP self-test | 33 documents, 6 attack paths refused |
| Release record gate (pre-release) | 11/11 |

---

## Not verified

Stated plainly, because the dashboard is generated and each of these appears there as
unmeasured with an owner.

- **No integration is connected.** CodeRabbit, SonarQube, Snyk and Datadog each need a
  credential absent from this environment; the jobs report skipped.
- **The v4.8.0 image is not in GCR.** `ci.yml` cannot push without `secrets.GCR_PUSH`. The
  manifest now refuses to drift, but publishing the artifact is a credential-blocked step.
- **The egress allowlist is a DNS snapshot.** It resolves real addresses at deploy time. DNS
  answers change, and a NetworkPolicy cannot filter SNI, so the durable control is an egress
  proxy or service mesh.
- **No live Gemini or Appwrite call was made.** Fail-closed startup is verified; the providers
  themselves are not.
- **Nothing is measured in production.** `/metrics` is verified to serve real Prometheus series
  in the image gate; no runner can reach a cluster.
- **Kubernetes evidence is static.** `kubectl` and `kubeconform` are unavailable.
- **NC-2 remains open.** TypeScript persistence is single-writer by design.

---

## Process notes

Two mistakes in this sprint are recorded because both produced a green result that meant
nothing.

**A broken gate was committed.** The first integration commit appended a step to the end of
`.github/workflows/verify.yml`, which holds three separate jobs, so the step landed outside a
job and the YAML stopped parsing. It was committed anyway. Reverted, both workflow files
revalidated as parsing, and the step re-added inside the correct job. A parse check costs one
line.

**A control passed because the mutation never applied,** three separate times, for three
different reasons listed above. Each was caught by confirming the file had actually changed
before believing the control. That check is now part of how a control is run.
