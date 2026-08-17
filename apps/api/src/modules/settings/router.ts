/**
 * Настройки tenant'а уровня UI.
 *
 * Сейчас здесь — отключаемые разделы (модули) интерфейса. Отключение раздела влияет
 * ТОЛЬКО на навигацию и маршруты фронта: данные и API остаются доступны, поэтому
 * отключение не ломает бизнес-логику. Единый источник правды о доступных для
 * отключения разделах — фронт (apps/web/src/lib/modules.ts); сюда приходят уже
 * валидные ключи, мы их только нормализуем (trim/dedupe/sort) и сохраняем как jsonb.
 *
 *   getDisabledModules — любой залогиненный (нужно всем для фильтра навигации).
 *   setDisabledModules — только директор (раздел общий для всей компании).
 *
 * Текущее значение фронт также получает из auth.me (tenant.disabledModules), чтобы
 * не делать отдельный запрос при загрузке оболочки.
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { tenants, type Db } from '@erfolg/db';
import { authedProcedure, directorProcedure, router } from '../../trpc/trpc';
import { organizationPatchSchema, readOrganization, updateOrganization } from './organization';
import { writeAudit } from '../../lib/audit';

/** Читает отключённые модули tenant'а. tenants — control-plane без RLS, читаем напрямую. */
export async function readDisabledModules(db: Db, tenantId: string): Promise<string[]> {
  const rows = await db
    .select({ disabledModules: tenants.disabledModules })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return rows[0]?.disabledModules ?? [];
}

/**
 * Фича B — читает опт-ин tenant'а на письмо «техника готова к выдаче».
 * По умолчанию true (DB DEFAULT true).
 *
 * ⚠️ СЕЙЧАС ЭТОТ ФЛАГ НИ НА ЧТО НЕ ВЛИЯЕТ. Автоотправка писем клиентам выключена
 * решением владельца (#83): продюсер вырезан из changeStatusCmd, воркер не
 * регистрируется (см. index.ts, «⛔ registerTicketStatusNotifyWorker() НЕ
 * вызывается»). Экран настроек с переключателем убран — он обещал письма,
 * которых не будет, — а флаг, процедуры и воркер оставлены НАМЕРЕННО: владелец
 * сказал «пока не нужны», и вернуть рассылку должно быть дёшево.
 */
export async function readNotifyClientWhenReady(db: Db, tenantId: string): Promise<boolean> {
  const rows = await db
    .select({ enabled: tenants.notifyClientWhenReady })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return rows[0]?.enabled ?? true;
}

export const settingsRouter = router({
  getDisabledModules: authedProcedure.query(({ ctx }) =>
    readDisabledModules(ctx.db, ctx.tenant.id),
  ),

  setDisabledModules: directorProcedure
    .input(z.object({ modules: z.array(z.string().trim().min(1).max(64)).max(64) }))
    .mutation(async ({ ctx, input }) => {
      // Нормализуем: убираем дубли/пустышки, сортируем — детерминированное хранение.
      const normalized = Array.from(
        new Set(input.modules.map((m) => m.trim()).filter(Boolean)),
      ).sort();

      await ctx.db
        .update(tenants)
        .set({ disabledModules: normalized })
        .where(eq(tenants.id, ctx.tenant.id));

      // 152-ФЗ: фиксируем изменение конфигурации директором. action — enum,
      // используем 'update' c entityType='tenant_settings', детали в context.
      await writeAudit(ctx.db, ctx.tenant.id, {
        userId: ctx.session.userId,
        action: 'update',
        entityType: 'tenant_settings',
        entityId: ctx.tenant.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        context: { disabledModules: normalized },
      });

      return { disabledModules: normalized };
    }),

  /**
   * Фича B — опт-ин на авто-уведомление клиента «техника готова к выдаче».
   *   getNotifyClientWhenReady — директор (для страницы Настроек).
   *   setNotifyClientWhenReady — только директор (общая настройка компании).
   */
  getNotifyClientWhenReady: directorProcedure.query(({ ctx }) =>
    readNotifyClientWhenReady(ctx.db, ctx.tenant.id),
  ),

  setNotifyClientWhenReady: directorProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .update(tenants)
        .set({ notifyClientWhenReady: input.enabled })
        .where(eq(tenants.id, ctx.tenant.id));

      // 152-ФЗ: фиксируем изменение конфигурации директором.
      await writeAudit(ctx.db, ctx.tenant.id, {
        userId: ctx.session.userId,
        action: 'update',
        entityType: 'tenant_settings',
        entityId: ctx.tenant.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        context: { notifyClientWhenReady: input.enabled },
      });

      return { enabled: input.enabled };
    }),

  /**
   * Реквизиты организации — то, что печатается в документах.
   *
   *   getOrganization    — ЛЮБОЙ сотрудник. Не только менеджер: акт выполненных
   *     работ, дефектный акт и акт технического состояния инженер печатает с
   *     телефона, и шапка с наименованием, ИНН и фамилией директора нужна ему
   *     ровно так же. Секрета здесь нет — эти реквизиты стоят на каждом счёте,
   *     который уходит клиенту.
   *   updateOrganization — только директор: это реквизиты компании целиком.
   */
  getOrganization: authedProcedure.query(({ ctx }) => readOrganization(ctx.db, ctx.tenant.id)),

  updateOrganization: directorProcedure
    .input(organizationPatchSchema)
    .mutation(async ({ ctx, input }) => {
      await updateOrganization(ctx.db, ctx.tenant.id, input);

      // 152-ФЗ: фиксируем изменение конфигурации директором. Пишем ИМЕНА
      // изменённых полей, а не значения: банковский счёт в журнале не нужен.
      await writeAudit(ctx.db, ctx.tenant.id, {
        userId: ctx.session.userId,
        action: 'update',
        entityType: 'tenant_settings',
        entityId: ctx.tenant.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        context: { organizationFields: Object.keys(input).sort() },
      });

      return readOrganization(ctx.db, ctx.tenant.id);
    }),
});
