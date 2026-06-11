/**
 * Этап 6.B — контракты с клиентами.
 *
 * Бизнес-модель:
 *   • service  — рамочный сервисный договор. Ссылается из tickets.contract_id.
 *                Для бюджетников (clients.subtype='budget') — обязателен по 44-ФЗ
 *                (валидация на уровне сервиса tickets, не БД, потому что бюджетные сделки
 *                разовые тоже допустимы при правильной квалификации закупки).
 *   • one_time — разовый договор под одну заявку.
 *
 * Условия договора лежат в terms_json (jsonb) — free-form в БД, типизация на DTO-уровне.
 * Скан подписанного экземпляра — через attachments (kind='contract_signed', reference_type='contract').
 *
 * vat_rate enum переиспользуется из tickets.ts (Этап 3).
 */
import {
  check,
  date,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { fkUuid, pk, tenantId, timestamps } from './_shared';
import { vatRateEnum } from './tickets';

export const contractTypeEnum = pgEnum('contract_type', ['service', 'one_time']);
export const contractStatusEnum = pgEnum('contract_status', [
  'draft',
  'active',
  'expired',
  'terminated',
]);

/**
 * Условия договора. Произвольные числа, чтобы не плодить колонки —
 * шаблон PDF читает только нужные поля.
 */
export interface ContractTerms {
  /** Срок выполнения работ в днях (от заявки до акта). */
  performanceDays?: number;
  /** Гарантия на работу в месяцах. */
  warrantyMonths?: number;
  /** Процент предоплаты (0–100). */
  prepaymentPercent?: number;
  /** Сколько дней даётся клиенту на оплату после акта. */
  paymentDueDays?: number;
  /** Штраф за просрочку этапа: % от стоимости этапа. */
  performancePenaltyPercent?: number;
  /** Пеня за просрочку оплаты: % в день. */
  paymentPenaltyDailyPercent?: number;
  /** Произвольный комментарий к условиям. */
  notes?: string;
}

export const contracts = pgTable(
  'contracts',
  {
    id: pk(),
    tenantId: tenantId(),
    clientId: fkUuid('client_id'),

    /** Свободный ввод, уникален в пределах живых записей одного tenant'а. */
    contractNumber: varchar('contract_number', { length: 50 }).notNull(),
    contractDate: date('contract_date').notNull(),

    type: contractTypeEnum('type').notNull().default('service'),
    vatRate: vatRateEnum('vat_rate').notNull().default('5'),
    status: contractStatusEnum('status').notNull().default('active'),

    validFrom: date('valid_from'),
    validUntil: date('valid_until'),

    /**
     * Условия договора (см. ContractTerms). Default '{}' позволяет создавать
     * черновик без заполнения — терминальная UI догадается о значениях.
     */
    termsJson: jsonb('terms_json').$type<ContractTerms>().notNull().default(sql`'{}'::jsonb`),

    /** object_key подписанного скана (см. attachments). */
    signedPdfObjectKey: varchar('signed_pdf_object_key', { length: 500 }),

    notes: text('notes'),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('contracts_tenant_number_uniq')
      .on(t.tenantId, t.contractNumber)
      .where(sql`deleted_at IS NULL`),
    index('contracts_tenant_client_idx')
      .on(t.tenantId, t.clientId)
      .where(sql`deleted_at IS NULL`),
    index('contracts_tenant_status_idx')
      .on(t.tenantId, t.status)
      .where(sql`deleted_at IS NULL`),
    check(
      'contracts_validity_range',
      sql`valid_from IS NULL OR valid_until IS NULL OR valid_until >= valid_from`,
    ),
  ],
);
