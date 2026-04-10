import { Queue, Worker, QueueEvents, ConnectionOptions } from 'bullmq';
import { env } from '../config/env';
import { logger } from '../utils/logger';

// ─── Redis connection config ──────────────────────────────────────────────────

export const redisConnection: ConnectionOptions = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  password: env.REDIS_PASSWORD,
  maxRetriesPerRequest: null, // Required for BullMQ
  enableReadyCheck: false,
};

// ─── Queue names (typed constants to avoid typos) ────────────────────────────

export const QUEUE_NAMES = {
  MESSAGE_SYNC: 'slack:message-sync',
  CHANNEL_SYNC: 'slack:channel-sync',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

// ─── Queue factory ────────────────────────────────────────────────────────────

const queues = new Map<QueueName, Queue>();


export function getQueue(name: QueueName): Queue {
  if (queues.has(name)) return queues.get(name)!;

  const queue = new Queue(name, {
    connection: redisConnection,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,         // 2s, 4s, 8s
      },
      removeOnComplete: { count: 100 },  // Keep last 100 completed jobs
      removeOnFail: { count: 500 },      // Keep last 500 failed jobs
    },
  });

  queue.on('error', (err) => {
    logger.error({ queue: name, err: err.message }, '[Queue] Queue error');
  });

  queues.set(name, queue);
  return queue;
}

/**
 * Creates a QueueEvents instance for listening to job lifecycle events.
 * Use this for monitoring/observability.
 */
export function getQueueEvents(name: QueueName): QueueEvents {
  return new QueueEvents(name, { connection: redisConnection });
}

/**
 * Gracefully closes all open queue connections.
 * Call this in process shutdown handlers.
 */
export async function closeAllQueues(): Promise<void> {
  const closePromises = Array.from(queues.values()).map((q) => q.close());
  await Promise.allSettled(closePromises);
  queues.clear();
  logger.info('[Queue] All queues closed');
}

// ─── Job data types ───────────────────────────────────────────────────────────

export interface MessageSyncJobData {
  workspaceId: string;
  channelId?: string;
  since?: string;         // ISO string
  fullSync?: boolean;
  limit?: number;
  requestId?: string;
}

export interface ChannelSyncJobData {
  workspaceId: string;
  requestId?: string;
}
