/**
 * Appwrite Backend Configuration.
 *
 * ## Why this file was rewritten
 *
 * The previous version of this file was the worst kind of configuration in a product that
 * handles tenant data, because it looked configured while being fiction:
 *
 * ```ts
 * endpoint: process.env.APPWRITE_ENDPOINT || 'https://cloud.appwrite.io/v1',
 * projectId: process.env.APPWRITE_PROJECT_ID || 'b2b_software_factory_proj',
 * apiKey:    process.env.APPWRITE_API_KEY    || 'standard_appwrite_api_key_secret',
 * ```
 *
 * Three separate failures, all of which fail *open*:
 *
 * 1. `standard_appwrite_api_key_secret` is shaped like a real Appwrite key. It is a
 *    placeholder. A default that reads as a credential is worse than no default, because an
 *    operator scanning the config sees a plausible key and concludes the integration is done.
 *    It is the same defect as the `GEMINI_API_KEY` -> `TEST_KEY` default hardened in 4.7.0,
 *    which returned invented data that even asserted `complianceVerified: true`.
 * 2. `b2b_software_factory_proj` is a fabricated project id. No such project exists.
 * 3. The endpoint defaulted to the global `cloud.appwrite.io` rather than the regional endpoint
 *    this deployment actually uses, so a missing variable silently sent tenant telemetry to
 *    the wrong jurisdiction.
 *
 * Worse, the Rust runtime already refused to start without `APPWRITE_API_KEY`,
 * `APPWRITE_PROJECT_ID` and `APPWRITE_ENDPOINT` (that fail-closed contract was added in
 * 4.7.0), while the TypeScript configuration invented all three. The two halves of the same
 * product disagreed about whether Appwrite was required.
 *
 * ## The contract now
 *
 * There is no default for a credential or a project id. `resolveAppwriteConfig` reports what is
 * missing, `isPlaceholder` refuses values that read as templates, and `requireAppwriteConfig`
 * throws rather than returning a client that would fail later with an opaque 401. A service
 * that cannot reach its own database must say so at startup, not on the first write.
 *
 * See ADR-006: the repository is canonical and Appwrite is an adapter against it, not a source
 * of truth. An adapter still has to be real.
 */

import type { ConfigIssue } from './runtimeConfig';

export interface AppwriteSettings {
  /** Appwrite REST endpoint, e.g. `https://fra.cloud.appwrite.io/v1`. */
  endpoint: string;
  /** Appwrite project id. Never defaulted. */
  projectId: string;
  /** Server API key. Read from the environment and never committed. */
  apiKey: string;
  /** Database id, defaulted to a local convention because it is not a credential. */
  databaseId: string;
  /** Collection ids, kept as a named record so a typo fails a test rather than a request. */
  collections: {
    tenants: string;
    telemetryEvents: string;
    aiTransformations: string;
    auditLogs: string;
  };
  limits: {
    maxBatchSize: number;
    requestTimeoutMs: number;
    retryAttempts: number;
  };
  /** False when any required variable is missing or is a known placeholder. */
  configured: boolean;
  issues: ConfigIssue[];
}

const PLACEHOLDER_PATTERN =
  /^(replace|changeme|your[-_ ]|placeholder|example|dummy|fake|xxx+|todo)/;

/**
 * True when a value is a template rather than a credential.
 *
 * ## The bug this function had, and how it was found
 *
 * The first version refused anything beginning `standard_`, on the reasoning that `standard_` is
 * the prefix Appwrite issues real keys with and the shipped placeholder was
 * `standard_appwrite_api_key_secret`. Both halves of that reasoning are wrong in the same
 * direction: `standard_` is precisely what a *real* Appwrite key begins with, followed by a long
 * hex string. So the guard refused every genuine credential the operator owns.
 *
 * It was found by running this function against the operator's actual key during the first
 * authenticated connection -- a guard that blocks real traffic does not protect anything. It gets
 * bypassed by whoever hits the wall, and then it is a wall with no gate behind it.
 *
 * The corrected rule keeps the intent and drops the overreach. A real key is `standard_` followed
 * by hex, so the value is a template when the text after the prefix is *not* hex --
 * `standard_appwrite_api_key_secret` is not, and the real key is. The readable-word checks below
 * then catch the placeholder independently, so removing `standard_` from the prefix set costs no
 * coverage.
 */
export function isPlaceholder(value: string): boolean {
  const normalised = value.trim().toLowerCase();
  if (normalised.length === 0) return true;
  if (PLACEHOLDER_PATTERN.test(normalised)) return true;
  if (normalised.includes('api_key') || normalised.includes('apikey') || normalised.endsWith('-secret')) return true;
  // The shipped placeholder is the one value this file must always refuse, whatever its shape.
  if (normalised === 'standard_appwrite_api_key_secret') return true;
  // An Appwrite key is `standard_` + hex. Anything after the prefix that is not hex is a
  // template, whatever it is called.
  if (normalised.startsWith('standard_')) return !/^standard_[0-9a-f]{64,}$/.test(normalised);
  return false;
}

