/**
 * Express-роуты бинарных потоков раздела «Резервные копии».
 *
 *   GET /api/v1/backup/download?t=<tenantId>&exp=<unix>&sig=<hmac>&name=<file>
 *       — стрим полной копии базы (pg_dump -Fc). Авторизация — HMAC-токен,
 *         выданный директор-only процедурой backup.requestFullDump.
 *
 * Почему отдельный роут, а не tRPC: дамп — бинарный поток в десятки/сотни МБ,
 * его нужно стримить, а tRPC (superjson/JSON-RPC) для этого не предназначен.
 */
import express, { type Router } from 'express';
import { logger } from '../lib/logger';
import { spawnFullDump, verifyFullDumpToken } from '../modules/backup/service';

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function makeBackupRouter(): Router {
  const router = express.Router();

  router.get('/download', (req, res) => {
    const tenantId = asStr(req.query.t);
    const exp = Number(asStr(req.query.exp) || 0);
    const sig = asStr(req.query.sig);
    const name = asStr(req.query.name) || 'erfolg-backup.dump';

    if (!verifyFullDumpToken({ tenantId, exp, sig })) {
      return res.status(403).json({ error: 'invalid or expired token' });
    }

    // Имя файла защищаем от инъекции в заголовок (только безопасные символы).
    const safeName = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'erfolg-backup.dump';

    const child = spawnFullDump();
    let stderr = '';
    let failed = false;

    child.stderr.on('data', (chunk: Buffer) => {
      // pg_dump шлёт сюда и ошибки, и прогресс — копим для диагностики (лимит 8 КБ).
      if (stderr.length < 8192) stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      // Не удалось даже запустить процесс (нет docker/pg_dump в PATH и т.п.).
      failed = true;
      logger.error({ err }, 'backup pg_dump spawn failed');
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Не удалось запустить создание копии. Проверьте, что PostgreSQL запущен и доступен.',
        });
      } else {
        res.destroy();
      }
    });

    child.on('close', (code) => {
      if (failed) return;
      if (code !== 0) {
        logger.error({ code, stderr }, 'backup pg_dump exited with error');
        if (!res.headersSent) {
          res.status(500).json({ error: 'Ошибка при создании копии базы.' });
        } else {
          // Заголовки уже ушли (часть файла отдана) — рвём соединение, чтобы клиент
          // увидел оборванную (неполную) загрузку, а не принял битый файл за валидный.
          res.destroy();
        }
      } else {
        res.end();
      }
    });

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('Cache-Control', 'no-store');
    child.stdout.pipe(res);

    // Клиент отменил загрузку — гасим pg_dump, чтобы не висел зря.
    res.on('close', () => {
      if (!child.killed) child.kill();
    });
  });

  return router;
}
