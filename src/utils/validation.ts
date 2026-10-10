/**
 * Validation and Diagnostic Utilities
 * Implements strict payload schema enforcement and standardized error emission.
 */

import { IndustryNiche } from '../models/tenant';

export interface StandardErrorResponse {
  status: 'error';
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export function emitMalformedContextError(diagnosticDescription: string, details?: Record<string, unknown>): StandardErrorResponse {
  return {
    status: 'error',
    code: 'MALFORMED_CONTEXT',
    message: diagnosticDescription,
    ...(details ? { details } : {}),
  };
}

export function emitSecurityError(code: string, message: string): StandardErrorResponse {
  return {
    status: 'error',
    code,
    message,
  };
}

/**
 * Refusal for a niche that is modelled but has no implemented adapter.
 *
 * A separate code from `MALFORMED_CONTEXT` because the operator action is different: a
 * malformed context is fixed in the caller's payload, while an unserved niche is fixed by
 * providing an adapter. Reporting both as `MALFORMED_CONTEXT` would send an integrator into
 * a debugging loop over a payload that is in fact correct.
 */
export function emitNicheNotServedError(niche: string, reason: string): StandardErrorResponse {
  return {
    status: 'error',
    code: 'NICHE_NOT_SERVED',
    message: `NICHE_NOT_SERVED: niche '${niche}' has no implemented adapter. ${reason}`,
  };
}

export function validateIncomingTelemetry(raw: unknown): { isValid: boolean; error?: StandardErrorResponse; data?: Record<string, unknown> } {
  if (!raw || typeof raw !== 'object') {
    return {
      isValid: false,
      error: emitMalformedContextError('Incoming payload must be a non-null JSON object'),
    };
  }

  const payload = raw as Record<string, unknown>;

  if (!payload.tenantId || typeof payload.tenantId !== 'string' || !payload.tenantId.trim()) {
    return {
      isValid: false,
      error: emitMalformedContextError('Tenant ID (tenantId) is missing or not a non-empty string'),
    };
  }

  if (!payload.niche || !Object.values(IndustryNiche).includes(payload.niche as IndustryNiche)) {
    return {
      isValid: false,
      error: emitMalformedContextError(
        `Invalid or unsupported industry niche '${payload.niche}'. Allowed: ${Object.values(IndustryNiche).join(', ')}`
      ),
    };
  }

  if (!payload.eventType || typeof payload.eventType !== 'string') {
    return {
      isValid: false,
      error: emitMalformedContextError('Event type (eventType) is missing or invalid'),
    };
  }

  if (!payload.payload || typeof payload.payload !== 'object') {
    return {
      isValid: false,
      error: emitMalformedContextError('Inner business payload must be an object containing domain metrics'),
    };
  }

  // ADR-001: the composite uniqueness key is [tenant_id, idempotency_key]. Without it
  // a replayed event cannot be detected, so it is a required partition attribute, not
  // an optional hint. Persistence dereferences this field unconditionally.
  const metadata = payload.metadata as Record<string, unknown> | undefined;
  if (!metadata || typeof metadata !== 'object') {
    return {
      isValid: false,
      error: emitMalformedContextError("Telemetry metadata is required and must include 'idempotencyKey'"),
    };
  }

  if (typeof metadata.idempotencyKey !== 'string' || !metadata.idempotencyKey.trim()) {
    return {
      isValid: false,
      error: emitMalformedContextError("Telemetry metadata requires a non-empty string 'idempotencyKey' (ADR-001 composite uniqueness key)"),
    };
  }

  if (metadata.idempotencyKey.length > 200) {
    return {
      isValid: false,
      error: emitMalformedContextError("Telemetry 'idempotencyKey' must not exceed 200 characters"),
    };
  }

  if (payload.timestamp !== undefined && (typeof payload.timestamp !== 'string' || Number.isNaN(Date.parse(payload.timestamp)))) {
    return {
      isValid: false,
      error: emitMalformedContextError('Telemetry timestamp must be an ISO-8601 string when supplied'),
    };
  }

  // Check niche-specific constraints
  const niche = payload.niche as IndustryNiche;
  const inner = payload.payload as Record<string, unknown>;

  if (niche === IndustryNiche.REAL_ESTATE) {
    if (!inner.propertyId && !inner.listingId) {
      return {
        isValid: false,
        error: emitMalformedContextError("Real Estate telemetry requires 'propertyId' or 'listingId' attribute in payload"),
      };
    }
  } else if (niche === IndustryNiche.HEALTHCARE) {
    if (!inner.patientCohortId && !inner.clinicalEncounterId) {
      return {
        isValid: false,
        error: emitMalformedContextError("Healthcare telemetry requires 'patientCohortId' or 'clinicalEncounterId' (PHI Safe Harbor identifier)"),
      };
    }
    // Zero-conflation PHI check
    if (inner.ssn || inner.socialSecurityNumber || inner.patientFullName) {
      return {
        isValid: false,
        error: emitMalformedContextError("Direct PHI (SSN, Full Name) detected in raw stream; violates HIPAA zero-conflation guardrails"),
      };
    }
  } else if (niche === IndustryNiche.LOGISTICS) {
    if (!inner.shipmentTrackingId && !inner.waybillNumber) {
      return {
        isValid: false,
        error: emitMalformedContextError("Logistics telemetry requires 'shipmentTrackingId' or 'waybillNumber' attribute"),
      };
    }
  }

  return { isValid: true, data: payload };
}
