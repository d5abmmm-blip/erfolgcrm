/**
 * Утренняя AI-сводка на дашборде менеджера.
 *
 * Данные приходят всегда (считаются из доски), текст — формулировка LLM (может быть
 * пустой, если AI не настроен/недоступен). Если текста нет — показываем факты списком.
 * Ничего не блокирует: карточка живёт своей жизнью, дашборд не ждёт AI.
 *
 * Карточка показывает топ-5 застрявших; кнопка «Подробнее» открывает модалку со ВСЕМ
 * списком (сервер отдаёт до 100), которую легко закрыть (крестик / Esc / клик вне окна).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'wouter';
import {
  Sparkles,
  AlertTriangle,
  PhoneCall,
  Users,
  ArrowRight,
  Activity,
  ListChecks,
  X,
} from 'lucide-react';
import { trpc, type RouterOutputs } from '../lib/trpc';
import { cn } from '../lib/utils';

type SummaryData = RouterOutputs['aiAssistant']['dailySummary']['data'];

export function AiDailySummaryCard() {
  const q = trpc.aiAssistant.dailySummary.useQuery(undefined, {
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const [detailOpen, setDetailOpen] = useState(false);
  const data = q.data?.data;
  const hasFacts =
    !!data && (data.stuckCount > 0 || data.readyCount > 0 || data.overloaded.length > 0);

  return (
    <section className="bg-card overflow-hidden rounded-xl border shadow-sm">
      <div className="flex items-center justify-between border-b p-4">
        <h3 className="flex items-center gap-2.5 font-semibold">
          <span className="bg-primary/10 text-primary grid h-8 w-8 place-items-center rounded-lg">
            <Sparkles className="h-4 w-4" />
          </span>
          Сводка на сегодня
        </h3>
        <div className="flex items-center gap-4">
          {hasFacts && (
            <button
              type="button"
              onClick={() => setDetailOpen(true)}
              className="text-primary inline-flex items-center gap-1 text-sm font-medium hover:underline"
            >
              <ListChecks className="h-3.5 w-3.5" />
              Подробнее
            </button>
          )}
          <Link
            href="/board"
            className="text-primary inline-flex items-center gap-1 text-sm hover:underline"
          >
            Доска <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>

      {q.isLoading ? (
        <div className="text-muted-foreground p-4 text-sm">Собираю сводку…</div>
      ) : q.error ? (
        <div className="text-muted-foreground p-4 text-sm">Сводка недоступна.</div>
      ) : q.data?.text ? (
        <div className="text-foreground whitespace-pre-wrap p-4 text-sm leading-relaxed">
          {q.data.text}
        </div>
      ) : (
        <SummaryFacts data={data} onOpenDetail={() => setDetailOpen(true)} />
      )}

      {detailOpen && data && (
        <SummaryDetailModal data={data} onClose={() => setDetailOpen(false)} />
      )}
    </section>
  );
}

function SummaryFacts({
  data,
  onOpenDetail,
}: {
  data: SummaryData | undefined;
  onOpenDetail: () => void;
}) {
  if (!data) return null;
  const nothing =
    data.stuckCount === 0 && data.readyCount === 0 && data.overloaded.length === 0;
  if (nothing) {
    return (
      <div className="text-muted-foreground p-4 text-sm">
        Всё в движении — застрявших заявок нет. Активных: {data.activeTotal}.
      </div>
    );
  }
  return (
    <div className="grid gap-x-8 gap-y-5 p-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
      {/* Колонка 1 — счётчики «сейчас» */}
      <div className="space-y-2">
        <div className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide">
          <Activity className="h-3.5 w-3.5" />
          Сейчас в работе
        </div>
        <dl className="space-y-1">
          <div className="flex items-baseline justify-between gap-2">
            <dt>Активных</dt>
            <dd className="font-medium tabular-nums">{data.activeTotal}</dd>
          </div>
          <div
            className={cn(
              'flex items-baseline justify-between gap-2',
              data.stuckCount > 0 && 'text-destructive',
            )}
          >
            <dt>
              Застряло
              {data.unspecifiedCount > 0 && (
                <span className="text-muted-foreground"> · без причины {data.unspecifiedCount}</span>
              )}
            </dt>
            <dd className="font-medium tabular-nums">{data.stuckCount}</dd>
          </div>
          <div
            className={cn(
              'flex items-baseline justify-between gap-2',
              data.readyCount > 0 && 'text-success',
            )}
          >
            <dt>Готово к выдаче</dt>
            <dd className="font-medium tabular-nums">{data.readyCount}</dd>
          </div>
        </dl>
        {data.readyCount > 0 && (
          <div className="text-success flex items-center gap-1.5 text-xs">
            <PhoneCall className="h-3.5 w-3.5" />
            Позвонить клиентам по {data.readyCount} готовым заявкам.
          </div>
        )}
      </div>

      {/* Колонка 2 — дольше всего стоят (топ-5, остальное — в модалке) */}
      {data.topStuck.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide">
            <AlertTriangle className="h-3.5 w-3.5" />
            Дольше всего стоят
          </div>
          <ul className="space-y-0.5">
            {data.topStuck.slice(0, 5).map((s) => (
              <li key={s.ticketNumber}>
                <Link
                  href={`/tickets/${s.ticketId}`}
                  className="hover:bg-muted/60 -mx-1 flex items-baseline gap-2 rounded px-1 py-0.5 transition"
                >
                  <span className="font-mono text-xs">{s.ticketNumber}</span>
                  <span className="truncate">{s.assetModel ?? '—'}</span>
                  <span className="text-destructive ml-auto shrink-0 text-xs tabular-nums">
                    {s.stuckDays} дн · {s.reason}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {data.stuckCount > 5 && (
            <button
              type="button"
              onClick={onOpenDetail}
              className="text-primary text-xs font-medium hover:underline"
            >
              …и ещё {data.stuckCount - 5} — показать все
            </button>
          )}
        </div>
      )}

      {/* Колонка 3 — перегруженные инженеры */}
      {data.overloaded.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide">
            <Users className="h-3.5 w-3.5" />
            Перегружены
          </div>
          <ul className="space-y-1">
            {data.overloaded.map((e, i) => (
              <li key={`${e.name}-${i}`} className="flex items-baseline justify-between gap-2">
                <span className="truncate">{e.name}</span>
                <span className="text-muted-foreground shrink-0 tabular-nums">{e.count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Модалка «Подробнее» — весь список сводки, легко закрыть (крестик / Esc / клик вне окна). */
function SummaryDetailModal({ data, onClose }: { data: SummaryData; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="bg-card flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between border-b p-4">
          <h3 className="flex items-center gap-2.5 font-semibold">
            <span className="bg-primary/10 text-primary grid h-8 w-8 place-items-center rounded-lg">
              <Sparkles className="h-4 w-4" />
            </span>
            Сводка на сегодня — подробно
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="hover:bg-muted grid h-8 w-8 place-items-center rounded-md"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto p-4 text-sm">
          {/* Счётчики */}
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            <SummaryStat label="Активных" value={data.activeTotal} />
            <SummaryStat
              label="Застряло"
              value={data.stuckCount}
              tone={data.stuckCount > 0 ? 'danger' : undefined}
              sub={data.unspecifiedCount > 0 ? `без причины ${data.unspecifiedCount}` : undefined}
            />
            <SummaryStat
              label="Готово к выдаче"
              value={data.readyCount}
              tone={data.readyCount > 0 ? 'success' : undefined}
            />
          </div>

          {/* Дольше всего стоят — весь список */}
          {data.topStuck.length > 0 && (
            <DetailSection icon={AlertTriangle} title={`Дольше всего стоят · ${data.stuckCount}`}>
              {data.topStuck.map((s) => (
                <li key={s.ticketNumber}>
                  <Link
                    href={`/tickets/${s.ticketId}`}
                    onClick={onClose}
                    className="hover:bg-muted/60 flex items-baseline gap-3 rounded px-1 py-1.5 transition"
                  >
                    <span className="w-16 shrink-0 font-mono text-xs">{s.ticketNumber}</span>
                    <span className="min-w-0 flex-1 truncate">
                      {s.assetModel ?? '—'}
                      <span className="text-muted-foreground">
                        {' '}
                        · {s.engineerName ?? 'не назначен'}
                      </span>
                    </span>
                    <span className="text-destructive shrink-0 text-right text-xs tabular-nums">
                      {s.stuckDays} дн · {s.reason}
                    </span>
                  </Link>
                </li>
              ))}
            </DetailSection>
          )}

          {/* Готово к выдаче — позвонить */}
          {data.ready.length > 0 && (
            <DetailSection icon={PhoneCall} title={`Готово к выдаче — позвонить · ${data.readyCount}`}>
              {data.ready.map((r) => (
                <li key={r.ticketNumber}>
                  <Link
                    href={`/tickets/${r.ticketId}`}
                    onClick={onClose}
                    className="hover:bg-muted/60 flex items-baseline gap-3 rounded px-1 py-1.5 transition"
                  >
                    <span className="w-16 shrink-0 font-mono text-xs">{r.ticketNumber}</span>
                    <span className="min-w-0 flex-1 truncate">{r.assetModel ?? '—'}</span>
                  </Link>
                </li>
              ))}
            </DetailSection>
          )}

          {/* Загрузка инженеров */}
          {data.overloaded.length > 0 && (
            <DetailSection icon={Users} title="Загрузка инженеров">
              {data.overloaded.map((e, i) => (
                <li key={`${e.name}-${i}`} className="flex items-baseline justify-between gap-3 py-1.5">
                  <span className="truncate">{e.name}</span>
                  <span className="text-muted-foreground shrink-0 tabular-nums">
                    {e.count} активных
                  </span>
                </li>
              ))}
            </DetailSection>
          )}
        </div>

        <div className="flex items-center justify-between border-t p-4">
          <Link
            href="/board"
            onClick={onClose}
            className="text-primary inline-flex items-center gap-1 text-sm hover:underline"
          >
            Открыть доску <ArrowRight className="h-3.5 w-3.5" />
          </Link>
          <button
            type="button"
            onClick={onClose}
            className="hover:bg-muted rounded-md border px-4 py-2 text-sm font-medium"
          >
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}

function SummaryStat({
  label,
  value,
  tone,
  sub,
}: {
  label: string;
  value: number;
  tone?: 'danger' | 'success';
  sub?: string;
}) {
  return (
    <div>
      <div className="text-muted-foreground text-xs uppercase tracking-wide">{label}</div>
      <div
        className={cn(
          'text-2xl font-semibold tabular-nums',
          tone === 'danger' && 'text-destructive',
          tone === 'success' && 'text-success',
        )}
      >
        {value}
      </div>
      {sub && <div className="text-muted-foreground text-xs">{sub}</div>}
    </div>
  );
}

function DetailSection({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof AlertTriangle;
  title: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="text-muted-foreground mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide">
        <Icon className="h-3.5 w-3.5" />
        {title}
      </div>
      <ul className="divide-y">{children}</ul>
    </div>
  );
}
