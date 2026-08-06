import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

type TooltipSide = 'top' | 'bottom';
type TooltipAlign = 'center' | 'start' | 'end';

interface TooltipProps {
  /** Текст подсказки — появляется при наведении мышкой и при фокусе с клавиатуры. */
  content: ReactNode;
  children: ReactNode;
  /** Пузырь сверху или снизу от элемента. По умолчанию — сверху. */
  side?: TooltipSide;
  /**
   * Горизонтальное выравнивание пузыря. Для крайних правых элементов ставим
   * `end`, для крайних левых — `start`, чтобы подсказка не уезжала за край экрана.
   */
  align?: TooltipAlign;
  /**
   * Классы внешней обёртки — задают её display. Обёртка намеренно НЕ задаёт display
   * сама: caller передаёт нужный (`inline-flex` для иконки, `block` для поля формы).
   */
  className?: string;
}

/**
 * Всплывающая подсказка при наведении мышкой (и при фокусе с клавиатуры).
 * Чистый CSS-hover без JS-позиционирования — надёжно и без внешних библиотек.
 * Пузырь позиционируется абсолютно относительно обёртки, поэтому не влияет на вёрстку.
 */
export function Tooltip({
  content,
  children,
  side = 'top',
  align = 'center',
  className,
}: TooltipProps) {
  return (
    <span className={cn('group relative', className)}>
      {children}
      <span
        role="tooltip"
        className={cn(
          'pointer-events-none absolute z-50 w-max max-w-xs rounded-md border px-2.5 py-1.5',
          'bg-popover text-popover-foreground text-left text-xs font-normal normal-case leading-snug tracking-normal shadow-lg',
          'whitespace-normal opacity-0 transition-opacity duration-150',
          'group-focus-within:opacity-100 group-hover:opacity-100',
          side === 'top' ? 'bottom-full mb-2' : 'top-full mt-2',
          align === 'center' && 'left-1/2 -translate-x-1/2',
          align === 'start' && 'left-0',
          align === 'end' && 'right-0',
        )}
      >
        {content}
      </span>
    </span>
  );
}
