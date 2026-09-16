# ADR-004: Rockefeller Hexagonal Architecture & Automated SDLC Knowledge Pipeline

## Status
Accepted

## Context
When AI drastically lowers the cost of writing code, code volume increases exponentially while software architecture becomes the primary differentiator. Without strict architectural discipline, rapid code generation generates unmanageable technical debt and "distributed monolith" failures.

To build an enduring multi-tenant B2B SaaS factory, we adopt the long-game strategy of John D. Rockefeller's Standard Oil trust:
1. **Command the Interfaces, Despise the Commodities**: Core domain models, OpenAPI contracts, and Type definitions are the enduring transport pipelines. Individual code implementations (Node.js, Rust, Python, external SaaS APIs) are replaceable commodity parts.
2. **Modular Monolith First**: Consolidate core domains into a unified modular repository with strict domain boundaries before considering microservices. Refactoring across in-process domain modules takes minutes; distributed service boundaries introduce severe network and cognitive overhead.
3. **Automated AI SDLC Assembly Line**: Ground AI agents using a centralized Knowledge Layer (NotebookLM) containing authoritative architecture, contracts, and guardrails to eliminate hallucination and structural drift.

## Decision
1. **Hexagonal Architecture (Ports and Adapters)**:
   - **Core Domain Logic**: Zero framework dependencies. Domain entities and business rules (e.g. valuation calculations, triage algorithms, route planning) reside in pure TypeScript/Rust without imports of databases, HTTP libraries, or AI SDKs.
   - **Ports (Contracts)**: Inbound and outbound interfaces defined using strict TypeScript interfaces, Zod/Type schemas, or Protocol Buffers.
   - **Adapters (Commodities)**: Swappable infrastructure implementations (Appwrite database adapter, Google Gemini SDK adapter, HTTP REST controllers, message bus connectors).
2. **Knowledge Engine Layer**:
   - Centralize system specifications, regulatory constraints (HIPAA, Fair Housing, DOT), and interface contracts into an authoritative knowledge base.
   - Direct AI generation via strict system instructions and structured output schemas (`responseMimeType: "application/json"`).
3. **Continuous Deployment via Appwrite & GitHub**:
   - Appwrite Serverless Functions link to GitHub repository branches.
   - CI/CD checks execute linting, type verification, and anti-conflation regression tests before triggering automated container deployment.

## Consequences
### Positive
- **Vendor & Technology Agility**: Databases (Appwrite, Cloud SQL, DynamoDB) or AI engines (Gemini 1.5 Pro, 3.8 Flash, local models) can be swapped without touching core business logic.
- **Deterministic AI Generation**: Code written by AI adheres strictly to pre-compiled interface contracts, preventing runtime crashes.
- **Capital Efficiency**: Minimal idle infrastructure cost while scaling horizontally behind Appwrite and Google Cloud Run.

### Negative / Trade-offs
- Requires upfront discipline to maintain clean interface boundaries.
- Developers and AI agents must update interface definitions before modifying adapter implementations.
