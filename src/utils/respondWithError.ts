/**
 * The single place a route turns a thrown value into a response.
 *
 * Every route module used to carry its own `fail()` that returned `error.message` as the
 * body and hardcoded 409. That leaked runtime and filesystem text to callers and reported
 * server-side faults as client conflicts. Routes now call `respondWithError`, so the
 * status, the code and the publishable message are decided in exactly one place.
 *
 * The original message is logged, never returned, unless the classifier recognises it as
 * a domain code this codebase publishes.
 */

import { Response } from 'express';
import { TelemetryLogger } from './telemetryLogger';
import { classifyApiError, toErrorBody } from './apiError';

export function respondWithError(res: Response, error: unknown, fallbackCode = 'OPERATION_FAILED'): Response {
  const classified = classifyApiError(error, fallbackCode);

  if (classified.internal) {
    // An unrecognised fault. It gets a full log line and a correlation id; the caller
    // gets no description of the internals.
    TelemetryLogger.error('Unhandled runtime exception in API route', {
      message: classified.originalMessage ?? String(error),
      metadata: { incidentId: classified.incidentId, stack: error instanceof Error ? error.stack : undefined, path: res.req?.path },
    });
  } else {
    // A recognised refusal is an expected outcome, but it is still a rejection and must
    // leave a record. Silently swallowing it would make a client that is being refused
    // for a policy reason indistinguishable from one that is never answered.
    TelemetryLogger.warn('API request refused', {
      message: classified.message,
      metadata: { code: classified.code, status: classified.status, path: res.req?.path, method: res.req?.method },
    });
  }

  if (classified.retryAfterSeconds) res.setHeader('Retry-After', String(classified.retryAfterSeconds));
  return res.status(classified.status).json(toErrorBody(classified));
}
