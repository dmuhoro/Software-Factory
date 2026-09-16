# NotebookLM Knowledge Engine & AI Labor Grounding Specification

## 1. Executive Concept
The **Software Factory Knowledge Layer** transforms unstructured architectural insights and system specifications into a grounded, deterministic intelligence asset using Google NotebookLM.

Instead of generic model prompting, AI agents in the development pipeline are constrained by a curated repository of authoritative documents:
1. **The System Blueprint**: Core business domain rules, tenant isolation policies, and state transition matrices.
2. **The Assembly Line Methodology**: Video transcript and pedagogical guidelines from the *Software Factory* operational curriculum.
3. **Interface Contracts**: Strict TypeScript definitions, OpenAPI schemas, and `@google/genai` `Type` enum structures.
4. **Guardrail Guidelines**: Regulatory compliance requirements (HIPAA 18 Safe Harbor, Fair Housing Act / RESPA, DOT ELD / IATA hazardous cargo).

---

## 2. The 3-Tier Assembly Line Loop

```
┌─────────────────────────────────────────────────────────────┐
│                 Tier 1: Knowledge Engine                    │
│   (NotebookLM: Blueprints, Transcripts, Contracts, Rules)   │
└──────────────────────────────┬──────────────────────────────┘
                               │ Grounded Context Extraction
┌──────────────────────────────▼──────────────────────────────┐
│           Tier 2: AI Studio Execution Engine                │
│    (Gemini 1.5 Pro / 3.8 Flash + Strict JSON Schemas)       │
└──────────────────────────────┬──────────────────────────────┘
                               │ Validated Code & Telemetry
┌──────────────────────────────▼──────────────────────────────┐
│              Tier 3: Multi-Tenant Infrastructure           │
│    (Appwrite Partitioned DB + GitHub CI/CD + Cloud Run)     │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Operational Protocols for AI Labor
1. **Contract-First Scaffolding**: Prior to writing implementation logic, AI models must inspect or output the interface contract (TypeScript interface or Rust trait).
2. **Zero Assumptions on Niche**: Tenant niche parameters must be provided via the envelope context. Models are prohibited from guessing vertical industry rules.
3. **Deterministic Output Enforcement**: All automated system transformations must be generated with `responseMimeType: "application/json"` and validated against the niche's schema.
4. **Error Resilience Protocol**: Incomplete or contradictory specifications must yield a standardized `MALFORMED_CONTEXT` error envelope rather than hallucinatory fallback logic.
