# Sprint 09: Controlled Repository-to-Delivery Loop

## Objective

Extend the durable founder job system into a governed product delivery pipeline that connects product intent to verified repository output without granting unrestricted production authority to automation.

## Completed

The factory job now stores a product brief containing the problem, audience, value hypothesis, wedge, non-goals, and acceptance criteria. It generates a deterministic implementation plan with contract, implementation, verification, and delivery stages.

The repository adapter accepts only a repository inside the configured workspace root. It records the base commit, creates or switches to a factory branch, writes only explicitly supplied files, and records the changed paths. The verification adapter runs the repository's declared `npm run verify` command with a bounded timeout and captures pass/fail evidence. The preview adapter copies verified `dist` output into a durable preview directory. Every artifact and transition is attached to the tenant-scoped factory job and audited.

The API exposes the complete path through `/api/factory-jobs/:id/brief`, `/plan`, `/repository`, `/modify`, `/verify`, `/preview`, `/transition`, and `/evidence`.

## Verification evidence

`npm run verify` passes with four tests. The delivery-loop integration test creates a temporary Git repository, creates a branch, modifies a file, executes verification, creates a preview, and records preview evidence. TypeScript linting, the frontend/server build, and the existing durability and tenant-isolation tests also pass.

## Boundaries

The repository modifier is intentionally explicit-file based. It does not grant an AI agent arbitrary shell access, production credentials, deployment authority, or permission to modify repositories outside the approved workspace. The preview is a filesystem artifact; serving it publicly is a separate deployment adapter. AI-generated briefs and plans can be added later behind structured-output and human-approval ports.
