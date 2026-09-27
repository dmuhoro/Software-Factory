/**
 * API Module Main Entry Point
 * Exports the combined router and middleware components.
 */

import { Router } from 'express';
import apiRoutes from './routes';
import { tenantAuthMiddleware, tenantRateLimiter, globalErrorHandler } from './middleware';

export const apiRouter = Router();

// Order is load-bearing. Authentication must run BEFORE rate limiting, because the
// limiter can only key on an identity it can trust; the previous order gave the limiter
// nothing but a caller-supplied X-Tenant-Id header, which a caller could rotate to
// sidestep it entirely.
apiRouter.use(tenantAuthMiddleware);
apiRouter.use(tenantRateLimiter);
apiRouter.use('/', apiRoutes);

export * from './middleware';
export * from './routes';
export default apiRouter;
