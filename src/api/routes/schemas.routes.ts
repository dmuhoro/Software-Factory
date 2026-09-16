/**
 * Schema Introspection Routes
 * Exposes Appwrite database schemas, attribute permissions, and Gemini JSON schema specifications.
 */

import { Router, Request, Response } from 'express';
import { ALL_COLLECTION_BLUEPRINTS, APPWRITE_DATABASE_CONFIG } from '../../models/appwriteSchema';
import {
  REAL_ESTATE_RESPONSE_SCHEMA,
  HEALTHCARE_RESPONSE_SCHEMA,
  LOGISTICS_RESPONSE_SCHEMA,
  CUSTOM_B2B_RESPONSE_SCHEMA,
} from '../../models/geminiSchema';
import { NICHE_REGISTRY } from '../../configurations/factory.config';

const router = Router();

router.get('/appwrite', (_req: Request, res: Response) => {
  res.json({
    status: 'success',
    database: APPWRITE_DATABASE_CONFIG,
    collections: ALL_COLLECTION_BLUEPRINTS,
  });
});

router.get('/gemini', (_req: Request, res: Response) => {
  res.json({
    status: 'success',
    schemas: {
      real_estate: REAL_ESTATE_RESPONSE_SCHEMA,
      healthcare: HEALTHCARE_RESPONSE_SCHEMA,
      logistics: LOGISTICS_RESPONSE_SCHEMA,
      custom_b2b: CUSTOM_B2B_RESPONSE_SCHEMA,
    },
  });
});

router.get('/niches', (_req: Request, res: Response) => {
  res.json({
    status: 'success',
    niches: Object.values(NICHE_REGISTRY),
  });
});

export default router;
