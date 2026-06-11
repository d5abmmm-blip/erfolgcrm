/**
 * КП (коммерческие предложения) с версиями по заявке
 * (перенос из v1 project_2, таблица `request_kp_versions`).
 *
 * Заявка на стадиях estimate/approval может иметь несколько версий КП:
 * v1 отправили → клиент запросил скидку → v2 → утвердили. История версий
 * сохраняется целиком (для спора с клиентом и аналитики скидок).
 *
 * Инварианты (на уровне service):
 *   • не более одной approved-версии на заявку (approve демотирует прочие approved);
 *   • approved-версию нельзя удалить (источник согласованной суммы);
 *   • version назначается сервером (max+1) — клиент его не передаёт (в v1 передавал, гонки).
 *
 * Суммы — bigint копейки (конвенция v2). Утверждённое КП — источник
 * согласованной оценки; фактические суммы живут в work_orders.
 */
import {
  bigint,
  index,
  pgEnum,
  pgTable,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { fkUuid, pk, tenantId, timestamps } from './_shared';

export const kpStatusEnum = pgEnum('kp_status', [
  'draft',
  'sent',
  'approved',
  'rejected',
  'revision',
]);

export const ticketKpVersions = pgTable(
  'ticket_kp_versions',
  {
    id: pk(),
    tenantId: tenantId(),

    /** Заявка. CASCADE — версии КП без заявки не имеют смысла. */
    ticketId: fkUuid('ticket_id'),

    /** Номер версии в рамках заявки (1, 2, 3…). Назначается сервером. */
    version: integer('version').notNull(),

    status: kpStatusEnum('status').notNull().default('draft'),

    /** Работы и запчасти — копейки. */
    worksAmountKopecks: bigint('works_amount_kopecks', { mode: 'bigint' }).notNull().default(0n),
    partsAmountKopecks: bigint('parts_amount_kopecks', { mode: 'bigint' }).notNull().default(0n),

    /** Текст предложения (что входит, условия). */
    description: text('description').notNull(),

    sentAt: timestamp('sent_at', { withTimezone: true }),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    rejectionReason: text('rejection_reason'),

    /** Автор версии (users.id). Имя резолвится join'ом. */
    createdByUserId: uuid('created_by_user_id'),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('kp_versions_ticket_version_uniq')
      .on(t.tenantId, t.ticketId, t.version)
      .where(sql`deleted_at IS NULL`),
    index('kp_versions_tenant_ticket_idx')
      .on(t.tenantId, t.ticketId)
      .where(sql`deleted_at IS NULL`),
  ],
);
