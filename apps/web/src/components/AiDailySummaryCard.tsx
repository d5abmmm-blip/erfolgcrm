/**
 * Утренняя AI-сводка на дашборде менеджера.
 *
 * Данные приходят всегда (считаются из доски), текст — формулировка LLM (может быть
 * пустой, если AI не настроен/недоступен). Если текста нет — показываем факты списком.
 * Ничего не блокирует: карточка живёт своей жизнью, дашборд не ждёт AI.
 */
import { Link } from 'wouter';
import { Sparkles, AlertTriangle, PhoneCall, Users, ArrowRight } from 'lucide-react';
import { trpc, type RouterOutputs } from '../lib/trpc';

export function AiDailySummaryCard() {
  const q = trpc.aiAssistant.dailySummary.useQuery(undefined, {
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  return (
    <section className="bg-card overflow-hidden rounded-xl border shadow-sm">
      <div className="flex items-center justify-between border-b p-4">
        <h3 className="flex items-center gap-2.5 font-semibold">
          <span className="bg-primary/10 text-primary grid h-8 w-8 place-items-center rounded-lg">
            <Sparkles className="h-4 w-4" />
          </span>
          Сводка на сегодня
        </h3>
        <Link href="/board" className="text-primary inline-flex items-center gap-1 text-sm hover:underline">
          Доска <ArrowRight className="h-3.5 w-3.5" />
        </Link>
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
        <SummaryFacts data={q.data?.data} />
      )}
    </section>
  );
}

type SummaryData = RouterOutputs['aiAssistant']['dailySummary']['data'];

function SummaryFacts({ data }: { data: SummaryData | undefined }) {
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
    <div className="space-y-3 p-4 text-sm">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <span>
          Активных: <span className="font-medium tabular-nums">{data.activeTotal}</span>
        </span>
        <span className={data.stuckCount > 0 ? 'text-destructive' : undefined}>
          Застряло: <span className="font-medium tabular-nums">{data.stuckCount}</span>
          {data.unspecifiedCount > 0 && ` (без причины ${data.unspecifiedCount})`}
        </span>
        <span className={data.readyCount > 0 ? 'text-success' : undefined}>
          Готово к выдаче: <span className="font-medium tabular-nums">{data.readyCount}</span>
        </span>
      </div>

      {data.readyCount > 0 && (
        <div className="text-success flex items-center gap-1.5 text-xs">
          <PhoneCall className="h-3.5 w-3.5" />
          Позвонить клиентам по {data.readyCount} готовым заявкам.
        </div>
      )}

      {data.topStuck.length > 0 && (
        <div>
          <div className="text-muted-foreground mb-1 flex items-center gap-1.5 text-xs uppercase tracking-wide">
            <AlertTriangle className="h-3.5 w-3.5" />
            Дольше всего стоят
          </div>
          <ul className="space-y-1">
            {data.topStuck.slice(0, 5).map((s) => (
              <li key={s.ticketNumber} className="flex items-baseline gap-2">
                <span className="font-mono text-xs">{s.ticketNumber}</span>
                <span className="truncate">{s.assetModel ?? '—'}</span>
                <span className="text-destructive ml-auto shrink-0 text-xs tabular-nums">
                  {s.stuckDays} дн · {s.reason}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.overloaded.length > 0 && (
        <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <Users className="h-3.5 w-3.5" />
          Перегружены: {data.overloaded.map((e) => `${e.name} (${e.count})`).join(', ')}
        </div>
      )}
    </div>
  );
}
