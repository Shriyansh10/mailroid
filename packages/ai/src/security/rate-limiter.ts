// ── Rate limit configuration ─────────────────────────────────────────

interface RateLimitConfig {
  maxAttempts: number;
  windowMs: number;
}

const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

const LIMITS: Record<string, RateLimitConfig> = {
  sendEmail: { maxAttempts: 20, windowMs: DEFAULT_WINDOW_MS },
  createEvent: { maxAttempts: 50, windowMs: DEFAULT_WINDOW_MS },
  searchEmails: { maxAttempts: 200, windowMs: DEFAULT_WINDOW_MS },
  getEvents: { maxAttempts: 200, windowMs: DEFAULT_WINDOW_MS },
};

const DEFAULT_LIMIT: RateLimitConfig = { maxAttempts: 100, windowMs: DEFAULT_WINDOW_MS };

interface ToolCounter {
  attempts: number[];
  windowStart: number;
}

export interface RateCheckResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  currentCount: number;
}

/**
 * In-memory sliding-window rate limiter.
 * Counts ALL attempts — blocked, approval_required, and success.
 * Call increment BEFORE execution to prevent spam-forever-by-getting-blocked.
 */
export class RateLimiter {
  private counters = new Map<string, Map<string, ToolCounter>>();

  check(userId: string, toolName: string): RateCheckResult {
    const config = LIMITS[toolName] ?? DEFAULT_LIMIT;
    const now = Date.now();

    let userCounters = this.counters.get(userId);
    if (!userCounters) {
      userCounters = new Map();
      this.counters.set(userId, userCounters);
    }

    let counter = userCounters.get(toolName);
    if (!counter) {
      counter = { attempts: [], windowStart: now };
      userCounters.set(toolName, counter);
    }

    const windowStart = now - config.windowMs;
    counter.attempts = counter.attempts.filter((t) => t > windowStart);

    if (counter.windowStart < windowStart) {
      counter.windowStart = now;
    }

    counter.attempts.push(now);
    const currentCount = counter.attempts.length;
    const allowed = currentCount <= config.maxAttempts;
    const remaining = Math.max(0, config.maxAttempts - currentCount);
    const resetAt = counter.windowStart + config.windowMs;

    return { allowed, remaining, resetAt, currentCount };
  }

  getCount(userId: string, toolName: string): number {
    const userCounters = this.counters.get(userId);
    if (!userCounters) return 0;
    const counter = userCounters.get(toolName);
    if (!counter) return 0;
    const windowStart = Date.now() - (LIMITS[toolName]?.windowMs ?? DEFAULT_WINDOW_MS);
    return counter.attempts.filter((t) => t > windowStart).length;
  }

  resetUser(userId: string): void { this.counters.delete(userId); }
  resetAll(): void { this.counters.clear(); }
}

/** Singleton for use across the app. */
export const rateLimiter = new RateLimiter();
