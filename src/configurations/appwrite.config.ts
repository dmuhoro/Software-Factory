/**
 * Appwrite Backend Configuration
 * Defines connection parameters, collection IDs, and client credentials.
 */

export const AppwriteConfig = {
  endpoint: process.env.APPWRITE_ENDPOINT || 'https://cloud.appwrite.io/v1',
  projectId: process.env.APPWRITE_PROJECT_ID || 'b2b_software_factory_proj',
  apiKey: process.env.APPWRITE_API_KEY || 'standard_appwrite_api_key_secret',
  databaseId: process.env.APPWRITE_DATABASE_ID || 'b2b_software_factory',
  collections: {
    tenants: 'tenants',
    telemetryEvents: 'telemetry_events',
    aiTransformations: 'ai_transformations',
    auditLogs: 'audit_logs',
  },
  limits: {
    maxBatchSize: 100,
    requestTimeoutMs: 15000,
    retryAttempts: 3,
  },
};
