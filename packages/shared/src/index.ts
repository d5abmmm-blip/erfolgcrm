/**
 * Общие zod-схемы и типы, используются и frontend, и backend.
 * На этапе 0 — стартовый набор: роли, статусы заявок.
 */
import { z } from 'zod';

export const UserRole = z.enum(['director', 'dispatcher', 'engineer']);
export type UserRole = z.infer<typeof UserRole>;

/**
 * Должности сотрудников — фиксированный перечень для выбора при заведении
 * пользователя (произвольный ввод запрещён). Значение печатается в подписях
 * документов (договоры, акты), поэтому храним сразу человекочитаемый текст.
 * Чтобы изменить набор должностей — правится только этот список.
 */
export const StaffPosition = z.enum([
  'Генеральный директор',
  'Директор',
  'Диспетчер',
  'Инженер',
  'Старший инженер',
  'Бухгалтер',
]);
export type StaffPosition = z.infer<typeof StaffPosition>;
/** Массив значений должностей для рендера выпадающего списка на фронте. */
export const STAFF_POSITIONS = StaffPosition.options;

export const TicketStatus = z.enum([
  'received',
  'diagnostics',
  'estimate',
  'approval',
  'in_progress',
  'act_pending',
  'closed',
  'cancelled',
]);
export type TicketStatus = z.infer<typeof TicketStatus>;

export const IntakeMethod = z.enum(['onsite_visit', 'brought_in', 'pickup']);
export type IntakeMethod = z.infer<typeof IntakeMethod>;

export const TicketSource = z.enum(['call', 'telegram', 'email', 'manual', 'web_form']);
export type TicketSource = z.infer<typeof TicketSource>;

/** Класс риска медицинского изделия по Росздравнадзору */
export const MedDeviceRiskClass = z.enum(['1', '2a', '2b', '3']);
export type MedDeviceRiskClass = z.infer<typeof MedDeviceRiskClass>;

export const SubscriptionPlan = z.enum(['start', 'pro', 'corp']);
export type SubscriptionPlan = z.infer<typeof SubscriptionPlan>;

/** Тип клиента: юридическое или физическое лицо */
export const ClientType = z.enum(['legal', 'individual']);
export type ClientType = z.infer<typeof ClientType>;

/** Подтип юрлица: коммерческое или бюджетное (ГБУ/ГАУ/ФГБУ и т.п.) */
export const ClientSubtype = z.enum(['commercial', 'budget']);
export type ClientSubtype = z.infer<typeof ClientSubtype>;

export const ClientStatus = z.enum(['active', 'archived']);
export type ClientStatus = z.infer<typeof ClientStatus>;

/** Жизненный цикл единицы техники */
export const AssetLifecycleStatus = z.enum([
  'in_service',
  'in_repair',
  'awaiting_parts',
  'reserve',
  'decommissioned',
]);
export type AssetLifecycleStatus = z.infer<typeof AssetLifecycleStatus>;

/** Типы событий в хронологии техники (event-sourcing-lite) */
export const AssetEventType = z.enum([
  'created',
  'status_change',
  'owner_change',
  'location_change',
  'note',
]);
export type AssetEventType = z.infer<typeof AssetEventType>;

/** Приоритет заявки */
export const TicketPriority = z.enum(['low', 'normal', 'high', 'urgent']);
export type TicketPriority = z.infer<typeof TicketPriority>;

/**
 * Часы срока реакции (SLA) по приоритету заявки: дедлайн = момент приёма + эти часы.
 * Это разумные дефолты — при необходимости меняются здесь одной строкой (общий источник
 * истины для сервера и клиента, чтобы срок в списке и на форме совпадал).
 */
export const SLA_HOURS_BY_PRIORITY: Record<TicketPriority, number> = {
  urgent: 4,
  high: 8,
  normal: 24,
  low: 72,
};

/** Целевой срок SLA от момента приёма заявки по её приоритету. */
export function computeSlaTargetAt(receivedAt: Date, priority: TicketPriority): Date {
  return new Date(receivedAt.getTime() + SLA_HOURS_BY_PRIORITY[priority] * 60 * 60 * 1000);
}

