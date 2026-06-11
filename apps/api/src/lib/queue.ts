/**
 * Тонкий фасад над BullMQ.
 *
 * Соглашения:
 * - Один Redis-инстанс на процесс (singleton из ./redis), но BullMQ требует отдельного
 *   соединения с `maxRetriesPerRequest: null` — поэтому фабрика создаёт ленивый second connection.
 * - Очереди именуются 'erfolg:<name>' чтобы не конфликтовать с другими namespace'ами.
 * - Воркеры регистрируются через `registerWorker()` — массив всех воркеров для graceful shutdown.
 * - `WORKERS_ENABLED=false` отключает регистрацию воркеров (для тестов и для отдельного процесса).
 */
import { Queue, Worker, type ConnectionOptions, type Processor, type WorkerOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { logger } from './logger';

const QUEUE_PREFIX = 'erfolg';

let _connection: ConnectionOptions | null = null;
let _bullRedis: Redis | null = null;

function getConnection(): ConnectionOptions {
  if (_connection) return _connection;
  // BullMQ требует отдельный Redis с maxRetriesPerRequest:null и enableReadyCheck:false.
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  _bullRedis = new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
  });
  _bullRedis.on('error', (err) => logger.error({ err }, 'BullMQ Redis error'));
  _connection = _bullRedis;
  return _connection;
}

const queues = new Map<string, Queue>();
const workers: Worker[] = [];

export function getQueue<TPayload = unknown>(name: string): Queue<TPayload> {
  const cached = queues.get(name);
  if (cached) return cached as Queue<TPayload>;
  const q = new Queue<TPayload>(name, {
    prefix: QUEUE_PREFIX,
    connection: getConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { count: 100, age: 24 * 3600 },
      removeOnFail: { count: 500, age: 7 * 24 * 3600 },
    },
  });
  queues.set(name, q);
  return q;
}

export interface RegisterWorkerOptions<TPayload, TResult> {
  name: string;
  processor: Processor<TPayload, TResult>;
  /** При false — функция вернёт null; нужно для тестов и для запуска воркеров отдельным процессом. */
  enabled?: boolean;
  concurrency?: number;
  workerOptions?: Partial<WorkerOptions>;
}

export function registerWorker<TPayload, TResult>(
  opts: RegisterWorkerOptions<TPayload, TResult>,
): Worker<TPayload, TResult> | null {
  const enabled = opts.enabled ?? process.env.WORKERS_ENABLED !== 'false';
  if (!enabled) return null;
  const worker = new Worker<TPayload, TResult>(opts.name, opts.processor, {
    prefix: QUEUE_PREFIX,
    connection: getConnection(),
    concurrency: opts.concurrency ?? 4,
    ...opts.workerOptions,
  });
  worker.on('failed', (job, err) =>
    logger.warn({ queue: opts.name, jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, 'job failed'),
  );
  worker.on('error', (err) => logger.error({ queue: opts.name, err }, 'worker error'));
  workers.push(worker);
  logger.info({ queue: opts.name, concurrency: opts.concurrency ?? 4 }, 'BullMQ worker registered');
  return worker;
}

/** Аккуратно остановить все воркеры и закрыть соединения. Используется на SIGTERM и в тестах. */
export async function shutdownQueues(): Promise<void> {
  await Promise.allSettled(workers.map((w) => w.close()));
  await Promise.allSettled([...queues.values()].map((q) => q.close()));
  if (_bullRedis) {
    await _bullRedis.quit().catch(() => undefined);
    _bullRedis = null;
    _connection = null;
  }
  workers.length = 0;
  queues.clear();
}

/** Имена очередей — единая точка правды, чтобы продюсер и воркер не разъехались. */
export const QUEUE_NAMES = {
  storageCleanup: 'storage-cleanup',
  pushSend: 'push-send',
  telegramNotify: 'telegram-notify',
} as const;
