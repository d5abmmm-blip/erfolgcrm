/**
 * Stage 10'.J — Чек-листы приёма/выдачи техники.
 *
 * Бизнес-цель: фиксировать состояние техники "до" и "после" с фото, чтобы
 * исключать споры с клиентом ("при приёме царапины не было!").
 *
 * intake_checklists — заголовок чек-листа (kind = 'intake' | 'handover').
 * intake_checklist_items — пункты с status [ok|issue|na] + comment + опц. фото.
 */
import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { fkUuid, pk, tenantId } from './_shared';

export const checklistKindEnum = pgEnum('checklist_kind', ['intake', 'handover']);

export const intakeChecklists = pgTable(
  'intake_checklists',
  {
    id: pk(),
    tenantId: tenantId(),
    ticketId: fkUuid('ticket_id'),
    kind: checklistKindEnum('kind').notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull().defaultNow(),
    completedByUserId: uuid('completed_by_user_id'),
    /** ФИО подписавшего со стороны клиента (свободный текст). */
    clientSignatureName: varchar('client_signature_name', { length: 200 }),
    notes: text('notes'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('intake_checklists_tenant_ticket_idx').on(t.tenantId, t.ticketId)],
);

export const intakeChecklistItems = pgTable(
  'intake_checklist_items',
  {
    id: pk(),
    tenantId: tenantId(),
    checklistId: fkUuid('checklist_id'),
    orderIdx: integer('order_idx').notNull(),
    label: varchar('label', { length: 300 }).notNull(),
    /** 'ok' | 'issue' | 'na' — храним как varchar чтобы не плодить enum. */
    status: varchar('status', { length: 20 }).notNull(),
    comment: text('comment'),
    photoAttachmentId: uuid('photo_attachment_id'),
  },
  (t) => [index('intake_checklist_items_tenant_checklist_idx').on(t.tenantId, t.checklistId)],
);
