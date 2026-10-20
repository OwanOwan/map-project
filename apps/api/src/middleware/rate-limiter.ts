import { FastifyReply, FastifyRequest } from 'fastify';

export interface RateLimiterOptions {
  maxRequests: number;
  windowMs: number;
}

export class RateLimiter {
  private ipRecords: Map<string, number[]> = new Map();
  private userRecords: Map<string, number[]> = new Map();
  private maxRequests: number;
  private windowMs: number;

  constructor(options: RateLimiterOptions) {
    this.maxRequests = options.maxRequests;
    this.windowMs = options.windowMs;
  }

  private cleanAndCount(records: Map<string, number[]>, key: string, now: number): number[] {
    const timestamps = records.get(key) || [];
    const windowStart = now - this.windowMs;
    const valid = timestamps.filter((t) => t > windowStart);
    records.set(key, valid);
    return valid;
  }

  public checkAndRecord(
    key: string,
    records: Map<string, number[]>,
    now: number,
  ): { allowed: boolean; remaining: number; retryAfterSec: number } {
    const valid = this.cleanAndCount(records, key, now);

    if (valid.length >= this.maxRequests) {
      const oldestInWindow = valid[0];
      const resetTime = oldestInWindow + this.windowMs;
      const retryAfterSec = Math.max(1, Math.ceil((resetTime - now) / 1000));
      return { allowed: false, remaining: 0, retryAfterSec };
    }

    valid.push(now);
    records.set(key, valid);
    return {
      allowed: true,
      remaining: this.maxRequests - valid.length,
      retryAfterSec: 0,
    };
  }

  public getMiddleware() {
    return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const now = Date.now();
      const ip =
        (request.headers['x-forwarded-for'] as string)?.split(',')[0].trim() ||
        request.ip ||
        '127.0.0.1';

      // 1. Rate-limit by IP
      const ipCheck = this.checkAndRecord(ip, this.ipRecords, now);
      if (!ipCheck.allowed) {
        reply
          .status(429)
          .header('Retry-After', ipCheck.retryAfterSec)
          .header('X-RateLimit-Limit', this.maxRequests)
          .header('X-RateLimit-Remaining', 0)
          .send({
            statusCode: 429,
            error: 'Too Many Requests',
            message: `Rate limit exceeded for IP ${ip}. Maximum ${this.maxRequests} incident reports per ${this.windowMs / 1000}s.`,
            retryAfter: ipCheck.retryAfterSec,
          });
        return;
      }

      // 2. Rate-limit by User ID if authenticated
      if (request.user?.userId) {
        const userCheck = this.checkAndRecord(request.user.userId, this.userRecords, now);
        if (!userCheck.allowed) {
          reply
            .status(429)
            .header('Retry-After', userCheck.retryAfterSec)
            .header('X-RateLimit-Limit', this.maxRequests)
            .header('X-RateLimit-Remaining', 0)
            .send({
              statusCode: 429,
              error: 'Too Many Requests',
              message: `Rate limit exceeded for user ${request.user.userId}. Maximum ${this.maxRequests} incident reports per ${this.windowMs / 1000}s.`,
              retryAfter: userCheck.retryAfterSec,
            });
          return;
        }

        const minRemaining = Math.min(ipCheck.remaining, userCheck.remaining);
        reply
          .header('X-RateLimit-Limit', this.maxRequests)
          .header('X-RateLimit-Remaining', minRemaining);
      } else {
        reply
          .header('X-RateLimit-Limit', this.maxRequests)
          .header('X-RateLimit-Remaining', ipCheck.remaining);
      }
    };
  }

  public clear(): void {
    this.ipRecords.clear();
    this.userRecords.clear();
  }
}
