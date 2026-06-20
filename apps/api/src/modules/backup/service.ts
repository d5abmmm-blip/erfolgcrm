/**
 * Резервные копии и архив — серверное ядро.
 *
 * Две независимые возможности (см. router.ts / routes/backup.ts):
 *   1. Полная копия всей базы — pg_dump в custom-формате (-Fc), стрим в браузер.
 *   2. Архив по годам — экспорт/импорт связного подграфа данных за год (см. archive.ts).
 *
 * Запуск pg_dump/pg_restore. На рабочей машине заказчика API — это процесс на хосте
 * (Windows), а PostgreSQL живёт в Docker-контейнере `erfolgcrm-postgres-dev`. Поэтому
 * по умолчанию мы дёргаем дамп ВНУТРИ контейнера через `docker exec` — там гарантированно
 * та же версия pg_dump, что и сервер, и локальный trust-доступ под owner-пользователем
 * (ровно как делает scripts/backup-dev.ps1). Для прод-окружения, где pg_dump доступен
 * процессу напрямую, есть режим 'direct' (BACKUP_EXEC_MODE=direct).
 *
 * Скачивание файла идёт по отдельному Express-роуту (не через tRPC: tRPC — JSON-RPC,
 * для бинарного потока в десятки/сотни МБ не годится). Роут авторизуется коротким
 * HMAC-токеном, который выдаёт директор-only процедура backup.requestFullDump.
 */
import { spawn } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface BackupExecConfig {
  mode: 'docker' | 'direct';
  /** Имя docker-контейнера PostgreSQL (режим docker). */
  container: string;
  /** Пользователь БД для дампа — нужен owner/superuser, а не ограниченный app_runtime. */
  user: string;
  /** Имя базы. */
  database: string;
  /** Параметры прямого подключения (режим direct). */
  host: string;
  port: string;
  password: string;
}

/**
 * Собирает конфиг запуска из окружения. DATABASE_URL — источник правды про имя базы,
 * хост и пароль; имя контейнера и owner-пользователь задаются отдельно (под дамп нужен
 * привилегированный пользователь, которым приложение в обычной работе не подключается).
 */
export function resolveBackupExecConfig(): BackupExecConfig {
  const isProd = process.env.NODE_ENV === 'production';
  const url = process.env.DATABASE_URL ?? 'postgresql://app_runtime:app_runtime_dev_only@localhost:5432/erfolg_dev';

  let host = 'localhost';
  let port = '5432';
  let database = isProd ? 'erfolg_prod' : 'erfolg_dev';
  let password = '';
  try {
    const u = new URL(url);
    host = u.hostname || host;
    port = u.port || port;
    const path = decodeURIComponent(u.pathname.replace(/^\//, ''));
    if (path) database = path;
    password = decodeURIComponent(u.password || '');
  } catch {
    // Невалидный URL — остаёмся на дефолтах (dev).
  }

  return {
    mode: (process.env.BACKUP_EXEC_MODE as 'docker' | 'direct' | undefined) ?? (isProd ? 'direct' : 'docker'),
    container: process.env.BACKUP_PG_CONTAINER ?? `erfolgcrm-postgres-${isProd ? 'prod' : 'dev'}`,
    user: process.env.BACKUP_PG_SUPERUSER ?? 'erfolg',
    database: process.env.BACKUP_PG_DB ?? database,
    host,
    port,
    password: process.env.BACKUP_PG_PASSWORD ?? password,
  };
}

/** Базовый URL API для абсолютных download-ссылок (как в object-storage). */
export function apiBaseUrl(): string {
  return process.env.API_PUBLIC_URL ?? `http://localhost:${process.env.API_PORT ?? '3030'}`;
}

// ───────── HMAC-токены для download-роута ─────────

function tokenSecret(): string {
  return (
    process.env.BACKUP_TOKEN_SECRET ??
    process.env.SESSION_SECRET ??
    'dev_only_backup_secret_replace_in_prod'
  );
}

function signBackup(tenantId: string, expEpochSec: number): string {
  return createHmac('sha256', tokenSecret()).update(`backup-full:${tenantId}:${expEpochSec}`).digest('hex');
}

export function makeFullDumpToken(tenantId: string, ttlSeconds = 5 * 60): { exp: number; sig: string } {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return { exp, sig: signBackup(tenantId, exp) };
}

export function verifyFullDumpToken(args: { tenantId: string; exp: number; sig: string }): boolean {
  if (!args.tenantId || !args.sig || !Number.isFinite(args.exp)) return false;
  if (args.exp * 1000 < Date.now()) return false;
  const expected = signBackup(args.tenantId, args.exp);
  if (expected.length !== args.sig.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(args.sig, 'hex'));
  } catch {
    return false;
  }
}

/** Человекочитаемое имя файла дампа: erfolg-backup-2026-06-17-1530.dump */
export function fullDumpFileName(cfg = resolveBackupExecConfig(), now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${cfg.database}-backup-${stamp}.dump`;
}

// ───────── Запуск pg_dump ─────────

/** Аргументы pg_dump для полной копии (custom-формат, без owner/privileges — переносимо). */
function pgDumpArgs(cfg: BackupExecConfig): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  const common = ['--no-owner', '--no-privileges', '--format=custom'];
  if (cfg.mode === 'docker') {
    return {
      cmd: 'docker',
      args: ['exec', cfg.container, 'pg_dump', '-U', cfg.user, ...common, cfg.database],
      env: process.env,
    };
  }
  return {
    cmd: 'pg_dump',
    args: ['-h', cfg.host, '-p', cfg.port, '-U', cfg.user, ...common, cfg.database],
    env: { ...process.env, PGPASSWORD: cfg.password },
  };
}

/**
 * Запускает pg_dump и отдаёт дочерний процесс. Вызывающий пайпит stdout в HTTP-ответ
 * или файл. stderr копится в onStderr для диагностики (pg_dump шлёт туда и прогресс).
 */
export function spawnFullDump(cfg = resolveBackupExecConfig()) {
  const { cmd, args, env } = pgDumpArgs(cfg);
  return spawn(cmd, args, { env, windowsHide: true });
}
