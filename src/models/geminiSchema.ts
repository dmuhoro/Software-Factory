/**
 * Gemini Structured Output Schemas Protocol
 * Uses @google/genai Type enums to enforce deterministic JSON schemas for each niche.
 */

import { Type } from '@google/genai';
import { IndustryNiche } from './tenant';

// Standard Enterprise Response Schema definition
export const REAL_ESTATE_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    status: {
      type: Type.STRING,
      description: "Processing status: 'success', 'flagged', or 'quarantined'",
    },
    confidenceScore: {
      type: Type.NUMBER,
      description: "Model confidence score between 0.00 and 1.00",
    },
    nicheSpecificResult: {
      type: Type.OBJECT,
      description: "Real Estate specific valuation and lead scoring transformation",
      properties: {
        propertyId: { type: Type.STRING },
        estimatedValuationUsd: { type: Type.NUMBER },
        valuationRange: {
          type: Type.OBJECT,
          properties: {
            low: { type: Type.NUMBER },
            high: { type: Type.NUMBER },
          },
          required: ["low", "high"],
        },
        marketTrend: { type: Type.STRING, description: "BULLISH, BEARISH, or NEUTRAL" },
        leadQualityScore: { type: Type.NUMBER, description: "0 to 100" },
        riskFactors: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
        },
        taxAssessmentFlag: { type: Type.BOOLEAN },
      },
      required: [
        "propertyId",
        "estimatedValuationUsd",
        "valuationRange",
        "marketTrend",
        "leadQualityScore",
        "riskFactors",
        "taxAssessmentFlag"
      ],
    },
    recommendedActions: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    anomaliesDetected: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    complianceVerified: {
      type: Type.BOOLEAN,
      description: "True if Fair Housing and audit regulations pass validation",
    },
  },
  required: [
    "status",
    "confidenceScore",
    "nicheSpecificResult",
    "recommendedActions",
    "anomaliesDetected",
    "complianceVerified",
  ],
};

export const HEALTHCARE_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    status: {
      type: Type.STRING,
      description: "Processing status: 'success', 'flagged', or 'quarantined'",
    },
    confidenceScore: {
      type: Type.NUMBER,
      description: "Clinical extraction confidence score 0.00 to 1.00",
    },
    nicheSpecificResult: {
      type: Type.OBJECT,
      description: "Healthcare HIPAA/HL7 FHIR compliant triage transformation",
      properties: {
        patientCohortId: { type: Type.STRING },
        triageUrgencyScore: { type: Type.NUMBER, description: "Scale 1 to 5 Emergency Severity Index" },
        vitalsAnomalyFlag: { type: Type.BOOLEAN },
        diagnosticCodes: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: "ICD-10 or SNOMED-CT clinical codes",
        },
        redFlagSymptoms: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
        },
        phiDeidentificationVerified: {
          type: Type.BOOLEAN,
          description: "True if all 18 HIPAA Safe Harbor identifiers are stripped",
        },
      },
      required: [
        "patientCohortId",
        "triageUrgencyScore",
        "vitalsAnomalyFlag",
        "diagnosticCodes",
        "redFlagSymptoms",
        "phiDeidentificationVerified"
      ],
    },
    recommendedActions: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    anomaliesDetected: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    complianceVerified: {
      type: Type.BOOLEAN,
      description: "HIPAA compliance and PHI scrubbing verification flag",
    },
  },
  required: [
    "status",
    "confidenceScore",
    "nicheSpecificResult",
    "recommendedActions",
    "anomaliesDetected",
    "complianceVerified",
  ],
};

export const LOGISTICS_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    status: {
      type: Type.STRING,
      description: "Processing status: 'success', 'flagged', or 'quarantined'",
    },
    confidenceScore: {
      type: Type.NUMBER,
      description: "Supply chain prediction confidence score 0.00 to 1.00",
    },
    nicheSpecificResult: {
      type: Type.OBJECT,
      description: "Logistics shipment route anomaly and ETA prediction",
      properties: {
        shipmentTrackingId: { type: Type.STRING },
        currentBottleneck: { type: Type.STRING },
        delayProbabilityPercent: { type: Type.NUMBER, description: "0 to 100" },
        predictedEtaDeviationMinutes: { type: Type.NUMBER },
        customsClearanceRisk: { type: Type.STRING, description: "LOW, MODERATE, CRITICAL" },
        temperatureIntegrityBreached: { type: Type.BOOLEAN },
        rerouteFeasibility: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
        },
      },
      required: [
        "shipmentTrackingId",
        "currentBottleneck",
        "delayProbabilityPercent",
        "predictedEtaDeviationMinutes",
        "customsClearanceRisk",
        "temperatureIntegrityBreached",
        "rerouteFeasibility"
      ],
    },
    recommendedActions: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    anomaliesDetected: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    complianceVerified: {
      type: Type.BOOLEAN,
      description: "Cold-chain DOT / IATA transport compliance status",
    },
  },
  required: [
    "status",
    "confidenceScore",
    "nicheSpecificResult",
    "recommendedActions",
    "anomaliesDetected",
    "complianceVerified",
  ],
};

export const CUSTOM_B2B_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    status: { type: Type.STRING },
    confidenceScore: { type: Type.NUMBER },
    nicheSpecificResult: {
      type: Type.OBJECT,
      properties: {
        entityId: { type: Type.STRING },
        kpiMetrics: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
        },
        riskRating: { type: Type.STRING },
        policyViolationDetected: { type: Type.BOOLEAN },
      },
      required: ["entityId", "kpiMetrics", "riskRating", "policyViolationDetected"],
    },
    recommendedActions: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    anomaliesDetected: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    complianceVerified: { type: Type.BOOLEAN },
  },
  required: [
    "status",
    "confidenceScore",
    "nicheSpecificResult",
    "recommendedActions",
    "anomaliesDetected",
    "complianceVerified",
  ],
};

export function getNicheResponseSchema(niche: IndustryNiche) {
  switch (niche) {
    case IndustryNiche.REAL_ESTATE:
      return REAL_ESTATE_RESPONSE_SCHEMA;
    case IndustryNiche.HEALTHCARE:
      return HEALTHCARE_RESPONSE_SCHEMA;
    case IndustryNiche.LOGISTICS:
      return LOGISTICS_RESPONSE_SCHEMA;
    default:
      return CUSTOM_B2B_RESPONSE_SCHEMA;
  }
}
