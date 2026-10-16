/**
 * The one door the vendor model SDK may leave through (ADR-011).
 *
 * The SDK is the schema builder, not the transport authority. This module is the sole importer of a
 * vendor SDK client constructor and the sole place a model secret becomes a client: it resolves the
 * key through the guard (`resolveOptionalSecretRef`) and validates the endpoint
 * (`authorizeProviderEndpoint`) *before* the SDK is handed either, so the SDK cannot reach a host
 * the operator did not permit with a secret the operator did not allowlist.
 *
 * `test/egress-confinement.test.ts` asserts that no other module imports a vendor SDK client, reads
 * a provider secret, or imports a raw network client.
 */
import { GoogleGenAI } from '@google/genai';
import { authorizeProviderEndpoint, resolveOptionalSecretRef } from './egressGuard';
import { GeminiConfig } from '../configurations/gemini.config';

/** The environment variable name the Gemini key is mounted under. */
const GEMINI_SECRET_REF = 'GEMINI_API_KEY';

/** A placeholder shipped in `.env.example`; treated as "not mounted" rather than a live key. */
const PLACEHOLDER_KEY = 'MY_GEMINI_API_KEY';

let cached: GoogleGenAI | null = null;

/**
 * Builds the SDK client, or returns null when no live key is mounted (the caller's deterministic
 * path). Throws when a key is mounted but its reference or host is not permitted — fail closed.
 */
export async function createGeminiClient(): Promise<GoogleGenAI | null> {
  const apiKey = resolveOptionalSecretRef(GEMINI_SECRET_REF);
  if (!apiKey || apiKey === PLACEHOLDER_KEY) return null;
  if (cached) return cached;
  const endpoint = await authorizeProviderEndpoint(GeminiConfig.baseUrl, 'gemini-native');
  cached = new GoogleGenAI({
    apiKey,
    httpOptions: {
      baseUrl: endpoint.origin,
      headers: { 'User-Agent': GeminiConfig.userAgent },
    },
  });
  return cached;
}

/** Test seam: forget the memoized client so a later call re-reads the environment. */
export function resetGeminiClientForTests(): void {
  cached = null;
}
