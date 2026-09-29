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
  // Keyed by every niche in the registry, including the ones that are not operational. The
  // schema for an unserved niche is still the schema that would be used, and hiding it would
  // make the API look simpler than it is; the `operational` flag on the registry entry is
  // what tells a caller whether sending an event will be served. A response schema with no
  // way to ask "is this actually available?" is an invitation to build against a capability
  // that refuses at runtime.
  res.json({
    status: 'success',
    schemas: {
      real_estate: REAL_ESTATE_RESPONSE_SCHEMA,
      healthcare: HEALTHCARE_RESPONSE_SCHEMA,
      logistics: LOGISTICS_RESPONSE_SCHEMA,
      custom_b2b: CUSTOM_B2B_RESPONSE_SCHEMA,
    },
    operationalNiches: Object.values(NICHE_REGISTRY)
      .filter((niche) => niche.operational)
      .map((niche) => niche.niche),
    unavailableNiches: Object.values(NICHE_REGISTRY)
      .filter((niche) => !niche.operational)
      .map((niche) => ({
        niche: niche.niche,
        reason: niche.unavailableReason,
      })),
  });
});

router.get('/niches', (_req: Request, res: Response) => {
  // The full registry, with each entry marked operational or not. The gap stays visible here
  // on purpose: a niche that is quietly absent from the API is a niche someone will keep
  // asking about, and a niche that is quietly present is a niche someone will build against.
  res.json({
    status: 'success',
    niches: Object.values(NICHE_REGISTRY),
  });
});

export default router;
