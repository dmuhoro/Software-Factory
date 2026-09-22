# Contributing to Software Factory

Thank you for contributing to Software Factory. This project is a product-manufacturing harness, so a contribution is evaluated not only by whether code works, but by whether it improves the reliability, evidence, safety, or leverage of the complete operating loop.

## Before you start

Read the following in order:

1. [README.md](README.md)
2. [Engineering Constitution](docs/CONSTITUTION.md)
3. Relevant [Architecture Decision Records](docs/adr/)
4. [Harness Engineering Contract](docs/HARNESS_ENGINEERING_CONTRACT.md)
5. [Founder Operating Playbook](docs/FOUNDER_OPERATING_PLAYBOOK.md)

If a change conflicts with the Constitution or an ADR, stop and propose an ADR update before implementing it.

## Development setup

```bash
npm install
cp .env.example .env
npm run verify
npm run dev
```

Do not commit `.env`, durable local data, generated releases, credentials, or customer information.

## Change principles

### Preserve the control contract

Every new capability must have a clear owner, input contract, output contract, failure behavior, and evidence requirement. Irreversible actions must remain behind an explicit approval policy.

### Preserve tenant isolation

Every durable record and API read/write must be tenant-scoped. Never use a global in-memory cache for tenant-specific state. Add a tenant-isolation test for every new persistence path.

### Prefer adapters over hidden coupling

Provider, deployment, model, execution, and storage integrations belong behind explicit ports or services. Domain behavior must not depend on a vendor-specific implementation when an adapter boundary is appropriate.

### Make unfinished work visible

A job must not appear complete if required acceptance criteria, verification, security review, release evidence, or operational handover remains unfinished. Add or update a completion task rather than hiding the gap in a comment.

### Treat failure as data

New failure paths should return the standard error envelope, classify the failure, preserve useful evidence, state the next action, and enforce a bounded retry or escalation policy.

## Testing requirements

Before opening a pull request, run:

```bash
npm run verify
git diff --check
```

Tests should be deterministic and serialized when they touch durable state or environment variables. New services should include unit or integration coverage for:

- Happy path behavior.
- Tenant isolation.
- Invalid input and standard error output.
- Persistence and restart behavior.
- Retry, timeout, and escalation boundaries.
- Approval requirements for irreversible actions.
- Evidence creation and delivery gating.

If a test requires a real external service, provide a deterministic adapter or a clearly marked integration test. Do not make the default verification suite depend on credentials or network availability.

## Documentation requirements

Update documentation when a change modifies:

- A public API.
- A lifecycle state or approval policy.
- A durable record schema.
- A verification profile.
- A deployment or recovery behavior.
- A security boundary.
- A founder operating procedure.

Record meaningful work in the appropriate `sprints/` file and add a concise `CHANGELOG.md` entry for user-visible or architectural changes.

## Pull request checklist

- [ ] The change follows the Constitution and relevant ADRs.
- [ ] Tenant boundaries are explicit and tested.
- [ ] Inputs are validated and errors use the standard envelope.
- [ ] Irreversible actions remain approval-gated.
- [ ] New failure paths are classified and bounded.
- [ ] Required completion tasks and evidence are updated.
- [ ] Tests cover success, failure, and isolation behavior.
- [ ] `npm run verify` passes.
- [ ] `git diff --check` passes.
- [ ] Documentation and changelog are updated.
- [ ] No secrets, customer data, generated build output, or local ledger files are included.

## Commit guidance

Use focused commits that represent one coherent layer. Prefer messages such as:

```text
feat: add project workspace registry
fix: enforce tenant scope on release reads
test: cover rollback health failures
docs: record execution boundary contract
```

Avoid mixing unrelated refactors with behavior changes. A clean commit history is part of the factory's evidence trail.

## Security issues

Do not open a public issue for a suspected vulnerability, credential exposure, tenant-isolation failure, or unsafe execution path. Notify the repository owner privately with reproduction details and impact. Remove secrets from all local logs and preserve only the minimum evidence required for diagnosis.
