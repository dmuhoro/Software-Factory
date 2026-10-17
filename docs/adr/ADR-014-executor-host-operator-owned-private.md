# ADR-014: The executor runs on an operator-owned Linux host, privately

- **Status**: Accepted (Sprint 31, WP-4 — the provisioning script, hardened unit and `verify:host`
  preflight are implemented and proven repo-side; the host/tailnet/deploy-key provisioning and the
  reboot-mid-run drill on a real host are operator-owned and named in the sprint record, not claimed)
- **Date**: 2026-10-15
- **Resolves**: where the unattended loop runs and who can reach it, so it can be driven from a phone
  without exposing a public service
- **Supersedes**: nothing (works with ADR-009 storage selection and ADR-010 isolated execution)
- **Implementation**: `deploy/host/provision-executor-host.sh` (provisioning),
  `deploy/host/software-factory-executor.service` (hardened unit), `scripts/verify-host.ts`
  (`npm run verify:host`), the `FACTORY_BIND_HOST` setting in `runtimeConfig`, and the existing
  single-writer ledger (NC-2). The die-and-resume drill is `test/loop-die-resume.test.ts`.

## Context

The goal this ADR serves is concrete: run the factory on a cloud server, from a phone, and have it work
on real codebases unattended. Today the deployable is a single container (`Dockerfile`, `railway.json`,
`numReplicas: 1`) with a fail-closed startup (`server.ts` exits 78 before binding). Two facts constrain
any host design:

- **The ledger is single-writer (NC-2).** It is a durable record rewritten whole on each change; a
  second concurrent writer silently drops the other's records. This is why `railway.json` declares one
  replica. The phone does not change this: there is exactly one writer, on one host.
- **Execution must be sandboxed, or it must refuse (ADR-010).** Sandboxed runs go through the
  factory's `runCommand` boundary (`bubblewrap`; `test/loop-sandbox.test.ts`). The shipped image
  installs no `bubblewrap`, so sandboxed execution **fails closed** there. A host that cannot sandbox
  cannot run the loop.

A public API on the open internet would put a service that executes code and reads a durable ledger
directly reachable, and would make the secret boundary (the operator's model credentials) a network
boundary. The safer shape is a host the operator owns, reachable only over a private network the
operator already has (Tailscale).

## Decision

**1. One executor host per operator.** The loop runs on a single operator-owned Linux host, with the
durable ledger as its single writer (NC-2). This ADR makes no horizontal-scale claim; a second writer
is a correctness bug, not a capacity upgrade.

**2. A dedicated unprivileged runner user.** The loop runs as a non-root `runner` account that owns the
workspace and nothing else. It has no `sudo`, no login shell beyond what the unit needs, and cannot
read the operator's credentials.

**3. Secrets are unreadable by the runner.** Model and platform credentials live server-side only, in a
file readable by the operator (mode `600`) or a `systemd` credential, loaded into the service's
environment and never written to the repository. The runner cannot read them; only the process that was
granted them can. No secret is ever committed, logged, or placed in a run artifact.

**4. The API binds to localhost and the tailnet only.** No public ingress, no published port. The
operator reaches the surface from the phone over the tailnet (Tailscale). The existing public paths
(`/health`, `/ready`, `/metrics`, `/factory/health`) remain the only unauthenticated routes, and they
serve over the private bind, not the open internet.

**5. `bubblewrap` is required; absence is a refusal, not a downgrade.** A host without `bubblewrap` (or
without user namespaces) fails the host preflight loudly and refuses to run sandboxed work. There is no
"run unsandboxed because the sandbox is missing" path (ADR-010).

**6. The service is a hardened `systemd` unit.** `Restart=on-failure`, plus `NoNewPrivileges=yes`,
`ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`, and a writable path only for the ledger.
A reboot must not corrupt a run.

**7. Resume is idempotent across reboot.** The die-and-resume path (`--resume`) yields no duplicate
commits and leaves a clean tree after a host reboot mid-run. "Cloud-ready" is not claimed until this
drill passes on a real host.

**8. Operator-blocked provisioning is named, not stubbed.** The host, the tailnet, and the scoped
deploy keys are operator actions. WP-4 supplies the script and the preflight; it does not pretend to
provision what it cannot.

## Consequences

- WP-4 (Sprint 31) implements the provisioning script, the `systemd` unit, and `verify:host`, and flips
  this ADR's status to **Accepted** (Constitution Scope rule 2). The host, the tailnet and the scoped
  deploy keys remain operator actions (§8); the ADR is Accepted for the decisions that are enforceable
  in this repository, not as a claim that a specific host has been drilled.
- The phone surface (WP-5) depends on this ADR: it assumes a private bind, not a public one. Notifications
  leave through the single egress door (ADR-011), not through an inbound webhook the host would have to
  expose.
- Definition of done for WP-4, split by owner:
  - **repo-side, proven**: `verify:host` refuses a host whose bind is public, whose runner can sudo, whose
    credential file is not mode 600 root, whose unit is missing, or whose bubblewrap cannot create a
    container; the `FACTORY_BIND_HOST` policy is asserted in `test/executor-host-bind.test.ts`; the
    die-and-resume drill (no duplicate commits, clean tree) is `test/loop-die-resume.test.ts`.
  - **operator-side, named not claimed**: the reboot-mid-run drill on the real host, and the
    tailnet-unreachability check from a non-tailnet address, are performed by the operator on the host
    the provisioning script prepares. They are recorded in the sprint file with their owner, not stubbed.
- The shipped container image remains a separate concern; `bubblewrap`-in-image is a named operator
  decision (ADR-010), not silently worked around here.

## Alternatives rejected

**Expose the API publicly with authentication only.** Rejected. It makes a code-executing service
reachable from the open internet and turns a credential file into a network boundary. A private bind
removes the attack surface rather than guarding it.

**Run as root for simplicity.** Rejected. The runner needs a workspace, not the host; least privilege is
the point. Root would let a compromised run own the box and read every secret.

**Keep secrets in the runner's environment.** Rejected. The process that runs untrusted target-repo code
must not hold the operator's credentials. Secrets are granted to the service, unreadable by the runner.

**Scale to multiple replicas behind a load balancer.** Rejected. The ledger is single-writer (NC-2); a
second writer silently loses records. Scaling the ledger is a parked, separate decision.

**Run unsandboxed when `bubblewrap` is absent, to keep work moving.** Rejected. It fails open on the
exact boundary ADR-010 exists to protect. Absence is a refusal.
