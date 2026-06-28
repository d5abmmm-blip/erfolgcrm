/**
 * Заявки (tickets), их хронология (ticket_events), наряды (work_orders),
 * строки нарядов (work_order_lines) и сквозные счётчики номеров (tenant_counters).
 *
 * Бизнес-модель — на основе реальных бланков ООО Эрфольг (memory/project_real_documents.md):
 *   1. Регистрация заявки → ticket с уникальным сквозным номером per tenant.
 *   2. Один наряд (work_order) на одну заявку (1:1).
 *   3. Сквозная нумерация: tickets.ticket_number == work_orders.order_number.
 *   4. work_orders.total_amount_kopecks материализован — пересчитывается при
 *      каждом insert/update/delete строки (work_order_lines), см. work-orders/service.ts.
 *
 * Все денежные суммы — bigint в копейках (избегаем float-ошибок).
 */
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { fkUuid, pk, tenantId, timestamps } from './_shared';

/** Зеркало TicketStatus из @erfolg/shared */
export const ticketStatusEnum = pgEnum('ticket_status', [
  'received',
  'diagnostics',
  'estimate',
  'approval',
  'in_progress',
  'act_pending',
  'closed',
  'cancelled',
]);

/** Зеркало TicketSource из @erfolg/shared */
export const ticketSourceEnum = pgEnum('ticket_source', [
  'call',
  'telegram',
  'email',
  'manual',
  'web_form',
]);

/** Зеркало IntakeMethod из @erfolg/shared */
export const intakeMethodEnum = pgEnum('intake_method', [
  'onsite_visit',
  'brought_in',
  'pickup',
]);

/** Зеркало TicketPriority */
export const ticketPriorityEnum = pgEnum('ticket_priority', [
  'low',
  'normal',
  'high',
  'urgent',
]);

/** Зеркало RepairType: paid / warranty / service_contract */
export const repairTypeEnum = pgEnum('repair_type', [
  'paid',
  'warranty',
  'service_contract',
]);

export const ticketEventTypeEnum = pgEnum('ticket_event_type', [
  'created',
  'status_change',
  'assignment_change',
  'priority_change',
  'sla_change',
  'note',
  'document_printed',
]);

export const workOrderLineTypeEnum = pgEnum('work_order_line_type', [
  'work',
  'part',
  'expense',
]);

export const vatRateEnum = pgEnum('vat_rate', ['0', '5', '10', '20', 'without_vat']);

/**
 * Сквозная нумерация per tenant per kind per year.
 * UPSERT с RETURNING last_value атомарен, не страдает от concurrent inserts.
 */
export const tenantCounters = pgTable(
  'tenant_counters',
  {
    tenantId: tenantId(),
    kind: varchar('kind', { length: 32 }).notNull(),
    year: integer('year').notNull(),
    lastValue: integer('last_value').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.kind, t.year] })],
);

