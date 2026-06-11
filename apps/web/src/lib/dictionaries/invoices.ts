import type { InvoiceStatus } from '@erfolg/shared';
import type { StatusBadgeVariant } from '../../components/ui/StatusBadge';

interface MetaEntry {
  label: string;
  /** Короткая подпись для узких бейджей в табличках. */
  shortLabel?: string;
  variant: StatusBadgeVariant;
}

/**
 * Метаданные статусов счёта на оплату.
 * Источник истины — `InvoiceStatus` enum в @erfolg/shared.
 */
export const INVOICE_STATUS_META: Record<InvoiceStatus, MetaEntry> = {
  draft: { label: 'Черновик', variant: 'muted' },
  issued: { label: 'Выставлен', variant: 'info' },
  partially_paid: { label: 'Частично оплачен', shortLabel: 'Частично', variant: 'warning' },
  paid: { label: 'Оплачен', variant: 'success' },
  overdue: { label: 'Просрочен', variant: 'danger' },
  cancelled: { label: 'Отменён', variant: 'muted' },
};