/** Тип ремонта (повторяет реальный бланк ООО Эрфольг) */
export const RepairType = z.enum(['paid', 'warranty', 'service_contract']);
export type RepairType = z.infer<typeof RepairType>;

/**
 * Структурная причина простоя заявки — «почему техника стоит» (для доски).
 * waiting_client_approval и ready_for_pickup обычно ВЫВОДЯТСЯ из статуса
 * (estimate/approval, act_pending) и в колонке tickets.blocked_reason не хранятся,
 * но входят в перечень ради единого ключа колонок доски.
 */
export const TicketBlockedReason = z.enum([
  'waiting_part',
  'waiting_client_approval',
  'waiting_payment',
  'waiting_management_decision',
  'no_free_engineer',
  'waiting_delivery',
  'ready_for_pickup',
]);
export type TicketBlockedReason = z.infer<typeof TicketBlockedReason>;

/** Типы событий в хронологии заявки */
export const TicketEventType = z.enum([
  'created',
  'status_change',
  'assignment_change',
  'priority_change',
  'sla_change',
  'note',
  'document_printed',
]);
export type TicketEventType = z.infer<typeof TicketEventType>;

/** Тип строки наряда: работа / запчасть / прочие расходы (например командировка) */
export const WorkOrderLineType = z.enum(['work', 'part', 'expense']);
export type WorkOrderLineType = z.infer<typeof WorkOrderLineType>;

/** Ставка НДС. У ООО Эрфольг — нетипичная льготная 5% (см. memory/project_real_documents.md). */
export const VatRate = z.enum(['0', '5', '10', '20', 'without_vat']);
export type VatRate = z.infer<typeof VatRate>;

/** Этап 5 — Склад. Тип движения по партии. */
export const InventoryMovementKind = z.enum([
  'inbound',
  'outbound',
  'adjustment',
  'writeoff',
]);
export type InventoryMovementKind = z.infer<typeof InventoryMovementKind>;

/** Этап 5 — Склад. К чему привязано движение. */
export const InventoryReferenceType = z.enum(['work_order_line', 'manual']);
export type InventoryReferenceType = z.infer<typeof InventoryReferenceType>;

/** Этап 5 — ТО. Плановое (по графику) или внеплановое (срочное). */
export const MaintenanceKind = z.enum(['planned', 'urgent']);
export type MaintenanceKind = z.infer<typeof MaintenanceKind>;

/** Этап 5 — Финансы. Способ оплаты. */
export const PaymentMethod = z.enum(['cash', 'card', 'bank_transfer']);
export type PaymentMethod = z.infer<typeof PaymentMethod>;

/**
 * Этап 8 — Финансы. Жизненный цикл счёта.
 *   draft           — черновик, ещё не выставлен клиенту.
 *   issued          — выставлен, клиент получил, ждёт оплату.
 *   partially_paid  — оплачен частично (paid > 0, но < total).
 *   paid            — оплачен полностью (paid >= total).
 *   overdue         — просрочен (issued/partially_paid + due_date < today). Ставит ночной cron.
 *   cancelled       — отменён (можно из любого статуса; soft-cancel, не delete).
 */
export const InvoiceStatus = z.enum([
  'draft',
  'issued',
  'partially_paid',
  'paid',
  'overdue',
  'cancelled',
]);
export type InvoiceStatus = z.infer<typeof InvoiceStatus>;

/**
 * Лиды — воронка продаж (перенос из v1 project_2).
 * Стадия лида: new → contacted → proposal → negotiation → won/lost.
 */
export const LeadStatus = z.enum([
  'new',
  'contacted',
  'proposal',
  'negotiation',
  'won',
  'lost',
]);
export type LeadStatus = z.infer<typeof LeadStatus>;

/** Источник лида. */
export const LeadSource = z.enum(['cold_call', 'referral', 'tender', 'website', 'other']);
export type LeadSource = z.infer<typeof LeadSource>;

/** Причина проигрыша лида (заполняется при переходе в lost). */
export const LeadLostReason = z.enum([
  'price',
  'competitor',
  'no_need',
  'no_response',
  'other',
]);
export type LeadLostReason = z.infer<typeof LeadLostReason>;

