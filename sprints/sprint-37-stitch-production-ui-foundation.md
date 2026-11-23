# Sprint 37 — Stitch Production UI Foundation

**Status:** in progress · **Opened:** 2026-11-23 · **First layer:** cockpit truthfulness and design foundation

## Thesis

The Stitch export is valuable as an information-architecture and visual-system reference, but it is not production code. The first implementation layer makes the existing React cockpit more truthful and gives future UI work a local, dependency-free design foundation without replacing the live backend contracts.

## Change

- Added Obsidian Orbit CSS tokens for the operational dark surface, status colors, radius, and motion easing.
- Added keyboard-visible focus styling, reduced-motion behavior, native control inheritance, and a minimum mobile canvas width.
- Added a visible health-unavailable banner. The dashboard now tells the operator when `/api/factory/health` cannot be reached and explicitly says that only the last known state is displayed.
- Replaced stale client metadata (`3.2.0`) with the server-reported application version.
- Removed a hardcoded model name from historical audit reconstruction.
- Removed the header’s unsupported “Zero Conflation: Enforced” success claim and replaced it with the narrower “Tenant isolation: API-gated” label.
- Added a production Stitch prompt at `docs/STITCH_PRODUCTION_UI_PROMPT.md`.

## Evidence

- `npm run lint` — pass.
- `npm run build` — pass; the pre-existing esbuild CommonJS `import.meta` warning remains and is unrelated to this layer.
- `git diff --check` — pass.

## Readiness boundary

This layer does not claim that the full UI is complete or that the product is ready for unsupervised autonomy. The next layers are: component extraction from `App.tsx`, typed API adapters for readiness/metrics, durable execution-history reads where available, browser verification of health/tenant/telemetry/error flows, and landing-page separation. Stitch output remains subject to contract reconciliation before it can be merged.
