import 'dotenv/config';
import express from 'express';
import pino from 'pino';

const logger = pino({
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

/**
 * Control Plane — публичный SaaS-портал.
 * Здесь будут: регистрация tenant'ов, биллинг (ЮKassa), личный кабинет владельца.
 * На этапе 0 — заглушка с health-эндпоинтом.
 * Полная реализация — на этапе 10.
 */
const app = express();
const PORT = Number(process.env.CP_PORT ?? 3001);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'control-plane', stage: 0 });
});

app.listen(PORT, () => {
  logger.info(`Control Plane listening on http://localhost:${PORT}`);
});