/** Тип гарантии на технику (перенос из v1): заводская / сервисная / расширенная. */
export const WarrantyType = z.enum(['manufacturer', 'service', 'extended']);
export type WarrantyType = z.infer<typeof WarrantyType>;

/**
 * Действующий статус гарантии — ВЫЧИСЛЯЕТСЯ на чтении (в БД хранится только voided):
 * expiring = осталось ≤ 30 дней.
 */
export const WarrantyStatus = z.enum(['active', 'expiring', 'expired', 'voided']);
export type WarrantyStatus = z.infer<typeof WarrantyStatus>;

/** Статус версии КП (перенос из v1): draft → sent → approved/rejected/revision. */
export const KpStatus = z.enum(['draft', 'sent', 'approved', 'rejected', 'revision']);
export type KpStatus = z.infer<typeof KpStatus>;

/** Трейд-ин: состояние принятой б/у техники. */
export const TradeInCondition = z.enum(['excellent', 'good', 'fair', 'poor']);
export type TradeInCondition = z.infer<typeof TradeInCondition>;

/** Трейд-ин: жизненный цикл. sold выставляется только через complete. */
export const TradeInStatus = z.enum(['received', 'assessed', 'in_stock', 'sold', 'scrapped']);
export type TradeInStatus = z.infer<typeof TradeInStatus>;

/** Дорожная карта: квартал/категория/приоритет цели. */
export const RoadmapQuarter = z.enum(['Q1', 'Q2', 'Q3', 'Q4']);
export type RoadmapQuarter = z.infer<typeof RoadmapQuarter>;

export const RoadmapCategory = z.enum(['revenue', 'clients', 'processes', 'team', 'product']);
export type RoadmapCategory = z.infer<typeof RoadmapCategory>;

export const RoadmapPriority = z.enum(['high', 'medium', 'low']);
export type RoadmapPriority = z.infer<typeof RoadmapPriority>;

/* ─────────────────── Трек ремонта «как посылка» (фича №3) ─────────────────── */

/**
 * Клиентские стадии трека — понятная клиенту «дорожка» ремонта (как этапы доставки
 * посылки). Внутренние статусы «складываются» в 5 стадий; cancelled — отдельная
 * концовка (не стадия). Стадии «Смета/Согласование» убраны из потока — устаревшие
 * статусы estimate/approval (если попадутся в истории) показываются как «Диагностика».
 */
export type TrackStageKey =
  | 'received'
  | 'diagnostics'
  | 'repair'
  | 'ready'
  | 'issued';

export interface TrackStageDef {
  key: TrackStageKey;
  /** Подпись, которую видит клиент. */
  label: string;
  /** Короткое пояснение под подписью. */
  description: string;
}

/** Порядок стадий трека (как этапы доставки посылки). Источник истины подписей. */
export const TRACK_STAGES: readonly TrackStageDef[] = [
  { key: 'received', label: 'Приняли технику', description: 'Заявка зарегистрирована' },
  { key: 'diagnostics', label: 'Диагностика', description: 'Ищем причину неисправности' },
  { key: 'repair', label: 'Ремонт', description: 'Инженер выполняет работы' },
  { key: 'ready', label: 'Готово к выдаче', description: 'Можно забирать' },
  { key: 'issued', label: 'Техника выдана', description: 'Ремонт завершён' },
];

/**
 * Внутренний статус заявки → индекс клиентской стадии трека.
 * cancelled → null (обрабатывается отдельно как «Заявка отменена»).
 */
export function ticketStatusToTrackIndex(status: TicketStatus): number | null {
  switch (status) {
    case 'received':
      return 0;
    // diagnostics + устаревшие estimate/approval (убраны из потока) → стадия «Диагностика».
    case 'diagnostics':
    case 'estimate':
    case 'approval':
      return 1;
    case 'in_progress':
      return 2;
    case 'act_pending':
      return 3;
    case 'closed':
      return 4;
    case 'cancelled':
      return null;
    default:
      return 0;
  }
}

