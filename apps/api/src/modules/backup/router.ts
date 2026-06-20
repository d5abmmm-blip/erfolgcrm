/**
 * tRPC-роутер раздела «Резервные копии и архив». Только директор.
 *
 * Сами бинарные потоки (дамп, ZIP-архивы) идут не здесь, а по Express-роуту
 * /api/v1/backup/* — tRPC лишь выдаёт короткоживущие HMAC-токены и метаданные.
 */
import { directorProcedure, router } from '../../trpc/trpc';
import { writeAudit } from '../../lib/audit';
import { apiBaseUrl, fullDumpFileName, makeFullDumpToken, resolveBackupExecConfig } from './service';

export const backupRouter = router({
  /**
   * Готовит ссылку на скачивание полной копии базы. Возвращает абсолютный URL
   * download-роута с HMAC-токеном (живёт 5 минут) и имя файла. Сам дамп считается
   * на лету при заходе по ссылке.
   */
  requestFullDump: directorProcedure.mutation(async ({ ctx }) => {
    const cfg = resolveBackupExecConfig();
    const { exp, sig } = makeFullDumpToken(ctx.tenant.id);
    const fileName = fullDumpFileName(cfg);
    const params = new URLSearchParams({
      t: ctx.tenant.id,
      exp: String(exp),
      sig,
      name: fileName,
    });

    await writeAudit(ctx.db, ctx.tenant.id, {
      userId: ctx.session.userId,
      action: 'export',
      entityType: 'database_backup',
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      context: { kind: 'full_dump', fileName },
    });

    return {
      url: `${apiBaseUrl()}/api/v1/backup/download?${params.toString()}`,
      fileName,
      expiresAt: new Date(exp * 1000),
    };
  }),
});
