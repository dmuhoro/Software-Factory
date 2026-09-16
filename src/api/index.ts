/**
 * API Module Main Entry Point
 * Exports the combined router and middleware components.
 */

import { Router } from 'express';
import apiRoutes from './routes';
import { tenantAuthMiddleware, tenantRateLimiter, globalErrorHandler } from './middleware';

export const apiRouter = Router();

// Global middleware for API routes
apiRouter.use(tenantRateLimiter);
apiRouter.use(tenantAuthMiddleware);
apiRouter.use('/', apiRoutes);

export * from './middleware';
export * from './routes';
export default apiRouter;
