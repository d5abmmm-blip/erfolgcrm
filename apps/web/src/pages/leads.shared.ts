/**
 * Общие справочники и хелперы для страниц лидов (list/form/card).
 *
 * ВНИМАНИЕ: estimatedValue у лида хранится в РУБЛЯХ (numeric), а не в копейках,
 * поэтому здесь свой форматтер formatLeadMoney — НЕ путать с lib/money.ts (копейки).
 */
import type { StatusBadgeVariant } from '../components/ui/StatusBadge';

export type LeadStatus = 'new' | 'contacted' | 'proposal' | 'negotiation' | 'won' | 'lost';
export type LeadSource = 'cold_call' | 'referral' | 'tender' | 'website' | 'other';
export type LeadLostReason = 'price' | 'competitor' | 'no_need' | 'no_response' | 'other';

export const LEAD_STATUS_ORDER: LeadStatus[] = [
  'new',
  'contacted',
  'proposal',
  'negotiation',
  'won',
  'lost',
];

export const LEAD_STATUS_META: Record<LeadStatus, { label: string; variant: StatusBadgeVariant }> =
  {
    new: { label: 'Новый', variant: 'muted' },
    contacted: { label: 'Контакт', variant: 'info' },
    proposal: { label: 'КП', variant: 'info' },
    negotiation: { label: 'Переговоры', variant: 'warning' },
    won: { label: 'Выигран', variant: 'success' },
    lost: { label: 'Проигран', variant: 'danger' },
  };

export const LEAD_SOURCE_LABEL: Record<LeadSource, string> = {
  cold_call: 'Холодный звонок',
  referral: 'Рекомендация',
  tender: 'Тендер',
  website: 'Сайт',
  other: 'Другое',
};

export const LEAD_LOST_REASON_LABEL: Record<LeadLostReason, string> = {
  price: 'Цена',
  competitor: 'Конкурент',
  no_need: 'Нет потребности',
  no_response: 'Нет ответа',
  other: 'Другое',
};

/** Зеркало серверной стейт-машины ALLOWED_LEAD_TRANSITIONS — для кнопок смены статуса в UI. */
export const LEAD_TRANSITIONS: Record<LeadStatus, LeadStatus[]> = {
  new: ['contacted', 'lost'],
  contacted: ['proposal', 'lost'],
  proposal: ['negotiation', 'lost'],
  negotiation: ['won', 'lost'],
  won: [],
  lost: [],
};

/** Форматирование суммы лида (рубли → «450 000 ₽»). */
export function formatLeadMoney(rub: number): string {
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 0,
  }).format(rub || 0);
}
