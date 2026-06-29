/**
 * Блок «Похожие случаи».
 *
 * Используется в карточках Ticket и Asset. Показывает:
 *   1. Прошлые тикеты на этот asset (или клиент) — ссылки на /tickets/:id.
 *   2. Статьи базы знаний, найденные через kbArticles.searchSimilar
 *      (точное совпадение модели + полнотекст по симптому).
 *
 * Для тикета — собираем по ticketId (сервер сам найдёт asset.model и symptom).
 * Для асcета — по assetId.
 *
 * Лимиты: 5 тикетов и 5 статей. Если хочется больше — кнопка «Ещё в базе знаний»
 * ведёт на /kb?q=...
 */
import { Link } from 'wouter';
import { BookOpen, FileText, Lightbulb, Tag } from 'lucide-react';
import { trpc } from '../lib/trpc';

const TICKET_LIMIT = 5;
const KB_LIMIT = 5;

const TICKET_STATUS_LABEL: Record<string, string> = {
  received: 'Принята',
  diagnostics: 'Диагностика',
  estimate: 'Смета',
  approval: 'Согласование',
  in_progress: 'В работе',
  act_pending: 'Готов акт',
  closed: 'Закрыта',
  cancelled: 'Отменена',
};

interface SimilarCasesBlockProps {
  /** Передать ровно одно из двух. */
  ticketId?: string;
  assetId?: string;
  /**
   * Если задан — исключаем этот тикет из списка прошлых случаев
   * (чтобы текущий тикет не показывался сам себе).
   */
  excludeTicketId?: string;
  /**
   * Если на этом asset нужно искать прошлые тикеты, передать assetId.
   * При ticketId передаём, что выяснили из ticket — берём через trpc query внутри.
   */
  className?: string;
}

