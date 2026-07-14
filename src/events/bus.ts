import { createClient, RedisClientType } from 'redis';
import { v4 as uuidv4 } from 'uuid';
import type { AnyEvent, EventType } from '../types/events';
import { logger } from '../middleware/logger';

type EventHandler<T extends AnyEvent = AnyEvent> = (event: T) => Promise<void>;

class PersistentEventBus {
  private publisher: RedisClientType;
  private subscriber: RedisClientType;
  private handlers: Map<string, EventHandler[]> = new Map();
  private fallbackHandlers: Map<string, EventHandler[]> = new Map();
  private useFallback = false;

  constructor() {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    this.publisher = createClient({ url: redisUrl }) as RedisClientType;
    this.subscriber = createClient({ url: redisUrl }) as RedisClientType;
  }

  async connect(): Promise<void> {
    try {
      await this.publisher.connect();
      await this.subscriber.connect();

      // Set up consumer group for reliable delivery
      try {
        await this.publisher.xGroupCreate('waxprep:events', 'tutors', '$', { MKSTREAM: true });
      } catch {
        // Group already exists — that's fine
      }

      // Start consuming from the stream
      this.startConsuming();
      logger.info('[EventBus] Connected to Redis Streams');
    } catch (err) {
      logger.warn('[EventBus] Redis unavailable — falling back to in-memory');
      this.useFallback = true;
    }
  }

  async publish(event: Omit<AnyEvent, 'id'> & { id?: string }): Promise<void> {
    const fullEvent = { ...event, id: event.id || uuidv4() } as AnyEvent;

    if (this.useFallback) {
      this.deliverToHandlers(fullEvent);
      return;
    }

    try {
      await this.publisher.xAdd('waxprep:events', '*', {
        type: fullEvent.type,
        payload: JSON.stringify(fullEvent),
      });
    } catch {
      this.deliverToHandlers(fullEvent);
    }
  }

  private async startConsuming(): Promise<void> {
    const consume = async () => {
      while (true) {
        try {
          const messages = await this.subscriber.xReadGroup(
            'tutors',
            `worker-${process.pid}`,
            [{ key: 'waxprep:events', id: '>' }],
            { COUNT: 10, BLOCK: 1000 }
          );

          if (!messages) continue;

          for (const stream of messages) {
            for (const msg of stream.messages) {
              const event = JSON.parse(msg.message.payload) as AnyEvent;
              this.deliverToHandlers(event);
              await this.subscriber.xAck('waxprep:events', 'tutors', msg.id);
            }
          }
        } catch (err) {
          logger.error('[EventBus] Consumer error:', err);
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    };

    consume().catch(err => logger.error('[EventBus] Consumer fatal:', err));
  }

  private deliverToHandlers(event: AnyEvent): void {
    const handlers = this.handlers.get(event.type) || [];
    const wildcardHandlers = this.handlers.get('*') || [];

    for (const handler of [...handlers, ...wildcardHandlers]) {
      setImmediate(async () => {
        try {
          await handler(event);
        } catch (err) {
          logger.error(`[EventBus] Handler error for ${event.type}:`, err);
        }
      });
    }
  }

  subscribe<T extends AnyEvent>(
    eventType: EventType | EventType[] | '*',
    handler: EventHandler<T>
  ): () => void {
    const types = Array.isArray(eventType) ? eventType : [eventType];

    types.forEach(type => {
      const existing = this.handlers.get(type) || [];
      this.handlers.set(type, [...existing, handler as EventHandler]);
    });

    return () => {
      types.forEach(type => {
        const existing = this.handlers.get(type) || [];
        this.handlers.set(type, existing.filter(h => h !== handler));
      });
    };
  }
}

export const eventBus = new PersistentEventBus();