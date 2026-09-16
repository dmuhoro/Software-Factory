# Appwrite Serverless Function: Multi-Niche Gemini Orchestrator

## Overview
This Appwrite Function acts as the secure, authenticated cloud runtime for multi-tenant B2B telemetry processing. It guarantees:
- Attribute-based security and Tenant ID data isolation
- Google GenAI SDK integration (`@google/genai`) using Gemini 1.5 Pro / 3.8 Flash
- Deterministic structured output validation (`responseSchema` with `@google/genai` `Type` enum)
- Asynchronous database updates with document permissions: `Permission.read(Role.team(tenantId, 'member'))`
- Automatic retry with exponential backoff and jitter
- Immutable audit ledger entry generation for SOC2, HIPAA, and GDPR

## Environment Variables
Configure these in the Appwrite Console under **Functions > Settings > Variables**:
- `GEMINI_API_KEY`: Server-side Google Gemini API Key from Google AI Studio.
- `APPWRITE_API_KEY`: Server API key with `databases.read`, `databases.write` permissions.
- `APPWRITE_DATABASE_ID`: Database identifier (`b2b_software_factory`).

## Deployment via Appwrite CLI
```bash
# Login to Appwrite
appwrite login

# Deploy the function
appwrite functions createDeployment \
  --functionId="gemini-orchestrator" \
  --entrypoint="index.js" \
  --code="." \
  --activate=true
```
