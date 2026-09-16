# Gemini 1.5 Pro Structured Output Protocol Specification

## 1. Architectural Overview
Downstream microservices and serverless runners require deterministic JSON responses from Google Gemini. Free-form markdown outputs, backtick wrappers, or missing property keys can cause silent parsing failures.

This specification leverages Google GenAI's official `@google/genai` TypeScript SDK with `responseMimeType: "application/json"` and `responseSchema` configured using the SDK's `Type` enum (`Type.OBJECT`, `Type.ARRAY`, `Type.STRING`, `Type.NUMBER`, `Type.BOOLEAN`).

---

## 2. Universal Envelope Schema Requirements
Regardless of industry niche, every AI transformation response guarantees the following top-level properties:

| Field | Type | Constraint | Description |
| :--- | :--- | :--- | :--- |
| `status` | `string` | `"success"` \| `"flagged"` \| `"quarantined"` | Macro execution status |
| `confidenceScore` | `number` | Float `0.0` to `1.0` | Algorithmic confidence score |
| `nicheSpecificResult` | `object` | Schema-specific | Validated vertical payload (see below) |
| `recommendedActions` | `array<string>` | Minimum 1 item | Actionable operator directives |
| `anomaliesDetected` | `array<string>` | Array (can be empty) | Flagged telemetry outliers |
| `complianceVerified` | `boolean` | `true` \| `false` | Regulatory guardrail verification flag |

---

## 3. Niche-Specific Response Schemas

### 3.1 Real Estate & PropTech (`real_estate`)
- **Use Case**: Property automated valuation, lead quality qualification, RESPA & Fair Housing verification.
- **Strict Properties**:
  - `propertyId` (`string`, required): Canonical listing/property ID.
  - `estimatedValuationUsd` (`number`, required): Non-negative float.
  - `valuationRange` (`object`, required):
    - `low` (`number`, required): Lower bound valuation.
    - `high` (`number`, required): Upper bound valuation.
  - `marketTrend` (`string`, required): Enum constraint: `"BULLISH"` | `"BEARISH"` | `"NEUTRAL"`.
  - `leadQualityScore` (`number`, required): Integer `0` to `100`.
  - `riskFactors` (`array<string>`, required): List of property/neighborhood liabilities.
  - `taxAssessmentFlag` (`boolean`, required): Indicator of anomalous municipal tax appraisal.

### 3.2 Healthcare & Clinical Triage (`healthcare`)
- **Use Case**: Emergency triage prioritization, vital sign anomaly detection, HIPAA 18 Safe Harbor compliance.
- **Strict Properties**:
  - `patientCohortId` (`string`, required): Synthetic cohort reference (Direct PHI strictly prohibited).
  - `triageUrgencyScore` (`number`, required): Integer `1` to `5` matching Emergency Severity Index (ESI).
  - `vitalsAnomalyFlag` (`boolean`, required): True if heart rate, blood pressure, or SpO2 violate safe thresholds.
  - `diagnosticCodes` (`array<string>`, required): Standardized ICD-10-CM / SNOMED CT classification codes.
  - `redFlagSymptoms` (`array<string>`, required): High-risk clinical presentations.
  - `phiDeidentificationVerified` (`boolean`, required): Must be `true` for document persistence.

### 3.3 Logistics & Cold-Chain Telematics (`logistics`)
- **Use Case**: Refrigerated cargo telemetry, bottleneck analysis, customs risk, predictive ETA deviation.
- **Strict Properties**:
  - `shipmentTrackingId` (`string`, required): Unique consignment identifier.
  - `currentBottleneck` (`string`, required): Port congestion, customs hold, traffic incident, or weather.
  - `delayProbabilityPercent` (`number`, required): Integer `0` to `100`.
  - `predictedEtaDeviationMinutes` (`number`, required): Signed integer representing early (-) or late (+) delta.
  - `customsClearanceRisk` (`string`, required): Enum: `"LOW"` | `"MODERATE"` | `"CRITICAL"`.
  - `temperatureIntegrityBreached` (`boolean`, required): `true` if reefer temperature left +2°C to +8°C window.
  - `rerouteFeasibility` (`array<string>`, required): Alternative transit corridors.

---

## 4. Downstream Consumption & Validation
Before persisting records into Appwrite's `ai_transformations` collection:
1. `confidenceScore` is inspected: if `< 0.70`, the status is automatically converted to `"flagged"` for human review.
2. `complianceVerified` is verified: if `false`, the event is quarantined and alerts are dispatched.
3. The raw JSON string is persisted in `structured_output` with `confidence_score` indexed for fast querying.
