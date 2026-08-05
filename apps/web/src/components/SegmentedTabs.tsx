import { cn } from '../lib/utils';

interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

/**
 * Сегмент-переключатель мобильных экранов: «Активные | Все», периоды заработка.
 * Одна реализация вместо трёх ручных копий. grow — растянуть на всю ширину
 * равными колонками (экран «Мой заработок»).
 */
export function SegmentedTabs<T extends string>({
  options,
  value,
  onChange,
  grow,
}: {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (v: T) => void;
  grow?: boolean;
}) {
  return (
    <div
      className={cn(
        'bg-secondary text-secondary-foreground rounded-md p-0.5 text-sm',
        grow ? 'grid gap-0.5' : 'inline-flex',
      )}
      style={grow ? { gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` } : undefined}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded px-3 py-1.5 transition',
            grow && 'px-0 font-medium',
            o.value === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
