/**
 * Что из кэша react-query разрешено класть на диск телефона — и что нельзя никогда.
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ ОТДЕЛЬНО. Решение «сохранять или нет» — это решение о
 * персональных данных, и оно должно быть в одном месте, читаться глазами и
 * проверяться тестом. Сама запись на диск (IndexedDB) живёт в query-persist.ts.
 *
 * ПРАВИЛО. Список БЕЛЫЙ: сохраняется только то, что перечислено здесь явно.
 * Новый запрос по умолчанию на диск не попадает.
 *
 * Отдельно есть чёрный список — подстраховка на будущее. Он избыточен сегодня
 * (белый список и так узкий), но если кто-то однажды решит «а давайте сохранять
 * всё tickets.*», реквизиты клиента всё равно останутся в оперативной памяти.
 */

/**
 * Инженерные запросы: то, без чего кабинет в подвале — пустой экран.
 *
 * `auth.me` здесь не для удобства: без него приложение при холодном старте без
 * связи показывает ЭКРАН ВХОДА (App.tsx: нет me.data → LoginPage), и до очереди
 * инженер просто не доходит.
 *
 * `workOrders.getByTicket` — журнал работ. Записать работу офлайн можно и сейчас
 * (очередь мутаций), но без наряда на экране инженер не видит, что уже записал.
 */
export const PERSISTED_QUERY_PATHS: readonly string[] = [
  'auth.me',
  'tickets.myList',
  'tickets.myTickets',
  'tickets.get',
  'tickets.myWeeklySchedule',
  'workOrders.getByTicket',
  'tasks.myList',
  'inventoryItems.list',
];

/**
 * Не класть на диск ни при каких обстоятельствах.
 *
 * `tickets.documentClient` — телефон и юридический адрес клиента: ПДн, которым
 * незачем лежать в памяти телефона, который могут потерять.
 * `attachments.listByReference` — ссылки на файлы живут 15 минут; сохранённые,
 * они превратятся в битые картинки и будут выглядеть как поломка.
 * `payroll.myEarnings` — зарплата.
 */
export const NEVER_PERSISTED_QUERY_PATHS: readonly string[] = [
  'tickets.documentClient',
  'clients.get',
  'clients.list',
  'clients.search',
  'attachments.listByReference',
  'payroll.myEarnings',
];

const ALLOWED = new Set(PERSISTED_QUERY_PATHS);
const DENIED = new Set(NEVER_PERSISTED_QUERY_PATHS);

/**
 * Путь процедуры из ключа запроса: `[['tickets','myList'], {...}]` → `tickets.myList`.
 * Ключи не от tRPC (у нас такие тоже есть) дают null — их не сохраняем.
 */
export function queryPathOf(queryKey: readonly unknown[]): string | null {
  const head = queryKey[0];
  if (!Array.isArray(head) || head.length === 0) return null;
  if (!head.every((part) => typeof part === 'string')) return null;
  return head.join('.');
}

export function shouldPersistQuery(queryKey: readonly unknown[]): boolean {
  const path = queryPathOf(queryKey);
  if (path === null) return false;
  if (DENIED.has(path)) return false;
  return ALLOWED.has(path);
}

/** Минимум, который нужен для расчёта возраста данных (совместим с react-query). */
export interface SyncedQuery {
  queryKey: readonly unknown[];
  state: { dataUpdatedAt: number };
}

/**
 * Когда в последний раз с сервера приходил ответ по сохраняемым запросам.
 *
 * Считаем ТОЛЬКО по ним: если брать любой запрос, то, например, разовая
 * проверка чего-нибудь при старте обновит время, и подпись «данные от 14:32»
 * соврёт про очередь, которая на самом деле вчерашняя.
 */
export function lastSyncedAt(queries: readonly SyncedQuery[]): number | null {
  let max: number | null = null;
  for (const q of queries) {
    if (!shouldPersistQuery(q.queryKey)) continue;
    const at = q.state.dataUpdatedAt;
    if (!at) continue;
    if (max === null || at > max) max = at;
  }
  return max;
}

/**
 * Подпись под шапкой в офлайне: «данные от 14:32», а за пределами сегодняшнего
 * дня — с датой. Позавчерашний список, показанный как «14:32», читается как
 * свежий — это хуже, чем не показать ничего.
 */
export function offlineDataAgeLabel(at: number | null, now: Date = new Date()): string | null {
  if (at === null) return null;
  const d = new Date(at);
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return `данные от ${time}`;
  const day = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  return `данные от ${day}, ${time}`;
}
