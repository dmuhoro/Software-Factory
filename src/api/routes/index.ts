/**
 * Routes Module Entry Point
 */

import { Router } from 'express';
import telemetryRoutes from './telemetry.routes';
import tenantsRoutes from './tenants.routes';
import schemasRoutes from './schemas.routes';
import factoryRoutes from './factory.routes';

const router = Router();

router.use('/telemetry', telemetryRoutes);
router.use('/tenants', tenantsRoutes);
router.use('/schemas', schemasRoutes);
router.use('/factory', factoryRoutes);

export default router;
