/**
 * Шаблоны заявок (ticket_templates).
 *
 * Менеджер выбирает «По шаблону» при создании тикета — заполняются дефолтные
 * поля заявки и заранее заготовленные строки наряда (работы / запчасти / расходы).
 *
 * `lines` — jsonb с массивом TicketTemplateLine (см. ниже). Не используем отдельную
 * таблицу строк, потому что:
 *   - шаблон редактируется как единое целое (форма с FieldArray);
 *   - количество шаблонов небольшое (десятки), строк в каждом — единицы;
 *   - не нужны индексы по строкам, нет ссылочной целостности до work_order_lines.
 *
 * Цены хранятся в РУБЛЯХ (целое число), а не копейках — шаблон это не источник
 * правды по деньгам, это начальная подсказка для оператора. unit_price_rub `null`
 * означает «менеджер заполнит вручную при применении».
 */
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { pk, tenantId, timestamps } from './_shared';
import { repairTypeEnum, ticketPriorityEnum } from './tickets';

export interface TicketTemplateLine {
  /** Тип строки наряда (work / part / expense). */
  lineType: 'work' | 'part' | 'expense';
  /** Название работы/запчасти/расхода. Видно клиенту в наряде. */
  name: string;
  /** Единица измерения: «шт», «час», «компл», «км». */
  unit: string;
  /** Количество (numeric-совместимая строка: «1», «0.5», «12.345»). */
  quantity: string;
  /** Цена за единицу в рублях (целое). null — заполнить вручную при применении. */
  unitPriceRub: number | null;
  /** Опц. ссылка на товар склада (для запчастей с фиксированной позицией). */
  inventoryItemId: string | null;
}

export const ticketTemplates = pgTable(
  'ticket_templates',
  {
    id: pk(),
    tenantId: tenantId(),
    /** Короткое имя для выбора («Замена термопасты»). Уникально среди активных в tenant'е. */
    name: varchar('name', { length: 200 }).notNull(),
    /** Описание: что входит, чтобы менеджеру было проще выбрать. */
    description: text('description'),
    /** NULL — не менять у тикета, иначе подставляется при apply. */
    defaultRepairType: repairTypeEnum('default_repair_type'),
    defaultPriority: ticketPriorityEnum('default_priority'),
    /** Оценка трудозатрат в минутах (1..720). NULL — не задавать. */
    defaultEstimatedMinutes: integer('default_estimated_minutes'),
    lines: jsonb('lines')
      .$type<TicketTemplateLine[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Soft archive — не показывать в выборе при создании тикета. */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdByUserId: uuid('created_by_user_id'),
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
  },
  (t) => [
    uniqueIndex('ticket_templates_tenant_name_active_uniq')
      .on(t.tenantId, sql`lower(${t.name})`)
      .where(sql`archived_at IS NULL`),
    index('ticket_templates_tenant_archived_idx').on(t.tenantId, t.archivedAt),
    check(
      'ticket_templates_estimated_minutes_check',
      sql`default_estimated_minutes IS NULL OR (default_estimated_minutes >= 1 AND default_estimated_minutes <= 720)`,
    ),
  ],
);
