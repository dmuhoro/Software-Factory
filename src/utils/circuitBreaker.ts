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
 * Execute an async operation with full exponential backoff and jitter.
 */
export async function withExponentialBackoff<T>(
  operation: (attempt: number) => Promise<T>,
  maxRetries = 3,
  initialBackoffMs = 500,
  maxBackoffMs = 5000,
  jitterFactor = 0.2
): Promise<{ result: T; attempts: number }> {
  let attempt = 0;
  while (attempt <= maxRetries) {
    attempt++;
    try {
      const result = await operation(attempt);
      return { result, attempts: attempt };
    } catch (error) {
      if (attempt > maxRetries) {
        throw error;
      }
      const rawDelay = Math.min(initialBackoffMs * Math.pow(2, attempt - 1), maxBackoffMs);
      const jitter = rawDelay * jitterFactor * (Math.random() * 2 - 1);
      const delay = Math.max(50, Math.floor(rawDelay + jitter));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error('Exhausted all retry attempts in withExponentialBackoff');
}
