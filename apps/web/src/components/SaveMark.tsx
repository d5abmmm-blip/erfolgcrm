/**
 * Отметка «что стало с тем, что я набрал» рядом с полем наряда.
 *
 * До неё наряд отвечал человеку только когда плохо, а при удаче молчал —
 * и молчание читалось как «пропало». Одна отметка на все поля, чтобы
 * состояние везде называлось одинаково (см. lib/save-state.ts).
 */
import { Check, CloudOff, Loader2 } from 'lucide-react';
import { saveMarkLabel, type SaveMarkState } from '../lib/save-state';
import { cn } from '../lib/utils';

const TONE = {
  muted: 'text-muted-foreground',
  success: 'text-success',
  warning: 'text-warning',
} as const;

export function SaveMark({ state, className }: { state: SaveMarkState; className?: string }) {
  const label = saveMarkLabel(state);
  if (!label) return null;
  const Icon = state === 'saving' ? Loader2 : state === 'saved' ? Check : CloudOff;
  return (
    <span
      className={cn(
        'mt-1 inline-flex items-center gap-1 text-[11px] font-medium',
        TONE[label.tone],
        className,
      )}
      // Экранный диктор и просто внимательный человек должны увидеть смену
      // состояния, а не только цвет.
      role="status"
    >
      <Icon className={cn('h-3 w-3', state === 'saving' && 'animate-spin')} />
      {label.text}
    </span>
  );
}