/**
 * True when a value is a syntactically real Appwrite project id.
 *
 * A blacklist of known fakes cannot work here: `b2b_software_factory_proj` was the fabricated id
 * that shipped, and the next one will be a different string. So the project id is validated by
 * *shape* instead.
 *
 * The shape is 20 alphanumeric characters, measured rather than remembered. The first version of
 * this regex asserted 24, which is a MongoDB ObjectId length, and it rejected the operator's
 * actual project id -- the same failure mode as the `standard_` bug above, in the opposite
 * direction: a guard tightened until it blocked the real thing. Both the operator's real project
 * id and their real account id are exactly 20 alphanumeric characters; the fabricated id is 25 and
 * contains an underscore, so it fails both tests.
 *
 * The lesson across the three bugs this file has now had: a guard that enumerates bad values
 * misses the next bad value; a guard that enumerates a *prefix* of good values rejects good
 * values; and a guard invented from memory rather than measured rejects the real value too.
 *
 * Even so, this regex is a heuristic and is not the authority. The authority is the live
 * authenticated call in `checkAppwriteReachable`, which asks Appwrite whether the id exists. A
 * shape check catches the obvious; only the server can confirm.
 */
export function isValidAppwriteId(value: string): boolean {
  return /^[a-zA-Z0-9]{20}$/.test(value.trim());
}

function trimmed(value: string | undefined): string {
  return (value ?? '').trim();
}

/**
 * Validates Appwrite configuration without inventing any part of it.
 *
 * Mirrors the Rust runtime's required variables exactly, so the two halves of the product can
 * no longer disagree about whether the integration is configured.
 */
export function resolveAppwriteConfig(env: NodeJS.ProcessEnv = process.env): AppwriteSettings {
  const isProduction = env.NODE_ENV === 'production';
  const issues: ConfigIssue[] = [];

  const endpoint = trimmed(env.APPWRITE_ENDPOINT);
  const projectId = trimmed(env.APPWRITE_PROJECT_ID);
  const apiKey = trimmed(env.APPWRITE_API_KEY);
  const databaseId = trimmed(env.APPWRITE_DATABASE_ID) || 'b2b_software_factory';

  const requireValue = (variable: string, value: string, hint: string): void => {
    if (value === '') {
      issues.push({
        variable,
        // Missing configuration is a warning in development so the founder loop still runs on a
        // laptop with no Appwrite account, and an error everywhere else. The Rust runtime
        // refuses to start either way; this half reports rather than dying silently.
        severity: isProduction ? 'error' : 'warning',
        message: `${variable} is not set. ${hint}`,
      });
    } else if (isPlaceholder(value)) {
      issues.push({
        variable,
        severity: 'error',
        message: `${variable} is a known placeholder value. It cannot authenticate anything, so anything that appears to work is fabricated. ${hint}`,
      });
    }
  };

  requireValue('APPWRITE_ENDPOINT', endpoint, 'Use the regional endpoint, e.g. https://fra.cloud.appwrite.io/v1');
  requireValue('APPWRITE_PROJECT_ID', projectId, 'The Appwrite console project id, e.g. the 24-character id under Project settings');
  requireValue('APPWRITE_API_KEY', apiKey, 'Create one in the Appwrite console under Overview > Integrations > API keys. Never commit it.');

  if (projectId !== '' && !isValidAppwriteId(projectId)) {
    issues.push({
      variable: 'APPWRITE_PROJECT_ID',
      severity: 'error',
      message: `APPWRITE_PROJECT_ID must be the 20-character id from the Appwrite console (received "${projectId}"). A name, a slug or a placeholder is not an id. npm run appwrite:check confirms it against the server.`,
    });
  }

  if (endpoint !== '' && !/^https:\/\/[a-z0-9.-]+\/v\d+$/.test(endpoint)) {
    issues.push({
      variable: 'APPWRITE_ENDPOINT',
      severity: 'error',
      message: `APPWRITE_ENDPOINT must be an https URL ending in the API version path, e.g. https://fra.cloud.appwrite.io/v1 (received "${endpoint}").`,
    });
  }

  const configured = !issues.some((issue) => issue.severity === 'error')
    && endpoint !== '' && projectId !== '' && apiKey !== '';

  return {
    endpoint,
    projectId,
    apiKey,
    databaseId,
    collections: {
      tenants: 'tenants',
      telemetryEvents: 'telemetry_events',
      aiTransformations: 'ai_transformations',
      auditLogs: 'audit_logs',
    },
    limits: { maxBatchSize: 100, requestTimeoutMs: 15000, retryAttempts: 3 },
    configured,
    issues,
  };
}

/**
 * Returns validated configuration or throws, naming every problem at once.
 *
 * Returning a half-built settings object is what produced the defect this file replaces, so
 * there is no partial result: either the integration can be used, or the caller is told exactly
 * which variables are missing and where to get them.
 */
export function requireAppwriteConfig(env: NodeJS.ProcessEnv = process.env): AppwriteSettings {
  const settings = resolveAppwriteConfig(env);
  // `configured` rather than the error count. The first version of this filtered to
  // severity === 'error', which meant an unset APPWRITE_* under a non-production NODE_ENV
  // downgraded to a warning and this function returned an empty, unusable settings object
  // instead of throwing -- fail-open behaviour in the one function written to prevent it.
  if (!settings.configured) {
    const blocking = settings.issues.filter((issue) => issue.severity === 'error');
    const detail = (blocking.length > 0 ? blocking : settings.issues)
      .map((issue) => `  - ${issue.variable}: ${issue.message}`).join('\n');
    throw new Error(
      `Appwrite is not configured, and this product will not invent its configuration.\n${detail}\n\n`
      + 'Set the variables above, or run without the Appwrite adapter on the local durable store.',
    );
  }
  return settings;
}
