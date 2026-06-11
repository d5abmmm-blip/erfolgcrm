/**
 * Stage 10'.I — Аттестация инженеров.
 *
 * engineer_attestations — выданные допуски инженерам по типам медтехники.
 * Используется для compliance при назначении инженера на заявку (см. tickets/service.ts):
 * если у asset.required_attestation_category задана категория, проверяем что у
 * назначаемого инженера есть НЕ просроченная аттестация по этой категории —
 * иначе предупреждение в ответе диспетчеру (без жёсткой блокировки).
 *
 * Категории — словарь в коде (modules/attestations/categories.ts).
 * В БД храним свободный varchar — на случай редких категорий вне справочника.
 */
import { date, index, pgTable, text, uuid, varchar } from 'drizzle-orm/pg-core';
import { fkUuid, pk, tenantId, timestamps } from './_shared';

export const engineerAttestations = pgTable(
  'engineer_attestations',
  {
    id: pk(),
    tenantId: tenantId(),
    engineerId: fkUuid('engineer_id'),

    /** Категория допуска ("Лабораторное оборудование", "УЗИ" и т.п.). Свободный текст из словаря. */
    category: varchar('category', { length: 100 }).notNull(),
    /** Какая организация выдала. Учебный центр / производитель / Росздравнадзор. */
    issuedBy: varchar('issued_by', { length: 300 }),
    /** № удостоверения / сертификата. */
    certificateNumber: varchar('certificate_number', { length: 100 }),

    /** Дата выдачи (обязательно). */
    issuedAt: date('issued_at').notNull(),
    /** Дата окончания. NULL = бессрочно. */
    validUntil: date('valid_until'),

    /** Опциональный PDF удостоверения (через attachments / presigned PUT). */
    documentAttachmentId: uuid('document_attachment_id'),

    notes: text('notes'),

    ...timestamps,
  },
  (t) => [
    index('engineer_attestations_tenant_engineer_idx').on(t.tenantId, t.engineerId),
    index('engineer_attestations_tenant_category_idx').on(t.tenantId, t.category),
  ],
);
