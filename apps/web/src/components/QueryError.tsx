/**
 * Плашка «данные не загрузились» для экранов с useQuery.
 *
 * ЗАЧЕМ. Из 74 экранов с запросами 26 при сбое загрузки не говорили НИЧЕГО —
 * показывали пустую таблицу или пустую форму. Самое опасное место — журнал
 * аудита: пустая таблица там читается как «нарушений не было», хотя на деле
 * запрос упал. Список пользователей, остатки склада, план ТО, касса — то же самое.
 *
 * Почему компонент, а не строчка в каждом экране: 26 копий одного условия
 * разъезжаются, и в половине мест текст оказался бы техническим (SQL из
 * INTERNAL_SERVER_ERROR или JSON от Zod). Здесь текст один и всегда человеческий —
 * через `humanizeLoadError`.
 *
 * Две формы:
 *   <QueryError>     — обычный блок (карточки, формы, панели);
 *   <QueryErrorRow>  — строка таблицы; нужна отдельно, потому что внутрь
 *                      <tbody> нельзя положить <div> — браузер выкинет его
 *                      из таблицы, и плашка уедет в неожиданное место.
 */
import { humanizeLoadError } from '../lib/error-message';
import { cn } from '../lib/utils';

interface Props {
  /** `query.error` из useQuery. Если пусто и нет `paused` — компонент ничего не рисует. */
  error: unknown;
  /**
   * `query.fetchStatus === 'paused'` — запрос ЗАМОРОЖЕН из-за офлайна.
   *
   * Без этого флага половина случаев прошла бы мимо: при потере связи react-query
   * НЕ роняет запрос с ошибкой, а ставит его на паузу, и `error` остаётся пустым
   * НАВСЕГДА. Экран при этом ведёт себя как при пустых данных — то есть ровно так,
   * как до всей этой правки. Проверено в браузере: `status: 'pending',
   * fetchStatus: 'paused', error: null`.
   */
  paused?: boolean;
  /** Что именно не загрузилось: «журнал аудита», «список клиентов». В родительном падеже. */
  what?: string;
  /** Обычно `() => void query.refetch()`. Без него кнопки «Повторить» не будет. */
  onRetry?: () => void;
  className?: string;
}

function Body({ error, what, onRetry }: Omit<Props, 'className'>) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <div className="font-medium">
          {what ? `Не удалось загрузить ${what}` : 'Не удалось загрузить данные'}
        </div>
        <div className="mt-0.5 opacity-90">
          {error ? humanizeLoadError(error) : 'Нет связи с сервером — загрузка приостановлена'}
        </div>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="border-destructive/40 hover:bg-destructive/20 shrink-0 rounded-md border px-3 py-1.5 text-sm font-medium"
        >
          Повторить
        </button>
      )}
    </div>
  );
}

export function QueryError({ error, paused, what, onRetry, className }: Props) {
  if (!error && !paused) return null;
  return (
    <div
      className={cn(
        'bg-destructive/10 text-destructive border-destructive/30 rounded-md border p-3 text-sm',
        className,
      )}
    >
      <Body error={error} what={what} onRetry={onRetry} />
    </div>
  );
}

export function QueryErrorRow({
  error,
  paused,
  what,
  onRetry,
  colSpan,
}: Props & { colSpan: number }) {
  if (!error && !paused) return null;
  return (
    <tr>
      <td colSpan={colSpan} className="p-3">
        <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-md border p-3 text-sm">
          <Body error={error} what={what} onRetry={onRetry} />
        </div>
      </td>
    </tr>
  );
}
