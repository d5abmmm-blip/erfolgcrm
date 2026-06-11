import type { AssetLifecycleStatus } from '@erfolg/shared';
import type { StatusBadgeVariant } from '../../components/ui/StatusBadge';

interface MetaEntry {
  label: string;
  variant: StatusBadgeVariant;
}

/**
 * Метаданные жизненного цикла техники.
 * Источник истины — `AssetLifecycleStatus` enum в @erfolg/shared.
 */
export const ASSET_STATUS_META: Record<AssetLifecycleStatus, MetaEntry> = {
  in_service: { label: 'В работе', variant: 'success' },
  in_repair: { label: 'В ремонте', variant: 'warning' },
  awaiting_parts: { label: 'Ждёт запчасти', variant: 'warning' },
  reserve: { label: 'Резерв', variant: 'muted' },
  decommissioned: { label: 'Списана', variant: 'danger' },
};
