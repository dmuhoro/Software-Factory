/**
 * Circuit Breaker and Resilient Retry Utility
 * Protects downstream AI and Appwrite APIs against cascading failures, 429 rate limits, and latency spikes.
 */

export enum CircuitState {
  CLOSED = 'CLOSED',       // Normal operation
  OPEN = 'OPEN',           // Tripped; fast-fail immediately
  HALF_OPEN = 'HALF_OPEN', // Probe request allowed
}

export interface CircuitBreakerOptions {
  failureThreshold: number; // e.g. 5 failures
  resetTimeoutMs: number;   // e.g. 15000 ms before testing half-open
  successThreshold: number; // e.g. 2 consecutive successes in half-open
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private readonly name: string;
  private readonly options: CircuitBreakerOptions;

  constructor(name: string, options?: Partial<CircuitBreakerOptions>) {
    this.name = name;
    this.options = {
      failureThreshold: options?.failureThreshold ?? 5,
      resetTimeoutMs: options?.resetTimeoutMs ?? 15000,
      successThreshold: options?.successThreshold ?? 2,
    };
  }

  public getState(): CircuitState {
    if (this.state === CircuitState.OPEN) {
      const now = Date.now();
      if (now - this.lastFailureTime >= this.options.resetTimeoutMs) {
        this.state = CircuitState.HALF_OPEN;
        this.successCount = 0;
      }
    }
    return this.state;
  }

  public async execute<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.getState();

    if (currentState === CircuitState.OPEN) {
      throw new Error(`CircuitBreaker [${this.name}] is OPEN. Fast-failing to protect downstream systems.`);
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  private recordSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= this.options.successThreshold) {
        this.state = CircuitState.CLOSED;
        this.failureCount = 0;
        this.successCount = 0;
      }
    } else {
      this.failureCount = 0;
    }
  }

  private recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.options.failureThreshold) {
      this.state = CircuitState.OPEN;
    }
  }
}

/**
 * Thrown when the overall budget for a retried operation is spent. Distinct from an
 * attempt failure so the caller can tell "the provider is unhealthy" from "we ran out of
 * time", which are different operational responses.
 */
export class OperationDeadlineExceededError extends Error {
  readonly code = 'OPERATION_DEADLINE_EXCEEDED';
  constructor(elapsedMs: number, deadlineMs: number, options?: { cause?: unknown }) {
    super(`Operation exceeded its ${deadlineMs}ms deadline after ${elapsedMs}ms`, options);
    this.name = 'OperationDeadlineExceededError';
  }
}

/**
 * Execute an async operation with full exponential backoff and jitter, under an overall
 * deadline.
 *
 * `maxRetries` and the per-attempt timeout do not bound the total time. With a 25s
 * per-attempt timeout and three retries an operation can occupy a request for over a
 * minute: four attempts plus three backoffs, with a client that has usually given up by
 * the second. The retry budget is therefore only meaningful alongside a wall-clock
 * budget, so one is required here rather than defaulted to infinity.
 *
 * The deadline is checked before each attempt and after each failure, and the remaining
 * budget bounds the backoff sleep. On expiry the last error is attached as `cause` so the
 * underlying failure is still diagnosable, and the deadline error is thrown in its place:
 * a caller gets an explicit refusal rather than a stalled request or a partial result.
 *
 * @param deadlineMs total wall-clock budget for all attempts. Must be a positive finite
 *   number; there is deliberately no "unbounded" option.
 */
export async function withExponentialBackoff<T>(
  operation: (attempt: number) => Promise<T>,
  maxRetries = 3,
  initialBackoffMs = 500,
  maxBackoffMs = 5000,
  jitterFactor = 0.2,
  deadlineMs = 60_000
): Promise<{ result: T; attempts: number }> {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new Error(`withExponentialBackoff requires a positive finite deadline, received ${deadlineMs}`);
  }

  const startedAt = Date.now();
  let attempt = 0;
  let lastError: unknown;

  while (attempt <= maxRetries) {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= deadlineMs) {
      throw new OperationDeadlineExceededError(elapsed, deadlineMs);
    }

    attempt++;
    try {
      return { result: await operation(attempt), attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt > maxRetries) {
        throw error;
      }

      const rawDelay = Math.min(initialBackoffMs * Math.pow(2, attempt - 1), maxBackoffMs);
      const jitter = rawDelay * jitterFactor * (Math.random() * 2 - 1);
      const delay = Math.max(50, Math.floor(rawDelay + jitter));

      // Never sleep past the deadline, and stop if the sleep itself would exceed it.
      const remaining = deadlineMs - (Date.now() - startedAt);
      if (remaining <= delay) {
        throw new OperationDeadlineExceededError(deadlineMs - remaining, deadlineMs, { cause: lastError });
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // Only reachable if maxRetries is negative, which the loop guard above otherwise masks.
  throw new OperationDeadlineExceededError(Date.now() - startedAt, deadlineMs, { cause: lastError });
}
