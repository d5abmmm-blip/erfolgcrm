/**
 * Блок «Похожие ремонты» — флагманская AI-диагностика по симптому.
 *
 * Показывает похожие прошлые ремонты из технического архива (repair_archive):
 * модель · симптом · что нашли · что делали · год. Плюс необязательное ИИ-резюме
 * «что обычно помогало» (для staff; деградирует, если ИИ выключен/недоступен).
 *
 * Два режима:
 *   - карточка заявки: передаём ticketId (сервер сам берёт симптом + модель),
 *     autoSummary — резюме подгружается сразу.
 *   - форма новой заявки: передаём symptom (живьём по мере ввода) + model.
 *
 * В архиве нет персональных данных клиента (только техника), поэтому и список,
 * и ИИ-резюме безопасны по 152-ФЗ.
 */
import { useEffect, useState } from 'react';
import { History, MessageSquare, Search, ShieldCheck, Sparkles, Wrench } from 'lucide-react';
import { trpc } from '../lib/trpc';

const LIMIT = 6;
/** Минимальная длина живого симптома, чтобы дёргать поиск (короче — шум). */
const MIN_SYMPTOM_LEN = 4;

interface RepairArchiveBlockProps {
  /** Карточка заявки — сервер сам достанет симптом + модель. */
  ticketId?: string;
  /** Живой симптом из формы новой заявки. */
  symptom?: string;
  /** Модель техники (если выбрана) — уточняет поиск. */
  model?: string | null;
  /** Staff (директор/диспетчер) — показываем ИИ-резюме. */
  canSummarize?: boolean;
  /** Подгружать ИИ-резюме автоматически (карточка). Иначе — по кнопке. */
  autoSummary?: boolean;
  className?: string;
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

export function RepairArchiveBlock({
  ticketId,
  symptom,
  model,
  canSummarize = false,
  autoSummary = false,
  className,
}: RepairArchiveBlockProps) {
  const liveSymptom = useDebounced((symptom ?? '').trim(), 400);
  const liveModel = (model ?? '').trim();

  // Живой режим включаем только при осмысленном вводе, чтобы не искать по «не».
  const liveEnabled =
    !ticketId && (liveSymptom.length >= MIN_SYMPTOM_LEN || liveModel.length >= 3);
  const enabled = !!ticketId || liveEnabled;

  const searchInput = ticketId
    ? { ticketId, limit: LIMIT }
    : { symptom: liveSymptom || undefined, model: liveModel || undefined, limit: LIMIT };

  const matchesQ = trpc.repairArchive.searchSimilar.useQuery(searchInput, {
    enabled,
    staleTime: 30_000,
  });
  const matches = matchesQ.data ?? [];

  const [showSummary, setShowSummary] = useState(autoSummary);
  const summaryEnabled = canSummarize && showSummary && enabled && matches.length > 0;
  const summaryInput = ticketId
    ? { ticketId }
    : { symptom: liveSymptom || undefined, model: liveModel || undefined };
  const summaryQ = trpc.repairArchive.summarize.useQuery(summaryInput, {
    enabled: summaryEnabled,
    staleTime: 5 * 60_000,
  });

  // Ничего не показываем, если запрос ещё не осмыслен.
  if (!enabled) return null;

  const isLoading = matchesQ.isLoading;

  // Пусто: на карточке — короткая заметка, в живом режиме — прячем совсем.
  if (!isLoading && matches.length === 0) {
    if (!ticketId) return null;
    return (
      <section className={'bg-card rounded-lg border p-4 md:p-6 ' + (className ?? '')}>
        <Header count={0} />
        <p className="text-muted-foreground mt-3 text-sm">
          Похожих ремонтов в архиве не нашлось.
        </p>
      </section>
    );
  }

  return (
    <section className={'bg-card rounded-lg border p-4 md:p-6 ' + (className ?? '')}>
      <Header count={matches.length} />

      {isLoading && <p className="text-muted-foreground mt-3 text-sm">Поиск…</p>}

      {canSummarize && matches.length > 0 && (
        <AiSummary
          show={showSummary}
          auto={autoSummary}
          onShow={() => setShowSummary(true)}
          loading={summaryQ.isFetching}
          text={summaryQ.data?.text ?? null}
          done={summaryQ.isFetched}
        />
      )}

      {matches.length > 0 && (
        <ul className="mt-3 space-y-2">
          {matches.map((m) => (
            <li key={m.id} className="rounded-md border p-2.5 text-xs">
              <div className="mb-1 flex flex-wrap items-center gap-1.5">
                <span className="font-medium">{m.deviceModel ?? m.deviceType ?? 'Техника'}</span>
                {m.year != null && <span className="text-muted-foreground">· {m.year}</span>}
                <MatchBadge reason={m.matchReason} />
              </div>
              {m.symptom && (
                <div className="text-muted-foreground flex gap-1.5">
                  <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>«{m.symptom}»</span>
                </div>
              )}
              {m.diagnosis && (
                <div className="mt-1 flex gap-1.5">
                  <Search className="text-success mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    <span className="text-muted-foreground">нашли: </span>
                    {m.diagnosis}
                  </span>
                </div>
              )}
              {m.worksSummary && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {m.worksSummary
                    .split(';')
                    .map((w) => w.trim())
                    .filter(Boolean)
                    .slice(0, 4)
                    .map((w, i) => (
                      <span
                        key={i}
                        className="bg-muted inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px]"
                      >
                        <Wrench className="h-2.5 w-2.5" />
                        {w}
                      </span>
                    ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {matches.length > 0 && (
        <div className="text-muted-foreground mt-3 flex items-start gap-1.5 border-t pt-2 text-[10px]">
          <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0" />
          <span>Из архива WinServisePro. Только техника, без ФИО и телефонов клиента.</span>
        </div>
      )}
    </section>
  );
}

function Header({ count }: { count: number }) {
  return (
    <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide">
      <History className="h-4 w-4" />
      Похожие ремонты
      <span className="text-muted-foreground ml-auto text-[10px] font-normal normal-case tracking-normal">
        архив 2015–2023{count > 0 ? ` · найдено ${count}` : ''}
      </span>
    </h2>
  );
}

function AiSummary({
  show,
  auto,
  onShow,
  loading,
  text,
  done,
}: {
  show: boolean;
  auto: boolean;
  onShow: () => void;
  loading: boolean;
  text: string | null;
  done: boolean;
}) {
  if (!show) {
    return (
      <button
        type="button"
        onClick={onShow}
        className="border-primary/30 text-primary hover:bg-primary/5 mt-3 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium"
      >
        <Sparkles className="h-3.5 w-3.5" />
        Что обычно помогало
      </button>
    );
  }
  // На автоподгрузке (карточка) молча прячем, если ИИ ничего не вернул.
  if (auto && done && !loading && !text) return null;
  return (
    <div className="bg-primary/5 border-primary/20 mt-3 rounded-md border p-2.5">
      <div className="text-primary mb-1 flex items-center gap-1.5 text-xs font-medium">
        <Sparkles className="h-3.5 w-3.5" />
        Что обычно помогало
      </div>
      {loading ? (
        <p className="text-muted-foreground text-xs">ИИ думает…</p>
      ) : text ? (
        <>
          <p className="whitespace-pre-wrap text-xs leading-relaxed">{text}</p>
          <p className="text-muted-foreground mt-1 text-[10px]">
            ИИ-резюме · без данных клиента
          </p>
        </>
      ) : done ? (
        <p className="text-muted-foreground text-xs">
          ИИ-резюме сейчас недоступно — смотрите список ниже.
        </p>
      ) : null}
    </div>
  );
}

function MatchBadge({ reason }: { reason: 'symptom' | 'model' | 'symptom_model' }) {
  if (reason === 'symptom_model') {
    return (
      <span className="bg-primary/10 text-primary ml-auto rounded px-1.5 py-0.5 text-[10px]">
        симптом + модель
      </span>
    );
  }
  if (reason === 'model') {
    return (
      <span className="bg-muted text-muted-foreground ml-auto rounded px-1.5 py-0.5 text-[10px]">
        по модели
      </span>
    );
  }
  return (
    <span className="bg-muted text-muted-foreground ml-auto rounded px-1.5 py-0.5 text-[10px]">
      по симптому
    </span>
  );
}
