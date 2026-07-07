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
import { randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../lib/logger';
import {
  spawnFullDump,
  spawnWinServiceImport,
  verifyFullDumpToken,
  verifyImportToken,
} from '../modules/backup/service';

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

const MAX_IMPORT_BYTES = 80 * 1024 * 1024; // экспорт старой базы — до ~80 МБ

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

  // POST /import?t=&exp=&sig=&dryRun=1 — загрузка старой базы (JSON-экспорт WinServisePro).
  // Тело — сырой JSON-файл. Авторизация — HMAC-токен (директор, requestImportToken).
  // dryRun=1 — сухой прогон (ничего не пишет, только отчёт). Импортёр идемпотентен.
  router.post('/import', express.raw({ type: '*/*', limit: MAX_IMPORT_BYTES }), async (req, res) => {
    const tenantId = asStr(req.query.t);
    const exp = Number(asStr(req.query.exp) || 0);
    const sig = asStr(req.query.sig);
    const dryRun = asStr(req.query.dryRun) === '1';

    if (!verifyImportToken({ tenantId, exp, sig })) {
      return res.status(403).json({ error: 'Недействительный или истёкший токен. Откройте страницу заново.' });
    }
    const body = req.body as Buffer;
    if (!body || body.length === 0) {
      return res.status(400).json({ error: 'Пустой файл.' });
    }
    // Валидируем, что это JSON, до запуска импортёра — понятная ошибка вместо краша.
    try {
      JSON.parse(body.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Файл не похож на JSON-экспорт базы.' });
    }

    const tmpFile = join(tmpdir(), `ws-import-${randomUUID()}.json`);
    try {
      await writeFile(tmpFile, body);
    } catch (err) {
      logger.error({ err }, 'import: не удалось сохранить временный файл');
      return res.status(500).json({ error: 'Не удалось принять файл.' });
    }

    const child = spawnWinServiceImport(tmpFile, { dryRun, tenantId });
    let out = '';
    let errOut = '';
    const cap = (s: string, chunk: Buffer) => (s.length < 64_000 ? s + chunk.toString('utf8') : s);
    child.stdout.on('data', (c: Buffer) => (out = cap(out, c)));
    child.stderr.on('data', (c: Buffer) => (errOut = cap(errOut, c)));

    child.on('error', (err) => {
      logger.error({ err }, 'import: не удалось запустить импортёр');
      void unlink(tmpFile).catch(() => {});
      if (!res.headersSent) res.status(500).json({ error: 'Не удалось запустить импорт.' });
    });

    child.on('close', (code) => {
      void unlink(tmpFile).catch(() => {});
      const report = (out + (errOut ? `\n${errOut}` : '')).trim();
      if (code === 0) {
        res.json({ ok: true, dryRun, report });
      } else {
        logger.error({ code, errOut: errOut.slice(0, 2000) }, 'import: импортёр завершился с ошибкой');
        res.status(422).json({ ok: false, dryRun, error: 'Импорт завершился с ошибкой.', report });
      }
    });
  });

  return router;
}
