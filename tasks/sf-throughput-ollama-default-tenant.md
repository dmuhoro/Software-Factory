# Task: Register the local Ollama provider for the tenant the loop actually uses

## Goal
The unattended loop CLI defaults to tenant `default` (`executionLoopService.ts` resolves
`options.tenantId ?? 'default'`, line 197), and model providers are looked up by the exact key
`"<tenantId>:<id>"` (`FrontierModelService.get`, line 59). But the startup seed
`scripts/seed-local-ollama.ts` and the pilot launcher `scripts/run-pilot.ts` both register the
local Ollama provider under tenant `''` (platform operator). On a fresh durable store a
`factory:run` without `--tenant` therefore fails with `MODEL_PROVIDER_NOT_REGISTERED` because the
lookup asks for `default:local-ollama`, which does not exist. Register the provider for the
tenant the loop actually uses, alongside the existing platform-operator registration.

## Constraints
- Add a second registration that targets tenant `default` with the same local Ollama settings (`kind: 'local'`, baseUrl `http://127.0.0.1:11434/v1`, modelIds `['qwen2.5-coder:3b', 'gpt-oss:20b-cloud']`, timeoutMs 300_000).
- Keep the existing tenant `''` registration in both scripts unchanged; the platform operator is a separate, documented tenant.
- Reuse `FrontierModelService.register` exactly as the existing call does; do not introduce a new helper or dependency.

## Models
models.implementer: local-ollama/gpt-oss:20b-cloud
models.reviewer: local-ollama/gpt-oss:20b-cloud

## Verification
npm run lint

## Milestones
### M1: seed-local-ollama registers the default tenant
type: fix
verify: grep -q "tenantId: 'default'" scripts/seed-local-ollama.ts && grep -q "seedLocalOllama" scripts/seed-local-ollama.ts && npm run lint
- [ ] `seedLocalOllama` has a second `register` call whose `tenantId` is `'default'` (in addition to the existing `''` registration)
  - check: grep -q "tenantId: 'default'" scripts/seed-local-ollama.ts
- [ ] the script still compiles clean under the project typecheck
  - check: npm run lint

### M2: run-pilot registers the default tenant
type: fix
depends: M1
verify: grep -q "tenantId: 'default'" scripts/run-pilot.ts && grep -q "tenantId: ''" scripts/run-pilot.ts && npm run lint
- [ ] `run-pilot.ts` has a second `register` call whose `tenantId` is `'default'` (in addition to the existing `''` registration)
  - check: grep -q "tenantId: 'default'" scripts/run-pilot.ts
- [ ] the existing platform-operator registration is preserved
  - check: grep -q "tenantId: ''" scripts/run-pilot.ts
- [ ] the script still compiles clean under the project typecheck
  - check: npm run lint