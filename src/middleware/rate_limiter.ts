/**
 * Sliding-window rate limiter backed by Redis with an in-memory fallback.
 *
 * v1 bug fixed: getRedis() kept a half-connected client after a failed
 * connect() and every subsequent call threw "already connecting/connected".
 * Now a single connection promise is shared and reset on failure.
 */
import { createClient, RedisClientType } from 'redis';
import { logger } from './logger';

let connectPromise: Promise<RedisClientType | null> | null = null;
const inMemory: Map<string, { count: number; resetAt: number }> = new Map();

async function getRedis(): Promise<RedisClientType | null> {
  if (!process.env.REDIS_URL) return null;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    try {
      const client = createClient({ url: process.env.REDIS_URL }) as RedisClientType;
      client.on('error', err => logger.debug({ err }, '[RateLimiter] Redis error'));
      await client.connect();
      return client;
    } catch {
      connectPromise = null;
      return null;
    }
  })();

  return connectPromise;
}

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
