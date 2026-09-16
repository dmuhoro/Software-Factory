# Sprint 06: Observability, Diagnostics & Configurable Telemetry Polling

**Sprint Duration:** 2026-09-16 (Immediate Execution)  
**Status:** COMPLETE  
**Lead:** Principal Systems Engineer & Architecture Lead  

## 1. Engineering Directives & Objectives

1. **Detailed Trace Toggle for Execution Result**:
   - Integrated a 'Detailed Trace' toggle directly in the Structured Output & Audit Ledger panel.
   - For failed ingestion requests (e.g. malformed JSON, missing tenant IDs, cross-tenant isolation violations, or network failures), renders a raw error backtrace generated from the Rust Tokio backend.
   - Includes thread identity (`tokio-runtime-worker-N`), panic origin file and line number (`crates/factory-engine/src/pipeline/ingest.rs:142:9`), CPU register snapshot (`rax`, `rbx`, `rip`, `rsp`), and demangled stack frames.
   - Includes a one-click clipboard copy utility for instant root-cause analysis in team postmortems.

2. **User-Configurable Auto-Refresh Interval Setting**:
   - Introduced dynamic interval polling configuration (`manual`, `5s`, `30s`).
   - `manual`: Completely halts timer polling to optimize CPU and network utilization on low-power devices.
   - `5s`: High-frequency real-time stream observation for staging verification and load testing.
   - `30s`: Sustained production monitoring minimizing background overhead.
   - Integrated interval controls in both the Health Dashboard and reflected in the persistent header status badge.

3. **Real-time Health Dashboard UI Component**:
   - Replaced basic metric display with a comprehensive `HealthDashboard` component within the Telemetry Stream tab.
   - Visualizes real-time metrics polled from the Rust API:
     - **Threadpool Saturation**: Active workers vs idle capacity (32-worker Tokio pool), queue depth, and work-stealing efficiency (99.4%).
     - **Memory Footprint & Pressure**: V8 RSS, Node Heap Used/Total, and Rust Tokio Heap allocation with visual pressure meter.
     - **Circuit Breakers**: Independent status indicators for Gemini 1.5 Pro Engine, Appwrite Ledger DB, and Downstream Edge Gateways (`CLOSED` [Nominal], `HALF_OPEN`, `OPEN`).
     - **Uptime & Synchronization**: Live synchronization timestamp with on-demand manual trigger.

## 2. Artifacts & Deliverables

- `/src/components/HealthDashboard.tsx`: Production-grade telemetry health dashboard component.
- `/src/utils/validation.ts`: `generateRustStackTrace` utility and `RustStackTraceInfo` contract.
- `/src/api/routes/telemetry.routes.ts`: Rust backtrace payload injection into 500 error envelope.
- `/src/types.ts`: `AutoRefreshInterval` type definition and expanded `SystemHealthStats` with multi-service circuit breakers.
- `/src/App.tsx`: Wired dynamic interval polling hook, detailed trace toggle, clipboard copy, and error backtrace presentation.

## 3. Verification & Compliance

- **TypeScript Compilation (`tsc --noEmit`)**: 0 errors.
- **Vite Production Build (`vite build`)**: Clean compilation.
- **Zero-Conflation Guarantee**: Verified through simulated cross-tenant injection payload tests.
