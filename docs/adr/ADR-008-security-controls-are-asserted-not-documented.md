# ADR-008: Security controls are asserted, not documented

- **Status**: Accepted
- **Date**: 2026-09-29
- **Resolves**: the methodology gap behind NC-4 and NC-5
- **Supersedes**: nothing

## Context

NC-4 read: "The Docker image has never been built. Non-root execution and absence of secrets
are verified by inspection only." NC-5 read: "The Kubernetes egress policy permits 443 to
`0.0.0.0/0`." Both had been true through every release, and CI had been green throughout.

Neither was a mistake of attention. Both were mistakes of *instrument*.

The image had never been built because building it was never part of the pipeline — CI ran
typechecks, unit tests and harnesses, and the Dockerfile was a file. When it was finally built,
it failed three times in a row, then the Rust image that the deployment actually runs failed
on a toolchain that could not parse the committed lockfile. Eight defects, none of which any
read of the Dockerfile could have found.

The egress policy was open to the internet under a comment reading "replace with a CIDR
allowlist before production." The comment documented the intention. The gate did not check
it, so the intention was free.

And the gate that did exist — 51 checks, thorough for everything it covered — asserted that
`Egress` appeared in `policyTypes`. That is, that the policy *covered* egress. It never
inspected what the egress rules *permitted*. A policy can cover egress and allow every host
on the internet, and this one did, and every one of the 51 checks passed.

## Decision

**1. A control that is not asserted is a comment.**

This repository's constitution already says it: "Gates that enforce a rule are preferred to
prose that asserts one." It was true and was not applied. The operational form of the rule is
now: any security property named in a comment, a sprint record, or a governance table must
have a check that fails when the property is removed.

**2. A gate must be shown to fail without its fix, and the result is recorded.**

This is the repository's own rule 3 under "Known non-conformances", and it is the only
mechanism that distinguishes a gate from a decoration. Applied to NC-4 and NC-5 it produced
nine recorded negative controls across the two layers.

**3. Where a property cannot be observed at runtime, assert it statically and label it
static.**

Whether a build honours the lockfile is not observable from a running container. The gate
asserts it against the Dockerfile and says so. Dressing a static check up as a runtime
observation would be a false claim about evidence, which is the failure this whole decision
exists to prevent.

**4. Checks read instructions, not prose.**

Every static check in this repository strips comments before matching. A Dockerfile that
documents a defect is doing something right; a grep that cannot tell documentation from
behaviour reports the documentation as the defect, and then looks like it is working. Three
checks in this session fired on their own explanatory comments and were corrected.

**5. Negative controls are themselves controls, and a passing one is a warning.**

A negative control that passes because the mutation never applied looks identical to a gate
with a hole. This happened three times in release 4.8.0 — twice from a shell-escaping mistake
in the mutation, once from an incidental environment default. Each was detected by verifying
the mutation had actually changed the file, and each is recorded in the commit that found it.

**6. Prefer extending the existing gate to adding a second one.**

A second gate over the same files is two things to keep in sync, and one of them will drift.
This repository already had a thorough Python manifest gate; a bash gate was written, found to
duplicate it, and deleted in favour of six added assertions.

## Consequences

The image gate builds both images and inspects the artifacts. The manifest gate parses the
YAML structurally rather than grepping it, so a wildcard in a comment cannot be mistaken for
a rule and a rule written in an unanticipated form is still counted.

`scripts/generate-dashboard.mjs` asserts its own coverage, and a verification script that
does not appear in its table is reported by name. This exists because the dashboard's first
version omitted the Kubernetes gate and printed a clean table while the NC-5 wildcard was
reintroduced.

The cost is real and worth stating: release 4.8.0 added roughly 400 lines of verification
across five gate scripts, and the full local gate run takes several minutes. That is the
correct trade for a service handling tenant data, and it is cheap compared to the alternative,
which is the record of what shipping without it cost.

## Alternatives rejected

**Document the controls and review them by hand.** Rejected: that is what produced NC-4 and
NC-5. A comment about a required CIDR allowlist sat in the repository through every release
alongside the `0.0.0.0/0` it described.

**Assert the lockfile statically and stop there.** Rejected: the build-tooling defect
(esbuild in the runtime image) and the non-root claim were only ever observable at runtime.
Neither substitutes for the other, so both exist and each is labelled for what it proves.
