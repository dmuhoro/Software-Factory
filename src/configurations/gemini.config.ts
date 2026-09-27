/**
 * Google GenAI Engine Configuration
 * Configuration parameters for the @google/genai SDK integration.
 */

export const GeminiConfig = {
  // Primary model for low-latency, deterministic structured output processing
  defaultModel: 'gemini-3.8-flash',
  // Advanced reasoning fallback
  proModel: 'gemini-3.1-pro-preview',
  userAgent: 'software-factory-runtime',
  generationParameters: {
    temperature: 0.1, // Near zero temperature for strict schema compliance & deterministic output
    topP: 0.95,
    topK: 40,
    responseMimeType: 'application/json',
  },
  resilience: {
    timeoutMs: 25000,
    maxRetries: 3,
    initialBackoffMs: 800,
    maxBackoffMs: 8000,
    jitterFactor: 0.25,
    // Wall-clock budget for the whole retried operation, not one attempt. With a 25s
    // per-attempt timeout and three retries the unconstrained cost is 4 x 25s plus three
    // backoffs, so a single enrichment can hold a request for over 90s. This is the
    // ceiling `withExponentialBackoff` enforces and must exceed timeoutMs.
    overallDeadlineMs: 70000,
  },
};
