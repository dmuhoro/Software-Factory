/**
 * Global Error Handling Middleware
 * Guarantees zero unhandled crashes and strictly formats standardized JSON errors.
 */

import { Request, Response, NextFunction } from 'express';
import { emitMalformedContextError } from '../../utils/validation';
import { TelemetryLogger } from '../../utils/telemetryLogger';

export function globalErrorHandler(err: Error, req: Request, res: Response, _next: NextFunction) {
  TelemetryLogger.error('Unhandled runtime exception in API gateway', {
    message: err.message,
    metadata: { stack: err.stack, path: req.path },
  });

  const errorResponse = emitMalformedContextError(err.message || 'Internal processing error occurred');
  res.status(500).json(errorResponse);
}
