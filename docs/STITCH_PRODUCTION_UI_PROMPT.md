# Stitch prompt: production UI implementation for Software Factory

Paste the following prompt into Google Stitch when requesting the next UI iteration:

```text
You are designing and implementing production UI/UX for Software Factory, an evidence-first product-manufacturing harness. Do not return a static HTML mockup, a screenshot-only concept, or simulated dashboard behavior.

The target stack is:
- React + TypeScript + Vite
- Existing utility-class styling with Tailwind-compatible classes
- lucide-react icons
- No CDN dependencies
- No inline JavaScript event handlers
- No hardcoded runtime success, health, tenant, latency, version, audit, or model values
- No fabricated claims such as “Production Ready”, “0 Faults”, “100% Deterministic”, or “Zero Conflation” unless the value is explicitly supplied by an API response

Product surface:
1. Authenticated operational control plane for a founder/operator.
2. Separate public landing/conversion page. Do not merge the marketing surface into the authenticated console.

Visual direction: Obsidian Orbit
- Deep dark operational canvas
- Indigo primary action
- Emerald healthy/live state
- Amber warning/degraded state
- Red blocked/error state
- Geist-like UI typography and monospace typography for identifiers, logs, hashes, payloads, and timestamps
- Dense but readable 12-column cockpit layout
- Responsive behavior: three columns on desktop, stacked sections on mobile
- Visible keyboard focus, semantic HTML, accessible labels, reduced-motion support

The live cockpit must include reusable React components for:
- Runtime health and readiness
- Last-known-state and unavailable/degraded banners
- Tenant selector with explicit active tenant context
- Execution log list and selected execution detail
- Telemetry ingestion workbench
- JSON payload editor with valid, invalid, empty, loading, and server-rejected states
- Structured output and audit ledger
- Circuit-breaker / fail-closed status
- Export controls that are disabled when no evidence exists
- Empty, loading, error, retry, and permission-denied states

Backend contract:
- Preserve the existing Software Factory API contracts. Do not invent new endpoints in the UI.
- Existing live paths include:
  GET /api/factory/health
  GET /api/factory/ready
  GET /api/factory/metrics
  POST /api/telemetry/ingest
- The frontend must treat server responses as authoritative.
- Every displayed value must identify its source in code or be clearly labelled as local UI state.
- If an API field is missing, render “Unavailable” or “Not reported”; never substitute a realistic-looking fake value.
- Keep tenantId in request headers and payloads aligned. Never silently switch tenant context.
- Preserve fail-closed behavior: malformed payload and cross-tenant requests must show the actual server error envelope and must not be presented as successful demo actions.

Required deliverables:
1. A component map with filenames and responsibilities.
2. TypeScript interfaces for the API response shapes used by each component.
3. React components, not standalone HTML.
4. Loading, empty, error, degraded, retry, and success states for every network-backed panel.
5. A small client adapter or typed request helper only if it matches the existing repository conventions.
6. Unit/component test cases for:
   - health success and unavailable states
   - tenant switching
   - valid and invalid JSON
   - successful telemetry dispatch
   - malformed input rejection
   - cross-tenant rejection
   - empty execution history
   - export disabled with no evidence
7. Accessibility notes: keyboard order, labels, focus behavior, table semantics, status announcements.
8. Responsive notes for widths below 1024px and below 640px.
9. A list of every claim that must be populated from an API response rather than hardcoded.
10. A migration note explaining how the components can be integrated into the existing Software Factory React app without replacing its backend.

Do not add fake API responses, fake timers, fake audit hashes, fake tenant records, fake model names, or simulated “success” toasts. If you need fixtures for component tests, isolate them in test-only files and label them as fixtures.

Return code in framework-native files with imports, props, types, and tests. Make the code compile under strict TypeScript. Prefer small composable components over one giant page component.
```

## Integration rule

Stitch output is accepted only as a frontend proposal. Before merging it into Software Factory, reconcile every component with the actual response shape and preserve the existing API and safety boundaries. The backend, durable ledger, and verification suite remain authoritative.
