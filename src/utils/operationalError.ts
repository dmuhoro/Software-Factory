/**
 * Typed operational failures.
 *
 * Every error that can reach a client is constructed here so that the message a client
 * sees is written by this codebase, not inherited from a dependency. Upstream SDK errors
 * routinely embed the full HTTP body, request URLs, and sometimes credential echoes;
 * forwarding `error.message` verbatim leaks internal topology and upstream detail to
 * unauthenticated-adjacent callers. That is the same defect as returning a raw stack
 * trace in a response.
 *
 * The rule: log the raw upstream failure for operators, return only a stable code plus
 * a message safe to publish. Never put the upstream text in `message`.
 */

export type OperationalErrorCode =
  | 'PIPELINE_FAILURE'
  | 'ENRICHMENT_DEGRADED'
  | 'ENRICHMENT_UNAVAILABLE'
  | 'LEDGER_UNAVAILABLE'
  | 'DEPENDENCY_TIMEOUT'
  | 'TENANT_NOT_ONBOARDED';

export interface OperationalErrorOptions {
  /** The unmodified upstream failure. Logged, never returned. */
  cause?: unknown;
  /** Seconds the client should wait before retrying. */
  retryAfterSeconds?: number;
  /** Facts about what is already durable, so the client is never misled. */
  details?: Record<string, unknown>;
  /** Marks whether the raw record reached durable storage before this failure. */
  rawPayloadPersisted?: boolean;
  rawDocumentId?: string | null;
  deduplicated?: boolean;
}

export class OperationalError extends Error {
  public readonly code: OperationalErrorCode;
  public readonly status: number;
  public readonly retryAfterSeconds?: number;
  public readonly details?: Record<string, unknown>;
  public readonly rawPayloadPersisted: boolean;
  public readonly rawDocumentId: string | null;
  public readonly deduplicated: boolean;
  public readonly upstream?: unknown;

  constructor(code: OperationalErrorCode, message: string, status: number, options: OperationalErrorOptions = {}) {
    super(message);
    this.name = 'OperationalError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.details = options.details;
    this.rawPayloadPersisted = options.rawPayloadPersisted ?? false;
    this.rawDocumentId = options.rawDocumentId ?? null;
    this.deduplicated = options.deduplicated ?? false;
    this.upstream = options.cause;
  }

  /** The exact payload a client may see. Contains no upstream text. */
  public toResponse(): Record<string, unknown> {
    return {
      status: 'error',
      code: this.code,
      message: this.message,
      ...(this.details ?? {}),
      rawPayloadPersisted: this.rawPayloadPersisted,
      ...(this.rawDocumentId ? { rawDocumentId: this.rawDocumentId } : {}),
      ...(this.deduplicated ? { deduplicated: true } : {}),
      retryable: this.status === 503 || this.status === 504,
    };
  }
}

/**
 * Classifies a failure of a downstream dependency into a safe client contract.
 *
 * Callers must pass the raw error so it can be logged, but the returned message is
 * chosen from this table and never derived from upstream text.
 */
export function classifyDependencyFailure(raw: unknown, options: OperationalErrorOptions = {}): OperationalError {
  const text = raw instanceof Error ? raw.message : String(raw ?? '');
  const code = (raw as NodeJS.ErrnoException)?.code;
  const isCircuitOpen = /circuit\s*breaker/i.test(text) && /\bOPEN\b/.test(text);
  const isTimeout = code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || /timed?\s*out|timeout/i.test(text);

  if (isCircuitOpen) {
    return new OperationalError(
      'ENRICHMENT_UNAVAILABLE',
      'The structured enrichment engine is temporarily unavailable. The telemetry record has been accepted and is queued for enrichment.',
      503,
      { ...options, cause: raw, retryAfterSeconds: options.retryAfterSeconds ?? 30 },
    );
  }
  if (isTimeout) {
    return new OperationalError(
      'DEPENDENCY_TIMEOUT',
      'A downstream dependency did not respond in time. The telemetry record has been accepted and will be enriched on retry.',
      504,
      { ...options, cause: raw, retryAfterSeconds: options.retryAfterSeconds ?? 30 },
    );
  }
  return new OperationalError(
    'ENRICHMENT_DEGRADED',
    'The telemetry record was accepted but structured enrichment failed. Enrichment will be retried.',
    503,
    { ...options, cause: raw, retryAfterSeconds: options.retryAfterSeconds ?? 30 },
  );
}
