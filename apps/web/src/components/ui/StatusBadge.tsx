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

const DOT_CLS: Record<StatusBadgeVariant, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-destructive',
  info: 'bg-primary',
  muted: 'bg-muted-foreground/50',
};

/**
 * Универсальный статус-бейдж. Цвета через варианты, не через произвольные классы,
 * чтобы цветовая палитра не разъезжалась по приложению.
 * Точка-индикатор дублирует цвет насыщенным пятном — статус считывается
 * боковым зрением даже при беглом просмотре таблицы.
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
        compact ? 'gap-1 px-1.5 py-0.5 text-[10px]' : 'gap-1.5 px-2 py-0.5 text-xs',
        VARIANT_CLS[variant],
        className,
      )}
    >
      <span
        className={cn('h-1.5 w-1.5 shrink-0 rounded-full', DOT_CLS[variant])}
        aria-hidden
      />
      {children}
    </span>
  );
}
