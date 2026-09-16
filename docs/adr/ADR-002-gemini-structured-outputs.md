# ADR-002: Gemini Structured Output Schema Enforcement via @google/genai

## Status
Accepted

## Context
Automated cloud runners consuming AI outputs require deterministic JSON payloads without markdown wrapping, arbitrary field renames, or missing attributes.

## Decision
1. **SDK**: Standardize on the official `@google/genai` TypeScript SDK.
2. **Schema Engine**: Enforce `responseMimeType: "application/json"` with `responseSchema` utilizing the SDK's `Type` enum (`Type.OBJECT`, `Type.ARRAY`, `Type.STRING`, `Type.NUMBER`, `Type.BOOLEAN`).
3. **Domain Schemas**: Define dedicated static schemas for each industry vertical (`REAL_ESTATE_RESPONSE_SCHEMA`, `HEALTHCARE_RESPONSE_SCHEMA`, `LOGISTICS_RESPONSE_SCHEMA`).
4. **Resilience**: Wrap inference in a 3-state Circuit Breaker with exponential retry backoff and jitter to mitigate 429 rate limits.

## Consequences
- Positive: Model output is mathematically guaranteed to adhere to JSON Schema, preventing downstream parser crashes.
- Mitigations: Low temperature (0.1) minimizes creative variation in structured field outputs.
