/**
 * Routes Module Entry Point
 */

import { Router } from 'express';
import telemetryRoutes from './telemetry.routes';
import tenantsRoutes from './tenants.routes';
import schemasRoutes from './schemas.routes';
import factoryRoutes from './factory.routes';
import factoryJobsRoutes from './factoryJobs.routes';
import contextRoutes from './context.routes';
import workspaceRoutes from './workspace.routes';
import clientRoutes from './client.routes';
import deploymentRoutes from './deployment.routes';
import agentsRoutes from './agents.routes';
import proofRoutes from './proof.routes';
import operationsRoutes from './operations.routes';

const router = Router();

router.use('/telemetry', telemetryRoutes);
router.use('/tenants', tenantsRoutes);
router.use('/schemas', schemasRoutes);
router.use('/factory', factoryRoutes);
router.use('/factory-jobs', factoryJobsRoutes);
router.use('/context', contextRoutes);
router.use('/workspace', workspaceRoutes);
router.use('/client', clientRoutes);
router.use('/deployment', deploymentRoutes);
router.use('/agents', agentsRoutes);
router.use('/proof', proofRoutes);
router.use('/operations', operationsRoutes);

export default router;