export const tickets = pgTable(
  'tickets',
  {
    id: pk(),
    tenantId: tenantId(),

    /** Сквозной номер вида "T-2026-000017". Уникален в пределах tenant. */
    ticketNumber: varchar('ticket_number', { length: 30 }).notNull(),

    /** Code-128 значение для физического ярлыка. Печатается на акте приёма. */
    barcode: varchar('barcode', { length: 64 }).notNull(),

    /** Кто заказчик. RESTRICT — нельзя удалить клиента, на котором висит заявка. */
    clientId: fkUuid('client_id'),
    /** Какое оборудование. Опционально (бывают сервисные заявки без привязки). */
    assetId: uuid('asset_id'),
    /** Кто из клиники подал заявку (FK на contacts). */
    contactId: uuid('contact_id'),
    /**
     * Этап 6.B: ссылка на действующий контракт. Опционально для коммерческих юрлиц/физлиц,
     * обязательно для бюджетников (валидация в tickets/service.ts). SET NULL при удалении контракта.
     */
    contractId: uuid('contract_id'),

    source: ticketSourceEnum('source').notNull().default('call'),
    intakeMethod: intakeMethodEnum('intake_method').notNull().default('brought_in'),
    repairType: repairTypeEnum('repair_type').notNull().default('paid'),
    priority: ticketPriorityEnum('priority').notNull().default('normal'),
    status: ticketStatusEnum('status').notNull().default('received'),

    /** Симптом со слов клиента. PII не считается (не привязан к физлицу напрямую). */
    symptom: text('symptom'),
    notes: text('notes'),

    /** Назначенные сотрудники. SET NULL при удалении пользователя. */
    assignedDispatcherId: uuid('assigned_dispatcher_id'),
    assignedEngineerId: uuid('assigned_engineer_id'),

    /** Когда заявка зарегистрирована (отдельно от created_at для юр. чистоты). */
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    /** Дедлайн SLA — целевая дата закрытия. */
    slaTargetAt: timestamp('sla_target_at', { withTimezone: true }),
    /** Срок, обещанный клиенту (может отличаться от SLA). */
    deadlineAt: timestamp('deadline_at', { withTimezone: true }),

    /**
     * Stage 11 — График загрузки инженеров.
     * Когда заявка запланирована (drag&drop в календаре диспетчера).
     * NULL — не запланирована (или снята с расписания через unschedule).
     */
    scheduledStartAt: timestamp('scheduled_start_at', { withTimezone: true }),
    /** Запланированный конец работы. Может быть NULL даже если start задан. */
    scheduledEndAt: timestamp('scheduled_end_at', { withTimezone: true }),
    /** Оценка трудозатрат в минутах (15..720). Для UI. */
    estimatedMinutes: integer('estimated_minutes'),

    closedAt: timestamp('closed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),

    /**
     * Флаг «Ждём запчасть» — заявка стоит из-за ожидания детали (не вина инженера).
     * Это пометка, НЕ статус: статус заявки продолжает жить своей жизнью, а флаг лишь
     * подсвечивает причину простоя менеджеру (бейдж в списке/канбане + фильтр).
     */
    waitingForPart: boolean('waiting_for_part').notNull().default(false),
    /** Что именно ждём (деталь / поставщик / срок). Опционально. */
    waitingForPartNote: text('waiting_for_part_note'),

    /**
     * Фича B — guard идемпотентности авто-уведомления клиента «техника готова».
     * Заполняется при первой успешной отправке письма «готово к выдаче» (статус
     * act_pending). Пока не NULL — повторно письмо «готово» не шлём.
     */
    readyNotifiedAt: timestamp('ready_notified_at', { withTimezone: true }),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('tickets_tenant_number_uniq').on(t.tenantId, t.ticketNumber),
    unique('tickets_barcode_unique').on(t.barcode),
    index('tickets_tenant_status_idx').on(t.tenantId, t.status),
    index('tickets_tenant_client_idx').on(t.tenantId, t.clientId),
    index('tickets_tenant_asset_idx').on(t.tenantId, t.assetId),
    index('tickets_tenant_engineer_idx').on(t.tenantId, t.assignedEngineerId),
    index('tickets_tenant_received_idx').on(t.tenantId, t.receivedAt),
    index('tickets_tenant_contract_idx').on(t.tenantId, t.contractId),
    /**
     * Stage 11 — частичные индексы для графика инженеров.
     * Партиальный WHERE экономит место (большинство тикетов без расписания).
     */
    index('tickets_engineer_schedule_idx')
      .on(t.tenantId, t.assignedEngineerId, t.scheduledStartAt)
      .where(sql`scheduled_start_at IS NOT NULL`),
    index('tickets_schedule_window_idx')
      .on(t.tenantId, t.scheduledStartAt)
      .where(sql`scheduled_start_at IS NOT NULL`),
    /** closed_at заполнен ⟺ status='closed'; cancelled_at — для status='cancelled' */
    check(
      'tickets_closed_consistency',
      sql`(status = 'closed') = (closed_at IS NOT NULL)`,
    ),
    check(
      'tickets_cancelled_consistency',
      sql`(status = 'cancelled') = (cancelled_at IS NOT NULL)`,
    ),
    check(
      'tickets_schedule_consistency',
      sql`scheduled_end_at IS NULL OR scheduled_start_at IS NULL OR scheduled_end_at >= scheduled_start_at`,
    ),
  ],
);

export interface TicketEventPayload {
  from?: unknown;
  to?: unknown;
  comment?: string;
  documentKind?: 'intake_act' | 'invoice' | 'work_act' | 'defect_act';
  /** Поле выводится только для assignment_change */
  role?: 'engineer' | 'dispatcher';
}

/** Append-only хронология. Никаких update/delete. */
export const ticketEvents = pgTable(
  'ticket_events',
  {
    id: pk(),
    tenantId: tenantId(),
    ticketId: fkUuid('ticket_id'),
    userId: uuid('user_id'),
    type: ticketEventTypeEnum('type').notNull(),
    payload: jsonb('payload').$type<TicketEventPayload>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ticket_events_tenant_ticket_idx').on(t.tenantId, t.ticketId, t.createdAt),
  ],
);

/**
 * Один наряд на заявку (UNIQUE по ticket_id).
 * Денежные итоги материализованы — пересчитываются в одной транзакции с insert/update/delete
 * строки (см. work-orders/service.ts: recalcTotals).
 */
export const workOrders = pgTable(
  'work_orders',
  {
    id: pk(),
    tenantId: tenantId(),
    ticketId: fkUuid('ticket_id'),

    /** Тот же что tickets.ticket_number — сквозная нумерация документов. */
    orderNumber: varchar('order_number', { length: 30 }).notNull(),

    engineerId: uuid('engineer_id'),

    diagnosis: text('diagnosis'),
    repairDescription: text('repair_description'),
    recommendation: text('recommendation'),

    vatRate: vatRateEnum('vat_rate').notNull().default('5'),

    /** Все суммы в копейках — bigint, чтобы избежать float-ошибок. */
    worksAmountKopecks: bigint('works_amount_kopecks', { mode: 'bigint' }).notNull().default(0n),
    partsAmountKopecks: bigint('parts_amount_kopecks', { mode: 'bigint' }).notNull().default(0n),
    expensesAmountKopecks: bigint('expenses_amount_kopecks', { mode: 'bigint' }).notNull().default(0n),
    totalAmountKopecks: bigint('total_amount_kopecks', { mode: 'bigint' }).notNull().default(0n),
    /**
     * Этап 5: материализованная сумма платежей по этой заявке.
     * Пересчитывается в payments/service.ts при insert/delete payment в той же транзакции.
     */
    paidAmountKopecks: bigint('paid_amount_kopecks', { mode: 'bigint' }).notNull().default(0n),
    /**
     * Этап 8.C: материализованная себестоимость и маржа.
     * cost = SUM(line.cost_per_unit × line.quantity) по строкам наряда.
     * margin = total - cost (может быть отрицательным).
     * Пересчитываются в work-orders/repository.ts:recalcTotals в той же транзакции с upsert/delete.
     */
    costAmountKopecks: bigint('cost_amount_kopecks', { mode: 'bigint' }).notNull().default(0n),
    marginAmountKopecks: bigint('margin_amount_kopecks', { mode: 'bigint' }).notNull().default(0n),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('work_orders_ticket_uniq').on(t.tenantId, t.ticketId),
    index('work_orders_tenant_engineer_idx').on(t.tenantId, t.engineerId),
  ],
);

export const workOrderLines = pgTable(
  'work_order_lines',
  {
    id: pk(),
    tenantId: tenantId(),
    workOrderId: fkUuid('work_order_id'),

    lineType: workOrderLineTypeEnum('line_type').notNull(),
    name: varchar('name', { length: 500 }).notNull(),
    /** Единица измерения: «шт», «час», «компл», «км». Plain string. */
    unit: varchar('unit', { length: 20 }).notNull().default('шт'),
    quantity: numeric('quantity', { precision: 10, scale: 3 }).notNull().default('1'),
    unitPriceKopecks: bigint('unit_price_kopecks', { mode: 'bigint' }).notNull().default(0n),
    /** Материализованное qty * unit_price (хранится для consistency с totals). */
    amountKopecks: bigint('amount_kopecks', { mode: 'bigint' }).notNull().default(0n),

    /** Кто из инженеров выполнил работу (nullable для part/expense). */
    engineerId: uuid('engineer_id'),
    comment: text('comment'),

    /**
     * Этап 5: ссылка на товар склада (только для lineType='part').
     * SET NULL при удалении item — строка наряда сохраняет историю с name.
     */
    inventoryItemId: uuid('inventory_item_id'),

    /**
     * Этап 8.C: snapshot себестоимости единицы (копейки).
     * Источник определяется типом строки, см. work-orders/repository.ts:resolveLineCost.
     * Не меняется после создания строки (бухгалтерская инвариантность).
     */
    costPerUnitKopecks: bigint('cost_per_unit_kopecks', { mode: 'bigint' }).notNull().default(0n),

    /** Порядок отображения в наряде. */
    orderIdx: integer('order_idx').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('work_order_lines_tenant_order_idx').on(t.tenantId, t.workOrderId, t.orderIdx),
  ],
);
