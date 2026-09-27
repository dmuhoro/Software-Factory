/**
 * Global Error Handling Middleware
 *
 * Anything that escapes a route handler lands here. The previous version returned
 * `err.message` to the caller, which for an unrecognised fault is whatever the runtime
 * or the filesystem said -- absolute paths, internal identifiers, occasionally credential
 * echoes -- and it labelled every failure a malformed context error with a 500. Both
 * are now handled by the shared classifier, which publishes only messages this codebase
 * wrote and returns a correlation id for everything else.
 */

import { Request, Response, NextFunction } from 'express';
import { TelemetryLogger } from '../../utils/telemetryLogger';
import { classifyApiError, toErrorBody } from '../../utils/apiError';

export function globalErrorHandler(err: Error, req: Request, res: Response, _next: NextFunction) {
  const classified = classifyApiError(err, 'UNHANDLED_ROUTE_FAILURE');

  // A recognised domain condition is an expected outcome, not an incident, so it is
  // recorded at warn and without a stack. Only unrecognised faults are logged as errors,
  // and only those carry the raw message that made them unrecognisable.
  if (classified.internal) {
    TelemetryLogger.error('Unhandled runtime exception in API gateway', {
      message: classified.originalMessage ?? err.message,
      metadata: {
        incidentId: classified.incidentId,
        stack: err.stack,
        path: req.path,
        method: req.method,
      },
    });
  } else {
    TelemetryLogger.warn('API request refused', {
      message: classified.message,
      metadata: { code: classified.code, status: classified.status, path: req.path, method: req.method },
    });
  }

  if (classified.retryAfterSeconds) res.setHeader('Retry-After', String(classified.retryAfterSeconds));
  res.status(classified.status).json(toErrorBody(classified));
}
