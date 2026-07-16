import type { StatusBadgeVariant } from '../../components/ui/StatusBadge';

export type TenderStatus = 'won' | 'in_progress' | 'fulfilled' | 'paid' | 'cancelled';

interface MetaEntry {
  label: string;
  variant: StatusBadgeVariant;
}

/** Метаданные статусов тендера (госконтракта). */
export const TENDER_STATUS_META: Record<TenderStatus, MetaEntry> = {
  won: { label: 'Выигран', variant: 'info' },
  in_progress: { label: 'Исполняется', variant: 'warning' },
  fulfilled: { label: 'Исполнен', variant: 'muted' },
  paid: { label: 'Оплачен', variant: 'success' },
  cancelled: { label: 'Расторгнут', variant: 'danger' },
};
