import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import { sql } from 'drizzle-orm';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import { appRouter } from './trpc/router';
import { createContext } from './trpc/context';
import { logger } from './lib/logger';
import { getDb } from '@erfolg/db';
import { getRedis } from './lib/redis';
import { makeStorageLocalRouter } from './routes/storage-local';
import { makeTelegramWebhookRouter } from './routes/telegram-webhook';
import { makeOnecWebhookRouter } from './routes/onec-webhook';
import { makeBackupRouter } from './routes/backup';
import { shutdownQueues } from './lib/queue';
import { shutdownMailer } from './lib/mailer';
import { registerStorageCleanupWorker } from './workers/storage-cleanup';
import { registerPushSendWorker } from './workers/push-send';
import {
  enqueueInvoiceReminderSchedule,
  registerInvoiceReminderWorker,
} from './workers/invoice-reminder';
import { registerTicketStatusNotifyWorker } from './workers/ticket-status-notify';
import {
  enqueueCalendarReminderSchedule,
  registerCalendarReminderWorker,
} from './workers/calendar-reminder';
import {
  enqueueEmailInboundSchedule,
  registerEmailInboundWorker,
} from './workers/email-inbound';
import {
  reconcileScheduledSends,
  registerEmailScheduledWorker,
} from './workers/email-scheduled';

// Глобальная страховка от «тихой смерти» процесса. Незанятое событие 'error' у любого
// EventEmitter (например обрыв IMAP/TLS-сокета) и необработанный rejected-промис по
// умолчанию роняют Node. Для внутренней CRM это недопустимо: сбой периферии (почта,
// очереди) не должен останавливать заявки и клиентов. Логируем ГРОМКО (error) и держим
// процесс живым. Точечное лечение — слушатель 'error' на каждом эмиттере (например
// modules/email/imap.ts → attachImapErrorGuard); эти хендлеры — последний рубеж обороны.
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandledRejection — процесс оставлен живым');
});
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'uncaughtException — процесс оставлен живым');
});

const app = express();
const PORT = Number(process.env.API_PORT ?? 3030);
const HOST = process.env.API_HOST ?? '0.0.0.0';

// trust proxy — для корректного req.ip за nginx
app.set('trust proxy', 1);

app.use(helmet());
app.use(compression());
// Block A: SESSION_SECRET зарезервирован под signed cookies (req.signedCookies).
// Сейчас все cookie читаются как unsigned (req.cookies) — подпись не проверяется.
// Оставляем секрет в конструкторе на случай миграции на signed позже без переписывания.
app.use(cookieParser(process.env.SESSION_SECRET));
// CORS: боевые origin'ы задаются через CORS_ORIGINS (через запятую, например
// "https://crm.erfolg-md.ru"). localhost разрешён только вне production —
// в проде web и api живут на одном домене за nginx, и обычно CORS не нужен вовсе.
const corsProd = process.env.NODE_ENV === 'production';
const corsOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (corsOrigins.includes(origin)) return cb(null, true);
      const allowed =
        !corsProd && /^https?:\/\/([a-z0-9-]+\.)?localhost(:\d+)?$/.test(origin);
      cb(null, allowed);
    },
    credentials: true,
    allowedHeaders: ['Content-Type', 'X-Tenant-Subdomain'],
  }),
);
app.use(pinoHttp({ logger }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// Deep healthcheck — реально дёргает БД и Redis. Используется в smoke-тесте и проверке прода.
// 200 если все зависимости отвечают, 503 если хоть одна не пингуется.
app.get('/health/deep', async (_req, res) => {
  const checks: Record<string, { ok: boolean; latencyMs?: number; error?: string }> = {};
  const t0 = Date.now();

  try {
    const start = Date.now();
    await getDb().execute(sql`SELECT 1`);
    checks.db = { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    checks.db = { ok: false, error: (err as Error).message };
  }

  if (process.env.REDIS_URL) {
    try {
      const start = Date.now();
      await getRedis().ping();
      checks.redis = { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      checks.redis = { ok: false, error: (err as Error).message };
    }
  }

  const allOk = Object.values(checks).every((c) => c.ok);
  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ok' : 'degraded',
    ts: new Date().toISOString(),
    checks,
    totalLatencyMs: Date.now() - t0,
  });
});

// Brute-force защита логина: 10 попыток/мин с одного IP, применяется только к auth-путям.
// trust proxy уже выставлен выше — req.ip корректен за nginx.
const LOGIN_RATE_LIMIT = Number(process.env.LOGIN_RATE_LIMIT ?? 10);
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: LOGIN_RATE_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Слишком много попыток входа. Попробуйте через минуту.' },
  skip: (req) => {
    const url = req.url || '';
    return !(
      url.includes('auth.login') ||
      url.includes('auth.verify2fa') ||
      url.includes('clientAuth.login')
    );
  },
});
app.use('/api/v1/trpc', authLimiter);

