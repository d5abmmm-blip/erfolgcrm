import { Redis } from 'ioredis';
import { logger } from './logger';

let _redis: Redis | undefined;

export function getRedis(): Redis {
  if (!_redis) {
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    _redis = new Redis(url, {
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });
    _redis.on('error', (err) => logger.error({ err }, 'Redis error'));
  }
  return _redis;
}
