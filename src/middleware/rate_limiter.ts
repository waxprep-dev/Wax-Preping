/**
 * Sliding-window rate limiter backed by Redis with an in-memory fallback.
 */
import { getRedis } from '../db/redis';

const inMemory: Map<string, { count: number; resetAt: number }> = new Map();

export async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const now = Date.now();
  const resetAt = now + windowSeconds * 1000;
  const client = await getRedis();

  if (!client) {
    const entry = inMemory.get(key);
    if (!entry || entry.resetAt < now) {
      inMemory.set(key, { count: 1, resetAt });
      return { allowed: true, remaining: maxRequests - 1, resetAt };
    }
    entry.count++;
    return {
      allowed: entry.count <= maxRequests,
      remaining: Math.max(0, maxRequests - entry.count),
      resetAt: entry.resetAt,
    };
  }

  try {
    const multi = client.multi();
    multi.incr(key);
    multi.expire(key, windowSeconds);
    const results = await multi.exec();
    const count = results![0] as number;
    return {
      allowed: count <= maxRequests,
      remaining: Math.max(0, maxRequests - count),
      resetAt,
    };
  } catch {
    return { allowed: true, remaining: maxRequests, resetAt };
  }
}
