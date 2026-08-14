import { Archive } from 'lucide-react';
import { LEGACY_HINT, LEGACY_LABEL, LEGACY_LABEL_SHORT } from '@erfolg/shared';
import { cn } from '../../lib/utils';

interface LegacyBadgeProps {
  /** Узкие места (строка таблицы, карточка канбана) — короткое слово «перенос». */
  compact?: boolean;
  className?: string;
}

/**
 * Пометка «из старой системы» — один компонент на все экраны.
 *
 * Зачем отдельный компонент, а не span на месте: пометка нужна минимум в семи местах
 * (заявки, клиенты, техника, пользователи, поиск, канбан, карточки), и копии
 * неизбежно разъедутся — в этом проекте так уже было с подписями статусов.
 *
 * Вид намеренно тихий: контур и приглушённый текст, без заливки цветом. Перенесённая
 * запись — не ошибка и не тревога, это просто её происхождение. Красным или жёлтым
 * помечать 5999 заявок из 6068 значило бы закрасить тревогой весь экран.
 *
 * Только токены темы (border, text-muted-foreground) — тёмная тема тогда бесплатна.
 * Заливку не ставим ещё и потому, что cn() склеивает конфликтующие bg-* и пометка
 * молча съела бы фон строки, на которую её положили.
 */
export function LegacyBadge({ compact = false, className }: LegacyBadgeProps) {
  return (
    <span
      title={LEGACY_HINT}
      className={cn(
        'text-muted-foreground inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 leading-none',
        compact ? 'text-[10px]' : 'text-[11px]',
        className,
      )}
    >
      <Archive className="h-3 w-3 shrink-0" aria-hidden />
      {compact ? LEGACY_LABEL_SHORT : LEGACY_LABEL}
    </span>
  );
}
