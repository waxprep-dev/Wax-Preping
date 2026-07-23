import { createClient, RedisClientType } from 'redis';
import { logger } from '../middleware/logger';

let connectPromise: Promise<RedisClientType | null> | null = null;

export async function getRedis(): Promise<RedisClientType | null> {
  if (!process.env.REDIS_URL) return null;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    try {
      const client = createClient({ url: process.env.REDIS_URL }) as RedisClientType;
      client.on('error', err => logger.debug({ err }, '[Redis] error'));
      await client.connect();
      return client;
    } catch {
      connectPromise = null;
      return null;
    }
  })();

  return connectPromise;
}
