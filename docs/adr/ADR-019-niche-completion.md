# ADR-019: Niche completion — custom_b2b control set + financial_services vertical

## Status

Accepted.

## Context

`custom_b2b` was modelled in the registry but had no implemented adapter. The
previous TypeScript path returned `isCompliant: true` without evaluating any
control — a fabricated audit result. Sprint 34 WP-7 refused to approximate it.

## Decision

`custom_b2b` is now served by its own adapter, which evaluates the tenant's
declared control set (`TenantProfile.customGuardrails`):

- No control set provisioned → refused with `NICHE_NOT_SERVED`, never approximated.
- An undeclared or unevaluable guardrail → fails closed (`isCompliant: false`).
- Declared guardrails (SOC2 trust service criteria, ISO 27001 access boundary,
  data classification, encryption at rest, change management, incident response)
  are evaluated against the payload and a real `isCompliant` verdict returned.

A new `financial_services` vertical is added with PCI DSS card-data boundary,
AML structuring detection, counterparty sanctions screening, and high-value
transaction review. Both niches are marked `operational: true` in
`NICHE_REGISTRY`.

`IndustryNiche.EDUCATION` is also added with FERPA (student directory consent),
COPPA (under-13 parental consent), and accreditation standards compliance.

All new niches carry validation rules in `src/utils/validation.ts` and response
schemas in `src/models/geminiSchema.ts`, exposed via `GET /api/schemas/gemini`.

## Consequences

- Positive: every modelled niche now has an implemented adapter that evaluates
  real controls and publishes a real verdict; none fabricates compliance.
- Negative: `custom_b2b` tenants must provision their control set before the
  adapter will serve them; an unprovisioned tenant gets an honest refusal, not a
  plausible-looking pass.
- Recovery: a niche that is added to the enum but not to the adapter switch hits
  the `default` branch and refuses with `NICHE_NOT_SERVED`.

## Related

- `src/services/nicheAdapterService.ts` — the adapters
- `src/configurations/factory.config.ts` — `NICHE_REGISTRY`, `OPERATIONAL_NICHES`
- `src/models/tenant.ts` — `IndustryNiche.EDUCATION`
- `src/models/geminiSchema.ts` — response schemas
- `src/utils/validation.ts` — per-niche field rules
- `src/api/routes/schemas.routes.ts` — schema exposure
- Sprint 34, WP-7 (P1 Niches)
