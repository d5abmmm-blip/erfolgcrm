import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export type StatusBadgeVariant = 'success' | 'warning' | 'danger' | 'info' | 'muted';

interface StatusBadgeProps {
  variant: StatusBadgeVariant;
  children: ReactNode;
  className?: string;
  /** Маленькая компактная версия (для канбан-карточек) */
  compact?: boolean;
}

const VARIANT_CLS: Record<StatusBadgeVariant, string> = {
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-destructive/10 text-destructive',
  info: 'bg-primary/10 text-primary',
  muted: 'bg-muted text-muted-foreground',
};

/**
 * Универсальный статус-бейдж. Цвета через варианты, не через произвольные классы,
 * чтобы цветовая палитра не разъезжалась по приложению.
 */
export function StatusBadge({
  variant,
  children,
  className,
  compact = false,
}: StatusBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md font-medium',
        compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs',
        VARIANT_CLS[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