export type TrackStageState = 'done' | 'current' | 'upcoming';

export interface TrackTimelineStage extends TrackStageDef {
  state: TrackStageState;
  /** ISO-дата достижения стадии (если известна из событий); иначе null. */
  at: string | null;
}

export interface TrackTimelineEventInput {
  type: string;
  createdAt: string | Date;
  payload?: unknown;
}

export interface BuildTrackTimelineInput {
  status: TicketStatus;
  receivedAt: string | Date;
  closedAt?: string | Date | null;
  cancelledAt?: string | Date | null;
  waitingForPart?: boolean;
  events?: TrackTimelineEventInput[];
}

export interface TrackTimeline {
  cancelled: boolean;
  cancelledAt: string | null;
  /** Индекс текущей стадии (−1 если заявка отменена). */
  currentIndex: number;
  stages: TrackTimelineStage[];
  /**
   * Ждём запчасть на текущей стадии (плашка в UI) — только ФАКТ, без текста заметки.
   * Свободный текст waiting_for_part_note — внутренняя пометка для менеджера (поставщик/
   * цена/контакт), клиенту он НЕ показывается (ни в кабинете, ни на публичном треке).
   */
  waitingForPart: boolean;
}

function trackToIso(v: string | Date | null | undefined): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Внутренний статус (из события status_change.payload.to) → ключ клиентской стадии. */
const TRACK_STATUS_TO_KEY: Record<string, TrackStageKey> = {
  received: 'received',
  diagnostics: 'diagnostics',
  // estimate/approval убраны из потока — историю относим к «Диагностике».
  estimate: 'diagnostics',
  approval: 'diagnostics',
  in_progress: 'repair',
  act_pending: 'ready',
  closed: 'issued',
};

/**
 * Строит трек-таймлайн из статуса заявки и её событий. Чистая функция (юнит-тест):
 * не читает БД, детерминирована. Даты стадий берём из событий смены статуса
 * (первое достижение каждой стадии). Используется и в кабинете клиента, и на
 * публичной странице по токену (там — на сервере, чтобы наружу уходил только
 * технический таймлайн без ПДн).
 */
export function buildTrackTimeline(input: BuildTrackTimelineInput): TrackTimeline {
  const cancelled = input.status === 'cancelled';
  const isClosed = input.status === 'closed';
  const currentIndex = cancelled ? -1 : ticketStatusToTrackIndex(input.status) ?? 0;

  const stageAt: Record<TrackStageKey, string | null> = {
    received: trackToIso(input.receivedAt),
    diagnostics: null,
    repair: null,
    ready: null,
    issued: trackToIso(input.closedAt ?? null),
  };

  for (const e of input.events ?? []) {
    if (e.type !== 'status_change') continue;
    const to = (e.payload as { to?: unknown } | undefined | null)?.to;
    if (typeof to !== 'string') continue;
    const key = TRACK_STATUS_TO_KEY[to];
    if (!key) continue;
    const iso = trackToIso(e.createdAt);
    // Первое достижение стадии (события отсортированы по времени возрастания).
    if (iso && !stageAt[key]) stageAt[key] = iso;
  }

  const stages: TrackTimelineStage[] = TRACK_STAGES.map((def, i) => {
    let state: TrackStageState;
    if (cancelled) {
      state = stageAt[def.key] ? 'done' : 'upcoming';
    } else if (isClosed) {
      state = 'done';
    } else if (i < currentIndex) {
      state = 'done';
    } else if (i === currentIndex) {
      state = 'current';
    } else {
      state = 'upcoming';
    }
    // Дату показываем только у достигнутых стадий (done/current). У стадий «впереди»
    // at=null, иначе откат статуса назад (act_pending→in_progress «на доделку», reopen)
    // рисовал бы будущую стадию с прошедшей датой из старого события — противоречие.
    return { ...def, state, at: state === 'upcoming' ? null : stageAt[def.key] };
  });

  return {
    cancelled,
    cancelledAt: trackToIso(input.cancelledAt ?? null),
    currentIndex,
    stages,
    waitingForPart: Boolean(input.waitingForPart),
  };
}