// Локальный S3-эмулятор для dev. Подключаем только при STORAGE_DRIVER=local (или unset в dev).
const storageDriver = process.env.STORAGE_DRIVER ?? (process.env.NODE_ENV === 'production' ? 's3' : 'local');
if (storageDriver === 'local') {
  app.use('/api/v1/storage', makeStorageLocalRouter());
  logger.info('Local storage emulator mounted at /api/v1/storage');
}

// Telegram webhook (Этап 7-B). Публичный — авторизуется по X-Telegram-Bot-Api-Secret-Token.
app.use('/api/v1/telegram', makeTelegramWebhookRouter());

// 1С webhook (Этап 8.F). Публичный — авторизуется по Bearer токену из onec_configs.incoming_token_hash.
app.use('/api/v1/onec', makeOnecWebhookRouter());

// Резервные копии: стрим полной копии базы (pg_dump). Авторизуется HMAC-токеном,
// который выдаёт директор-only процедура backup.requestFullDump.
app.use('/api/v1/backup', makeBackupRouter());

app.use(
  '/api/v1/trpc',
  createExpressMiddleware({
    router: appRouter,
    createContext,
    onError({ error, path }: { error: { code: string; message: string }; path?: string }) {
      if (error.code === 'INTERNAL_SERVER_ERROR') {
        logger.error({ err: error, path }, 'tRPC internal error');
      }
    },
  }),
);

// Регистрация фоновых воркеров. Отключаемо через WORKERS_ENABLED=false (отдельный процесс).
if (process.env.WORKERS_ENABLED !== 'false') {
  registerStorageCleanupWorker();
  registerPushSendWorker();
  registerInvoiceReminderWorker();
  registerTicketStatusNotifyWorker();
  registerCalendarReminderWorker();
  registerEmailInboundWorker();
  registerEmailScheduledWorker();
  // Cron-расписание ставится только если явно разрешено (на dev/test обычно не нужно).
  if (process.env.INVOICE_REMINDER_ENABLED === 'true') {
    void enqueueInvoiceReminderSchedule();
  }
  // Напоминания календаря — внутренний push, внешних зависимостей нет:
  // расписание ставим всегда (тик без «созревших» событий — no-op).
  void enqueueCalendarReminderSchedule().catch((err) =>
    logger.warn({ err }, 'calendar-reminder schedule failed'),
  );
  // Отложенная отправка писем — переенкью отложенных задач на старте (Redis мог их потерять).
  void reconcileScheduledSends().catch((err) =>
    logger.warn({ err }, 'email-scheduled reconcile failed'),
  );
  // Приём входящих по IMAP — внешняя зависимость (ящик reg.ru), поэтому расписание
  // ставим только при явном EMAIL_INBOUND_ENABLED=true. На dev дёргаем вручную (email.fetchNow).
  if (process.env.EMAIL_INBOUND_ENABLED === 'true') {
    void enqueueEmailInboundSchedule().catch((err) =>
      logger.warn({ err }, 'email-inbound schedule failed'),
    );
  }
}

const server = app.listen(PORT, HOST, () => {
  logger.info(`API listening on http://${HOST}:${PORT}`);
});

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'shutdown initiated');
  // Перестаём принимать новые соединения и дожидаемся завершения текущих
  // запросов (потолок 10 секунд — затем выходим, не дожидаясь keep-alive).
  await Promise.race([
    new Promise<void>((resolve) => server.close(() => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
  ]);
  await shutdownQueues();
  await shutdownMailer();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
