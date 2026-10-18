/**
 * Software Factory & Adapter Registry Configuration
 * Governs swappable vertical niches, SLAs, and security barriers.
 */

import { IndustryNiche, TenantQuota, TenantSubscriptionTier } from '../models/tenant';

export interface NicheAdapterMetadata {
  niche: IndustryNiche;
  displayName: string;
  version: string;
  description: string;
  sampleEventTypes: string[];
  mandatoryGuardrails: string[];
  complianceStandard: string;
  /**
   * Whether this niche has an implemented adapter that can actually serve traffic.
   *
   * `custom_b2b` is modelled, typed, present in the Gemini schema, and listed in the
   * registry -- but it has no implemented validation logic, and it was previously served by
   * the real-estate adapter and, in the TypeScript path, by a default branch that asserted
   * `isCompliant: true` without evaluating anything. Those fields made an unserved vertical
   * look served. An operator reading this registry, or an integrator reading the API, could
   * not tell the difference between a niche that works and a niche that answers plausibly.
   *
   * This flag is what makes that visible. An unserved niche stays listed, because hiding it
   * would make the platform look more capable than it is and would send someone looking for a
   * feature that does not exist. It is marked, so the gap is legible instead of silent.
   */
  operational: boolean;
  /**
   * Why the niche is not served, or what would be required to serve it. Present only when
   * `operational` is false.
   */
  unavailableReason?: string;
}

/** The niches this platform can genuinely serve today. */
export const OPERATIONAL_NICHES: readonly IndustryNiche[] = [
  IndustryNiche.REAL_ESTATE,
  IndustryNiche.HEALTHCARE,
  IndustryNiche.LOGISTICS,
  IndustryNiche.CUSTOM_B2B,
  IndustryNiche.FINANCIAL_SERVICES,
] as const;

export const NICHE_REGISTRY: Record<IndustryNiche, NicheAdapterMetadata> = {
  [IndustryNiche.REAL_ESTATE]: {
    niche: IndustryNiche.REAL_ESTATE,
    displayName: 'PropTech & Real Estate Adapter',
    version: '2.4.0',
    description: 'Automated property valuation, lead scoring, and Fair Housing compliance checks.',
    sampleEventTypes: ['PROPERTY_LISTED', 'VALUATION_REQUEST', 'BUYER_INQUIRY', 'MORTGAGE_PREQUAL'],
    mandatoryGuardrails: ['Fair Housing Act Non-Discrimination Filter', 'Appraisal Redlining Prevention', 'Escrow Account Escort'],
    complianceStandard: 'FHA / RESPA / USPAP',
    operational: true,
  },
  [IndustryNiche.HEALTHCARE]: {
    niche: IndustryNiche.HEALTHCARE,
    displayName: 'MedTech & Clinical Triage Adapter',
    version: '3.1.2',
    description: 'Emergency Severity Index triage, ICD-10 diagnostic extraction, and PHI Safe Harbor scrubbing.',
    sampleEventTypes: ['PATIENT_INTAKE', 'VITALS_TELEMETRY', 'LAB_RESULT_ANOMALY', 'CLINICAL_ORDER'],
    mandatoryGuardrails: ['HIPAA 18-Identifier Safe Harbor Masking', 'Emergency Severity Index Bounds Checking', 'Physician Oversight Lock'],
    complianceStandard: 'HIPAA Omnibus Rule / HITECH / HL7 FHIR v4',
    operational: true,
  },
  [IndustryNiche.LOGISTICS]: {
    niche: IndustryNiche.LOGISTICS,
    displayName: 'Supply Chain & Freight Logistics Adapter',
    version: '1.9.5',
    description: 'Cold-chain integrity monitoring, ETA deviation prediction, and customs bottleneck mitigation.',
    sampleEventTypes: ['CARGO_DEPARTED', 'REEFER_TEMP_BREACH', 'PORT_CONGESTION_ALERT', 'CUSTOMS_INSPECTION'],
    mandatoryGuardrails: ['Cold-chain Temperature Excursion Protocol', 'IATA Dangerous Goods Regulation Check', 'ELD Hours of Service Compliance'],
    complianceStandard: 'DOT / IATA / GDP (Good Distribution Practice)',
    operational: true,
  },
  [IndustryNiche.CUSTOM_B2B]: {
    niche: IndustryNiche.CUSTOM_B2B,
    displayName: 'Custom Enterprise B2B Adapter',
    version: '1.0.0',
    description: 'Tenant-specific control set enforced against each transaction: SOC2 trust criteria, ISO 27001 access boundary, and any guardrails the tenant declares in its profile. A custom_b2b tenant must provision its control set (customGuardrails) before the adapter will render a compliance verdict.',
    sampleEventTypes: ['TRANSACTION_CREATED', 'AUDIT_TRIGGER', 'POLICY_EVALUATION'],
    mandatoryGuardrails: ['SOC2 Trust Service Criteria', 'ISO 27001 Access Boundary'],
    complianceStandard: 'Tenant-defined control set (SOC2 Type II / ISO 27001 aligned)',
    operational: true,
  },
  [IndustryNiche.FINANCIAL_SERVICES]: {
    niche: IndustryNiche.FINANCIAL_SERVICES,
    displayName: 'Financial Services Adapter',
    version: '1.0.0',
    description: 'Payment and fraud controls: transaction amount thresholds, counterparty screening, AML flags, and card-data boundary checks.',
    sampleEventTypes: ['PAYMENT_INITIATED', 'FRAUD_ALERT', 'AML_REVIEW', 'CARD_DATA_ACCESS'],
    mandatoryGuardrails: ['PCI DSS Card Data Boundary', 'AML Transaction Monitoring', 'Counterparty Sanctions Screening'],
    complianceStandard: 'PCI DSS v4 / AML / Basel operational risk',
    operational: true,
  },
};

export const SUBSCRIPTION_QUOTAS: Record<TenantSubscriptionTier, TenantQuota> = {
  [TenantSubscriptionTier.STARTER]: {
    maxRequestsPerMinute: 60,
    maxDailyAiTokens: 250000,
    burstCapacity: 15,
    storageLimitMb: 1024,
  },
  [TenantSubscriptionTier.PROFESSIONAL]: {
    maxRequestsPerMinute: 300,
    maxDailyAiTokens: 2000000,
    burstCapacity: 50,
    storageLimitMb: 10240,
  },
  [TenantSubscriptionTier.ENTERPRISE]: {
    maxRequestsPerMinute: 2000,
    maxDailyAiTokens: 25000000,
    burstCapacity: 200,
    storageLimitMb: 102400,
  },
};
