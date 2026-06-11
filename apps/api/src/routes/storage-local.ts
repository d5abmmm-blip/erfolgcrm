/**
 * Express endpoints локального S3-эмулятора (только при STORAGE_DRIVER=local).
 *
 * PUT /api/v1/storage/put?op=put&key=...&exp=...&sig=...  — приём файла (PUT body).
 * GET /api/v1/storage/get?op=get&key=...&exp=...&sig=...  — отдача файла.
 *
 * Токены HMAC из object-storage.ts (verifyLocalToken). exp в unix-секундах.
 *
 * В production (STORAGE_DRIVER=s3) этот роутер не подключается — клиент льёт прямо
 * в Yandex Object Storage по presigned URL.
 */
import express, { type Router } from 'express';
import { logger } from '../lib/logger';
import { localObjectStorageInternal, verifyLocalToken } from '../lib/object-storage';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

interface QueryShape {
  op: 'put' | 'get';
  key: string;
  exp: number;
  sig: string;
}

function parseQuery(q: Record<string, unknown>, expectedOp: 'put' | 'get'): QueryShape | null {
  const op = String(q.op ?? '');
  const key = String(q.key ?? '');
  const exp = Number(q.exp ?? 0);
  const sig = String(q.sig ?? '');
  if (op !== expectedOp || !key || !sig || !Number.isFinite(exp)) return null;
  return { op, key, exp, sig };
}

export function makeStorageLocalRouter(): Router {
  const router = express.Router();

  // helmet ставит Cross-Origin-Resource-Policy: same-origin глобально.
  // Для presigned URL (cross-origin embed через <img>, fetch PUT с другого порта)
  // нужен cross-origin. Точечно перекрываем на /api/v1/storage/*.
  router.use((_req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
  });

  // PUT: принимаем raw body (вне общего express.json) и пишем на диск.
  router.put('/put', express.raw({ type: '*/*', limit: MAX_UPLOAD_BYTES }), async (req, res) => {
    const q = parseQuery(req.query as Record<string, unknown>, 'put');
    if (!q) return res.status(400).json({ error: 'bad query' });
    if (!verifyLocalToken(q)) return res.status(403).json({ error: 'invalid or expired token' });
    const body = req.body as Buffer;
    if (!body || body.length === 0) return res.status(400).json({ error: 'empty body' });
    const mime = req.header('content-type') ?? 'application/octet-stream';
    try {
      await localObjectStorageInternal.write(q.key, body, mime);
      res.status(204).end();
    } catch (err) {
      logger.error({ err, key: q.key }, 'storage-local PUT failed');
      res.status(500).json({ error: 'write failed' });
    }
  });

  router.get('/get', async (req, res) => {
    const q = parseQuery(req.query as Record<string, unknown>, 'get');
    if (!q) return res.status(400).json({ error: 'bad query' });
    if (!verifyLocalToken(q)) return res.status(403).json({ error: 'invalid or expired token' });
    try {
      const obj = await localObjectStorageInternal.read(q.key);
      if (!obj) return res.status(404).json({ error: 'not found' });
      res.setHeader('content-type', obj.mimeType);
      res.setHeader('cache-control', 'private, max-age=300');
      res.send(obj.data);
    } catch (err) {
      logger.error({ err, key: q.key }, 'storage-local GET failed');
      res.status(500).json({ error: 'read failed' });
    }
  });

  return router;
}
