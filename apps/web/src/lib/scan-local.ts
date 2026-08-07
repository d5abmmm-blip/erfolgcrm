/**
 * Поиск заявки по коду в памяти телефона — для сканера без связи.
 *
 * ЗАЧЕМ. Сетевой поиск (`tickets.search`) при настоящем офлайне не падает,
 * а ВИСИТ: у запросов режим `networkMode: 'online'`, и react-query ставит их
 * на паузу (см. lib/query-defaults). Обещание не завершается никогда — экран
 * сканера оставался с вечным «Ищем заявку…». Поэтому без связи в сеть не идём
 * вовсе, а ищем по тому, что уже лежит на диске: `tickets.myList` сохраняется
 * (см. offline/persisted-queries).
 *
 * ЧЕМ ЭТОТ ПОИСК ХУЖЕ СЕРВЕРНОГО — и почему об этом надо говорить вслух:
 * на сервере ищется ВСЯ база, а в телефоне лежат только СВОИ заявки. Чужой
 * аппарат офлайн не найдётся, и человек должен понимать, что это «не нашли
 * среди своих», а не «такой заявки нет».
 */
import type { ScanMatch } from './scan-pick';

export interface LocalScanTicket {
  id: string;
  ticketNumber: string;
  clientDisplayName: string | null;
  assetModel: string | null;
  assetSerialNumber: string | null;
  assetInventoryNumber: string | null;
  /**
   * Штрих-код заявки — то, что напечатано на наклейке и что читает камера.
   * Может отсутствовать у ответов, сохранённых старой версией приложения:
   * до этой правки список заявок его не отдавал вовсе.
   */
  barcode?: string | null;
}

function norm(v: string | null | undefined): string {
  return (v ?? '').trim().toLowerCase();
}

/**
 * Достаёт заявки из сохранённых ответов `tickets.myList`.
 *
 * На диске лежит по одной записи на каждый набор фильтров («Активные»,
 * «Все», разные размеры страницы), поэтому берём все и склеиваем по id.
 * Форму ответа проверяем руками: сюда приходит то, что пролежало на диске
 * неделю, и падать из-за неожиданной формы экран сканера не должен.
 */
export function collectCachedTickets(cached: readonly unknown[]): LocalScanTicket[] {
  const byId = new Map<string, LocalScanTicket>();
  for (const entry of cached) {
    if (typeof entry !== 'object' || entry === null) continue;
    const items = (entry as { items?: unknown }).items;
    if (!Array.isArray(items)) continue;
    for (const raw of items) {
      if (typeof raw !== 'object' || raw === null) continue;
      const t = raw as Partial<LocalScanTicket>;
      if (typeof t.id !== 'string' || typeof t.ticketNumber !== 'string') continue;
      if (!byId.has(t.id)) {
        byId.set(t.id, {
          id: t.id,
          ticketNumber: t.ticketNumber,
          clientDisplayName: t.clientDisplayName ?? null,
          assetModel: t.assetModel ?? null,
          assetSerialNumber: t.assetSerialNumber ?? null,
          assetInventoryNumber: t.assetInventoryNumber ?? null,
          barcode: t.barcode ?? null,
        });
      }
    }
  }
  return [...byId.values()];
}

function toMatch(t: LocalScanTicket): ScanMatch {
  return {
    id: t.id,
    ticketNumber: t.ticketNumber,
    clientDisplayName: t.clientDisplayName,
    assetModel: t.assetModel,
  };
}

/**
 * Заявки, подходящие под код.
 *
 * Сначала ТОЧНОЕ совпадение — камера отдаёт код целиком, и точное попадание
 * не должно тонуть среди похожих. Если точного нет, пробуем «содержит»: так
 * ищут руками, когда с наклейки читается только часть номера.
 */
export function findLocalScanMatches(
  tickets: readonly LocalScanTicket[],
  query: string,
): ScanMatch[] {
  const q = norm(query);
  if (!q) return [];

  const fields = (t: LocalScanTicket) => [
    norm(t.barcode),
    norm(t.ticketNumber),
    norm(t.assetSerialNumber),
    norm(t.assetInventoryNumber),
  ];

  const exact = tickets.filter((t) => fields(t).some((v) => v !== '' && v === q));
  if (exact.length > 0) return exact.map(toMatch);

  return tickets.filter((t) => fields(t).some((v) => v !== '' && v.includes(q))).map(toMatch);
}
