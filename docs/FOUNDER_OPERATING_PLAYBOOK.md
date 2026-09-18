# Founder Operating Playbook

Software Factory founder mode is a personal operating system for shortening the path from an idea to a shipped, evidenced outcome. It is intentionally narrow: one operator, one trusted runtime, durable local records, and explicit transitions instead of hidden automation.

## Start the runtime

Create a local environment file from `.env.example`, set a long random `FACTORY_API_KEY` for production-like use, and keep `ALLOW_INSECURE_LOCAL=true` only for loopback development. Run:

```bash
bun install --frozen-lockfile
bun run verify
FACTORY_DATA_DIR=.data ALLOW_INSECURE_LOCAL=true bun run dev
```

The durable ledger lives at `.data/software-factory.json`. Back it up before changing the runtime or moving machines.

## Capture an opportunity

Create one factory job for each opportunity. The job should describe a costly problem, the desired outcome, and observable acceptance criteria.

```bash
curl -X POST http://localhost:3000/api/factory-jobs \
  -H 'content-type: application/json' \
  -H 'x-tenant-id: tenant_re_8841' \
  -d '{
    "tenantId":"tenant_re_8841",
    "title":"Founder inbox triage",
    "problem":"Ideas disappear between notes and delivery.",
    "desiredOutcome":"Every idea becomes a validated next action.",
    "acceptanceCriteria":["A durable brief exists","A test proves the workflow","A delivery link is recorded"]
  }'
```

## Move through the factory

Jobs move through `IDEA`, `SPECIFIED`, `IMPLEMENTING`, `VALIDATING`, and `DELIVERED`. A blocked job may return to specification or implementation. Invalid jumps are rejected. This makes unfinished work visible instead of allowing it to disappear into a dashboard.

```bash
curl -X POST http://localhost:3000/api/factory-jobs/JOB_ID/transition \
  -H 'content-type: application/json' \
  -H 'x-tenant-id: tenant_re_8841' \
  -d '{"tenantId":"tenant_re_8841","status":"SPECIFIED"}'
```

Record evidence as work completes:

```bash
curl -X POST http://localhost:3000/api/factory-jobs/JOB_ID/evidence \
  -H 'content-type: application/json' \
  -H 'x-tenant-id: tenant_re_8841' \
  -d '{"tenantId":"tenant_re_8841","kind":"test","description":"bun run verify passed"}'
```

## The personal leverage loop

At the beginning of a work session, select one job and write the desired outcome before writing code. During implementation, attach commits, preview URLs, design decisions, and test results as evidence. Before delivery, require a green verification run and a concrete artifact or URL. After delivery, record what happened in the real world: adoption, time saved, revenue signal, user feedback, or a reason to retire the idea.

This is the first form of the software factory. It turns founder judgment into a repeatable, inspectable system. Later adapters can automate repository changes, preview environments, deployment, and customer feedback without changing the job contract.

## Safety rules

Never put provider API keys in the browser. Never enable insecure local access on a network-facing deployment. Do not mark a job delivered without evidence. Do not treat simulated metrics as operational truth. Back up `.data` before migrations and test restore before relying on the ledger as the only record.