export function SimilarCasesBlock({
  ticketId,
  assetId,
  excludeTicketId,
  className,
}: SimilarCasesBlockProps) {
  // 1. Если у нас ticketId, нам нужен assetId этого тикета чтобы поискать прошлые.
  //    Грузим только при наличии ticketId, иначе используем переданный assetId.
  const ticketDetail = trpc.tickets.get.useQuery(
    { id: ticketId ?? '' },
    { enabled: !!ticketId, staleTime: 30_000 },
  );
  const resolvedAssetId =
    assetId ?? (ticketDetail.data?.assetId ?? null) ?? undefined;

  // 2. Прошлые тикеты на этот asset.
  const pastTickets = trpc.tickets.list.useQuery(
    { clientId: undefined, contractId: undefined, pageSize: 50 },
    { enabled: false }, // отключаем дефолтный — ниже точечный с фильтром по asset
  );
  void pastTickets; // marker (не используем — у listTickets нет фильтра по assetId,
  // вместо этого вытащим из самого карточного состояния через /assets/:id если нужно)

  // tickets.list поддерживает clientId/engineerId/contractId/scheduled, но НЕ assetId.
  // Поэтому для прошлых тикетов используем serverSearch — поиск по серийнику/модели слишком широкий.
  // Решение: загружаем все тикеты клиента и фильтруем по assetId на клиенте.
  // Это OK для 11 человек / десятков тикетов на клиента.
  const ownerClientIdQuery = trpc.assets.get.useQuery(
    { id: resolvedAssetId ?? '' },
    { enabled: !!resolvedAssetId, staleTime: 30_000 },
  );
  const ticketsByClient = trpc.tickets.list.useQuery(
    { clientId: ownerClientIdQuery.data?.ownerClientId ?? undefined, pageSize: 50 },
    { enabled: !!ownerClientIdQuery.data?.ownerClientId, staleTime: 30_000 },
  );

  const filteredPast = (ticketsByClient.data?.items ?? [])
    .filter((t) => t.assetId === resolvedAssetId)
    .filter((t) => (excludeTicketId ? t.id !== excludeTicketId : true))
    .slice(0, TICKET_LIMIT);

  // 3. Статьи из базы знаний — searchSimilar по ticketId или assetId.
  const similar = trpc.kbArticles.searchSimilar.useQuery(
    ticketId
      ? { ticketId, limit: KB_LIMIT }
      : assetId
        ? { assetId, limit: KB_LIMIT }
        : { query: 'never', limit: 1 },
    { enabled: !!(ticketId || assetId), staleTime: 30_000 },
  );

  const articles = similar.data ?? [];
  const isLoading =
    (resolvedAssetId &&
      (ownerClientIdQuery.isLoading || ticketsByClient.isLoading)) ||
    similar.isLoading;
  const noContent =
    !isLoading && filteredPast.length === 0 && articles.length === 0;

  return (
    <section
      className={
        'bg-card rounded-lg border p-4 md:p-6 ' + (className ?? '')
      }
    >
      <h2 className="text-sm font-semibold uppercase tracking-wide flex items-center gap-2">
        <Lightbulb className="h-4 w-4" />
        Похожие случаи
      </h2>

      {isLoading && (
        <p className="text-muted-foreground mt-3 text-sm">Поиск…</p>
      )}

      {noContent && (
        <p className="text-muted-foreground mt-3 text-sm">
          Похожих ремонтов и статей пока нет.{' '}
          <Link href="/kb" className="text-primary underline-offset-4 hover:underline">
            Открыть базу знаний
          </Link>
          .
        </p>
      )}

      {!isLoading && filteredPast.length > 0 && (
        <div className="mt-3">
          <div className="text-muted-foreground mb-1.5 text-[10px] uppercase tracking-wide">
            Прошлые ремонты этой техники
          </div>
          <ul className="space-y-1">
            {filteredPast.map((t) => (
              <li key={t.id}>
                <Link
                  href={`/tickets/${t.id}`}
                  className="hover:bg-muted/40 flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs"
                >
                  <FileText className="text-muted-foreground h-3.5 w-3.5" />
                  <span className="font-mono">{t.ticketNumber}</span>
                  <span className="text-muted-foreground bg-muted rounded px-1.5 py-0.5">
                    {TICKET_STATUS_LABEL[t.status] ?? t.status}
                  </span>
                  <span className="text-muted-foreground truncate">
                    {new Date(t.receivedAt).toLocaleDateString('ru-RU')}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!isLoading && articles.length > 0 && (
        <div className="mt-4">
          <div className="text-muted-foreground mb-1.5 text-[10px] uppercase tracking-wide">
            Из базы знаний
          </div>
          <ul className="space-y-1.5">
            {articles.map((a) => (
              <li key={a.id}>
                <Link
                  href={`/kb`}
                  className="hover:bg-muted/40 block rounded-md border p-2 text-xs"
                >
                  <div className="flex items-center gap-1.5">
                    <BookOpen className="text-primary h-3.5 w-3.5" />
                    <span className="font-medium">{a.title}</span>
                    <MatchBadge reason={a.matchReason} />
                  </div>
                  {a.bodyExcerpt && (
                    <div className="text-muted-foreground mt-0.5 line-clamp-2">
                      {a.bodyExcerpt}
                    </div>
                  )}
                  {(a.tags.length > 0 || a.assetModels.length > 0) && (
                    <div className="text-muted-foreground mt-1 flex flex-wrap gap-1">
                      {a.tags.slice(0, 4).map((t) => (
                        <span key={t} className="bg-primary/10 text-primary rounded px-1 text-[10px]">
                          #{t}
                        </span>
                      ))}
                      {a.assetModels.slice(0, 2).map((m) => (
                        <span
                          key={m}
                          className="bg-muted inline-flex items-center gap-0.5 rounded px-1 text-[10px]"
                        >
                          <Tag className="h-2 w-2" />
                          {m}
                        </span>
                      ))}
                    </div>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function MatchBadge({ reason }: { reason: 'model' | 'attached' | 'fulltext' }) {
  if (reason === 'attached') {
    return (
      <span className="bg-success/15 text-success ml-auto rounded px-1.5 py-0.5 text-[10px]">
        привязана
      </span>
    );
  }
  if (reason === 'model') {
    return (
      <span className="bg-primary/10 text-primary ml-auto rounded px-1.5 py-0.5 text-[10px]">
        по модели
      </span>
    );
  }
  return (
    <span className="bg-muted text-muted-foreground ml-auto rounded px-1.5 py-0.5 text-[10px]">
      по тексту
    </span>
  );
}
