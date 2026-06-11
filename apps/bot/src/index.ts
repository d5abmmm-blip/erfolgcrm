import 'dotenv/config';
import pino from 'pino';

const logger = pino({
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

/**
 * Telegram bot worker.
 * На этапе 0 — заглушка, не запускается без TELEGRAM_DEV_BOT_TOKEN.
 * Полная реализация — на этапе 7.
 *
 * Архитектура: per-tenant токен бота из таблицы telegram_bot_configs,
 * webhook-режим, общается с API через внутренний tRPC-клиент.
 */

const token = process.env.TELEGRAM_DEV_BOT_TOKEN;
if (!token) {
  logger.warn('TELEGRAM_DEV_BOT_TOKEN not set — bot worker idle (Stage 0 expected behavior)');
  process.exit(0);
}

logger.info('Bot worker started — waiting for Stage 7 implementation');
