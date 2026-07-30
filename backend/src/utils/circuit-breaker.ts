// backend/src/utils/circuit-breaker.ts
//
// Circuit Breaker pattern implementation for external API resilience.
// Prevents cascade failures when external services are down.

import { EventEmitter } from 'events';

export enum CircuitState {
  CLOSED = 'CLOSED',     // Normal operation, requests go through
  OPEN = 'OPEN',         // Failing, requests blocked immediately
  HALF_OPEN = 'HALF_OPEN' // Testing if service recovered
}

export interface CircuitBreakerConfig {
  failureThreshold: number;      // Number of failures before opening
  successThreshold: number;      // Successes needed in HALF_OPEN to close
  timeout: number;               // Time in ms before trying HALF_OPEN
  monitoredErrors?: string[];    // Error messages that count as failures
}

export interface CircuitBreakerStats {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailure?: Date;
  lastSuccess?: Date;
  nextAttempt?: Date;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  successThreshold: 2,
  timeout: 30_000, // 30 seconds
};

export class CircuitBreaker extends EventEmitter {
  private state: CircuitState = CircuitState.CLOSED;
  private failures = 0;
  private successes = 0;
  private lastFailure?: Date;
  private lastSuccess?: Date;
  private nextAttempt?: Date;
  private readonly config: CircuitBreakerConfig;
  private readonly name: string;

  constructor(name: string, config: Partial<CircuitBreakerConfig> = {}) {
    super();
    this.name = name;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  getState(): CircuitState {
    if (this.state === CircuitState.OPEN && this.nextAttempt && Date.now() >= this.nextAttempt.getTime()) {
      this.transitionToHalfOpen();
    }
    return this.state;
  }

  getStats(): CircuitBreakerStats {
    return {
      state: this.getState(),
      failures: this.failures,
      successes: this.successes,
      lastFailure: this.lastFailure,
      lastSuccess: this.lastSuccess,
      nextAttempt: this.nextAttempt,
    };
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    const currentState = this.getState();
    
    if (currentState === CircuitState.OPEN) {
      throw new Error(`Circuit breaker "${this.name}" is OPEN - failing fast`);
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error: any) {
      this.onFailure(error);
      throw error;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.successes++;
    this.lastSuccess = new Date();

    if (this.state === CircuitState.HALF_OPEN) {
      if (this.successes >= this.config.successThreshold) {
        this.transitionToClosed();
      }
    }

    this.emit('success', this.getStats());
  }

  private onFailure(error: Error): void {
    this.successes = 0;
    this.failures++;
    this.lastFailure = new Date();

    const shouldOpen = this.failures >= this.config.failureThreshold;

    if (shouldOpen && this.state !== CircuitState.OPEN) {
      this.transitionToOpen();
    }

    this.emit('failure', { ...this.getStats(), error });
  }

  private transitionToOpen(): void {
    this.state = CircuitState.OPEN;
    this.nextAttempt = new Date(Date.now() + this.config.timeout);
    console.warn(`[CIRCUIT] "${this.name}" opened after ${this.failures} failures. Next attempt at ${this.nextAttempt.toISOString()}`);
    this.emit('open', this.getStats());
  }

  private transitionToHalfOpen(): void {
    this.state = CircuitState.HALF_OPEN;
    this.successes = 0;
    console.log(`[CIRCUIT] "${this.name}" half-open - testing service recovery`);
    this.emit('halfOpen', this.getStats());
  }

  private transitionToClosed(): void {
    this.state = CircuitState.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.nextAttempt = undefined;
    console.log(`[CIRCUIT] "${this.name}" closed - service recovered`);
    this.emit('close', this.getStats());
  }

  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.lastFailure = undefined;
    this.lastSuccess = undefined;
    this.nextAttempt = undefined;
    this.emit('reset', this.getStats());
  }

  forceOpen(): void {
    this.transitionToOpen();
  }

  forceClosed(): void {
    this.transitionToClosed();
  }
}

// Global registry for all circuit breakers
class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();

  get(name: string, config?: Partial<CircuitBreakerConfig>): CircuitBreaker {
    if (!this.breakers.has(name)) {
      this.breakers.set(name, new CircuitBreaker(name, config));
    }
    return this.breakers.get(name)!;
  }

  getAllStats(): Record<string, CircuitBreakerStats> {
    const stats: Record<string, CircuitBreakerStats> = {};
    this.breakers.forEach((breaker, name) => {
      stats[name] = breaker.getStats();
    });
    return stats;
  }

  resetAll(): void {
    this.breakers.forEach(breaker => breaker.reset());
  }
}

export const circuitBreakerRegistry = new CircuitBreakerRegistry();

// Pre-configured breakers for known external services
export const geoapifyBreaker = circuitBreakerRegistry.get('geoapify', {
  failureThreshold: 5,
  successThreshold: 2,
  timeout: 60_000,
});

export const osrmBreaker = circuitBreakerRegistry.get('osrm', {
  failureThreshold: 5,
  successThreshold: 2,
  timeout: 30_000,
});

export const orsBreaker = circuitBreakerRegistry.get('ors', {
  failureThreshold: 5,
  successThreshold: 2,
  timeout: 60_000,
});

export const twilioBreaker = circuitBreakerRegistry.get('twilio', {
  failureThreshold: 10,
  successThreshold: 3,
  timeout: 120_000,
});

export const supabaseBreaker = circuitBreakerRegistry.get('supabase', {
  failureThreshold: 10,
  successThreshold: 3,
  timeout: 60_000,
});

export const nominatimBreaker = circuitBreakerRegistry.get('nominatim', {
  failureThreshold: 5,
  successThreshold: 2,
  timeout: 60_000,
});

export const overpassBreaker = circuitBreakerRegistry.get('overpass', {
  failureThreshold: 3,
  successThreshold: 2,
  timeout: 120_000,
});

export const googleRoutesBreaker = circuitBreakerRegistry.get('googleRoutes', {
  failureThreshold: 3,
  successThreshold: 2,
  timeout: 60_000,
});

export const googlePlacesBreaker = circuitBreakerRegistry.get('googlePlaces', {
  failureThreshold: 3,
  successThreshold: 2,
  timeout: 30_000,
});