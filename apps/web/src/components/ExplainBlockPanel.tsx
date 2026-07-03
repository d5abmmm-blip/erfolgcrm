/**
 * «Почему застряло?» — AI-объяснение простоя заявки на её карточке.
 *
 * По клику запрашивает aiAssistant.explainTicketBlock. Данные (статус/причина/таймлайн)
 * приходят всегда; text — формулировка LLM (может быть пустой). Если текста нет —
 * показываем факты (причина + история). Кнопка не блокирует карточку.
 */
import { useState } from 'react';
import { Sparkles, Loader2 } from 'lucide-react';
import { trpc, type RouterOutputs } from '../lib/trpc';

export function ExplainBlockPanel({ ticketId }: { ticketId: string }) {
  const [open, setOpen] = useState(false);
  const q = trpc.aiAssistant.explainTicketBlock.useQuery(
    { ticketId },
    { enabled: open, staleTime: 60_000, refetchOnWindowFocus: false },
  );

  return (
    <section className="bg-card space-y-3 rounded-xl border p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <span className="bg-primary/10 text-primary grid h-7 w-7 place-items-center rounded-lg">
            <Sparkles className="h-3.5 w-3.5" />
          </span>
          Почему застряло?
        </h3>
        {!open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="border-primary/40 text-primary hover:bg-primary/5 rounded-md border px-2.5 py-1 text-xs font-medium transition"
          >
            Спросить AI
          </button>
        )}
      </div>

      {open && (
        <div className="text-sm">
          {q.isLoading ? (
            <div className="text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Разбираю историю заявки…
            </div>
          ) : q.error || !q.data ? (
            <div className="text-muted-foreground">Не удалось получить объяснение.</div>
          ) : (
            <ExplainResult data={q.data} />
          )}
        </div>
      )}
    </section>
  );
}

type ExplainData = NonNullable<RouterOutputs['aiAssistant']['explainTicketBlock']>;

function ExplainResult({ data }: { data: ExplainData }) {
  return (
    <div className="space-y-3">
      <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-xs">
        <span>Статус: {data.facts.status}</span>
        <span>Стоит: {data.facts.stuckDays} дн</span>
        <span>Причина: {data.facts.reason ?? 'не указана'}</span>
      </div>

      {data.text ? (
        <div className="text-foreground whitespace-pre-wrap leading-relaxed">{data.text}</div>
      ) : (
        <div>
          <div className="text-muted-foreground mb-1 text-xs uppercase tracking-wide">
            История заявки
          </div>
          <ol className="space-y-0.5">
            {data.facts.timeline.slice(-8).map((t, i) => (
              <li key={i} className="text-muted-foreground flex gap-2 text-xs">
                <span className="text-primary/60">•</span>
                <span>{t}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
