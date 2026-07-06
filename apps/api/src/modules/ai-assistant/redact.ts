/**
 * Вырезание ПДн клиентов из результатов read-инструментов ПЕРЕД отправкой в LLM.
 *
 * Зачем (PII-1, аудит 2026-07-06): когда модель вызывает get_ticket / search_tickets /
 * search_clients, система сама подкладывает в промпт имя/телефон/адрес клиента из БД, и
 * это уходит во внешний LLM (z.ai, серверы в КНР) — трансграничная передача ПДн, которую
 * оператор не контролирует (в отличие от текста, который он печатает сам). Здесь мы
 * заменяем значения известных ПДн-полей на заглушку, поэтому имена/контакты клиентов
 * во внешний сервис больше НЕ уходят через инструменты.
 *
 * Что НЕ трогаем осознанно:
 *  - имена ИНЖЕНЕРОВ/сотрудников (assignedEngineerName / engineerName / fullName / name) —
 *    это сотрудники самой организации, и они нужны модели для подсказок по назначению;
 *    решение владельца при приёмке (можно ужесточить позже).
 *  - модель/серийник/инвентарник техники, номера/суммы/статусы — не ПДн, полезны модели.
 *
 * Важно про контакты: ключи `phone`/`email`/`address` вырезаются ГЛОБАЛЬНО (любой объект),
 * поэтому у результата list_engineers телефон/почта инженера тоже скрываются. Это осознанно
 * (fail-safe: во внешний LLM контакты не уходят вообще; контракт list_engineers — «id + ФИО»,
 * телефон/почта там и не обещаны). ФИО инженера при этом сохраняется.
 *
 * Замечание: то, что пользователь ПЕЧАТАЕТ сам в чат, этим не закрывается (это его ход) —
 * для этого есть предупреждение в ChatPanel «не загружайте ПДн клиентов». Здесь закрыт
 * ровно системный канал: данные, которые CRM сама достаёт из БД в ответ инструмента.
 */

/** Заглушка вместо значения ПДн-поля. */
export const PII_PLACEHOLDER = '[скрыто: ПДн клиента]';

/**
 * Имена полей с ПДн клиента (имя/контакты). Именно они не должны утекать во внешний LLM.
 * Ключи-имена инженеров сюда НЕ входят (см. модульный комментарий).
 */
const CLIENT_PII_KEYS = new Set<string>([
  'clientDisplayName',
  'clientName',
  'displayName', // в результатах clients.search имя/наименование клиента
  'ownerDisplayName', // в результатах assets.search — имя клиента-владельца техники
  'ownerName',
  'phone',
  'contactPhone',
  'individualPhone',
  'individualAddress',
  'address',
  'email',
  'clientEmail',
  'fullNameEncrypted',
]);

/**
 * ИНН вырезаем ТОЛЬКО у физлиц (ИНН физлица — ПДн, прямо идентифицирует человека). У юрлиц
 * ИНН — публичный бизнес-идентификатор, не ПДн, и полезен модели, поэтому его оставляем.
 * Тип берём из соседнего поля `type` того же объекта (как в результате clients.search).
 */
function isIndividualPersonalInnKey(key: string, siblingType: unknown): boolean {
  return key === 'inn' && siblingType === 'individual';
}

/**
 * Рекурсивно заменяет значения ПДн-полей клиента на заглушку.
 * Возвращает НОВУЮ структуру (исходный объект не мутируется). Массивы/вложенные объекты
 * обходятся; Date/примитивы/null сохраняются как есть (не разбираем на поля).
 */
export function redactClientPii(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(redactClientPii);
  const obj = value as Record<string, unknown>;
  const siblingType = obj.type;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const isPiiKey = CLIENT_PII_KEYS.has(k) || isIndividualPersonalInnKey(k, siblingType);
    if (isPiiKey && typeof v === 'string' && v.length > 0) {
      out[k] = PII_PLACEHOLDER;
    } else {
      out[k] = redactClientPii(v);
    }
  }
  return out;
}
