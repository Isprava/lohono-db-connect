import { logger } from "../../observability/src/logger.js";

export type CircuitState = "closed" | "open" | "half-open";

export class CircuitOpenError extends Error {
  constructor(breakerName: string) {
    super(`Circuit breaker "${breakerName}" is open — request rejected`);
    this.name = "CircuitOpenError";
  }
}

export interface CircuitBreakerOptions {
  /** Identifier for logging */
  name: string;
  /** Consecutive failures before opening the circuit (default: 5) */
  failureThreshold?: number;
  /** Time in ms the circuit stays open before probing (default: 30000) */
  resetTimeoutMs?: number;
}

/**
 * Lightweight circuit breaker for external service calls.
 *
 * - Closed: requests pass through; consecutive failures are tracked.
 * - Open: requests fail immediately with CircuitOpenError.
 * - Half-Open: one probe request is allowed; success → closed, failure → open.
 */
export class CircuitBreaker {
  readonly name: string;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;

  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private lastFailureTime = 0;

  constructor(opts: CircuitBreakerOptions) {
    this.name = opts.name;
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.resetTimeoutMs = opts.resetTimeoutMs ?? 30_000;
  }

  getState(): CircuitState {
    // Check if we should transition from open → half-open
    if (this.state === "open" && Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
      this.transitionTo("half-open");
    }
    return this.state;
  }

  /** Manually reset to closed state */
  reset(): void {
    this.consecutiveFailures = 0;
    this.transitionTo("closed");
  }

  /**
   * Execute a function through the circuit breaker.
   * Throws CircuitOpenError if the circuit is open.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.getState();

    if (currentState === "open") {
      throw new CircuitOpenError(this.name);
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.state === "half-open") {
      this.transitionTo("closed");
    }
  }

  private onFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    if (this.state === "half-open") {
      // Probe failed — back to open
      this.transitionTo("open");
    } else if (this.consecutiveFailures >= this.failureThreshold) {
      this.transitionTo("open");
    }
  }

  private transitionTo(newState: CircuitState): void {
    if (this.state === newState) return;
    const prevState = this.state;
    this.state = newState;
    logger.warn(`Circuit breaker "${this.name}": ${prevState} → ${newState}`, {
      failures: String(this.consecutiveFailures),
      threshold: String(this.failureThreshold),
    });
  }
}
