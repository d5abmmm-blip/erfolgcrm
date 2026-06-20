import type { StatusBadgeVariant } from '../../components/ui/StatusBadge';

export type SaleStatus = 'new' | 'ordered' | 'received' | 'handed_over' | 'cancelled';

interface MetaEntry {
  label: string;
  variant: StatusBadgeVariant;
}

/** Метаданные статусов продажи (заказа запчастей/оборудования). */
export const SALE_STATUS_META: Record<SaleStatus, MetaEntry> = {
  new: { label: 'Новый', variant: 'muted' },
  ordered: { label: 'Заказано у поставщика', variant: 'warning' },
  received: { label: 'Получено', variant: 'info' },
  handed_over: { label: 'Выдан клиенту', variant: 'success' },
  cancelled: { label: 'Отменён', variant: 'danger' },
};

/** Порядок статусов для перехода «вперёд» (без cancelled). */
export const SALE_STATUS_FLOW: SaleStatus[] = ['new', 'ordered', 'received', 'handed_over'];
