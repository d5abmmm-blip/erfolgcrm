/**
 * Offline-очередь мутаций для PWA инженера.
 *
 * Принципы:
 *  - QUERIES никогда не идут в очередь — они всегда требуют live read.
 *  - В очередь попадают только **идемпотентно-безопасные** мутации (изменение
 *    статуса, апсерт строки наряда, добавление коммента, обновление шапки наряда).
 *  - Мутация попадает в очередь, если запуск выбросил TRPCClientError из-за
 *    network error (`event.message === 'Failed to fetch'` или offline === false).
 *  - Воспроизведение происходит при возврате связи (`window.online`) и при ручном
 *    «синхронизировать сейчас». В случае TRPC-ошибки 4xx/5xx — мутация удаляется
 *    из очереди (мы не можем её исправить), пишем в outbox-failed для UI badge.
 *  - Каждая запись имеет {id, kind, payload, createdAt, attempts}.
 *
 * Данные хранятся в IndexedDB (через idb). Имя БД — erfolg-offline, store — outbox.
 */
import { openDB, type IDBPDatabase } from 'idb';
import { getCurrentUserId } from './current-user';

export type MutationKind =
  | 'tickets.changeStatus'
  | 'tickets.addNote'
  | 'workOrders.upsertLine'
  | 'workOrders.deleteLine'
  | 'workOrders.updateHeader'
  // Ставка НДС. Инженера не касается (поле выключено), но диспетчер и директор
  // работают и в разъездах, а ставка идёт прямо в счёт клиенту: у медтехники
  // она льготная 5 %, и ошибка видна в документе. Была единственной правкой
  // наряда мимо очереди — без связи просто не проходила.
  | 'workOrders.setVatRate'
  // Этап 5: списание со склада в наряд (FEFO). На сервере: SELECT FOR UPDATE.
  // При NOT_ENOUGH_STOCK сервер возвращает UNPROCESSABLE_CONTENT — это бизнес-ошибка,
  // не сетевая, поэтому при синке мутация пометится как failedHard и не повторится.
  | 'inventoryMovements.issueToWorkOrder'
  // Этап 5: запись о выполненном ТО.
  | 'maintenance.recordPerformed'
  // «Мой день»: реакция инженера одной кнопкой (ещё в работе / готово / жду запчасть).
  | 'tickets.engineerReact'
  // Таск-лист: инженер отмечает свою задачу сделанной/снимает отметку.
  | 'tasks.setDone';

export interface OutboxItem<P = unknown> {
  id: string;
  kind: MutationKind;
  payload: P;
  createdAt: number;
  attempts: number;
  /** Заголовок tenant — мутации могут «зависнуть» после смены tenant, тогда воспроизведение пропустится. */
  tenantSubdomain: string | null;
  lastError?: string;
  /**
   * Кто это сделал. Один телефон в бригаде переходит из рук в руки: без
   * автора правки инженера А уходили бы от имени Б, вместе со строками
   * наряда, от которых считается зарплата.
   *
   * null у записей, сделанных до появления этого поля — их отправляем как
   * раньше, иначе накопленное застряло бы мёртвым грузом после обновления.
   */
  userId?: string | null;
  /**
   * Сервер отказал по существу. Запись НЕ удаляется — это работа человека,
   * и восстановить её иначе нельзя. Сама больше не повторяется: ждёт, пока
   * человек нажмёт «Повторить» или «Убрать».
   */
  failedHard?: boolean;
  /** Что человек узнаёт глазами: номер заявки, название задачи. */
  label?: string;
  /**
   * Ключ склейки. Если задан, новая запись ВЫТЕСНЯЕТ прежнюю с тем же ключом.
   *
   * Нужен для наряда: строка сохраняется по уходу курсора из каждого поля, и без
   * склейки одна новая строка легла бы в очередь трижды (имя, кол-во, цена) —
   * при возврате связи сервер вставил бы три строки вместо одной. С ключом
   * в очереди всегда лежит последнее состояние строки, то есть ровно одна вставка.
   */
  dedupeKey?: string;
}

const DB_NAME = 'erfolg-offline';
const DB_VERSION = 1;
const STORE = 'outbox';

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('byCreatedAt', 'createdAt');
        }
      },
    });
  }
  return dbPromise;
}

function newId(): string {
  // не криптостойкий, но достаточный для уникальности в локальной БД
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function enqueue<P>(
  kind: MutationKind,
  payload: P,
  tenantSubdomain: string | null,
  dedupeKey?: string,
  label?: string,
): Promise<OutboxItem<P>> {
  const db = await getDb();
  let createdAt = Date.now();
  if (dedupeKey) {
    // Вытесняем прежние записи той же сущности, но СОХРАНЯЕМ их место в очереди:
    // порядок отправки должен остаться тем, в котором инженер вводил данные.
    const all = (await db.getAll(STORE)) as OutboxItem[];
    for (const prev of all) {
      if (prev.dedupeKey === dedupeKey) {
        createdAt = Math.min(createdAt, prev.createdAt);
        await db.delete(STORE, prev.id);
      }
    }
  }
  const item: OutboxItem<P> = {
    id: newId(),
    kind,
    payload,
    createdAt,
    attempts: 0,
    tenantSubdomain,
    userId: getCurrentUserId(),
    ...(dedupeKey ? { dedupeKey } : {}),
    ...(label ? { label } : {}),
  };
  await db.put(STORE, item);
  notify();
  return item;
}

/**
 * Снять пометку «сервер не принял» — по кнопке человека. Запись снова
 * участвует в отправке.
 */
export async function retryOutboxItem(id: string): Promise<void> {
  const db = await getDb();
  const item = (await db.get(STORE, id)) as OutboxItem | undefined;
  if (!item) return;
  const { failedHard: _cleared, lastError: _alsoCleared, ...rest } = item;
  await db.put(STORE, { ...rest, attempts: 0 });
  notify();
}

export async function listPending(): Promise<OutboxItem[]> {
  const db = await getDb();
  const all = (await db.getAllFromIndex(STORE, 'byCreatedAt')) as OutboxItem[];
  return all;
}

export async function remove(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE, id);
  notify();
}

/**
 * Убирает из очереди всё, что помечено этим ключом склейки.
 * Нужно, когда инженер отменяет строку наряда, уже уехавшую в очередь:
 * иначе при возврате связи отменённая строка всё равно создалась бы на сервере.
 */
export async function removeByDedupeKey(dedupeKey: string): Promise<number> {
  const db = await getDb();
  const all = (await db.getAll(STORE)) as OutboxItem[];
  let removed = 0;
  for (const item of all) {
    if (item.dedupeKey === dedupeKey) {
      await db.delete(STORE, item.id);
      removed++;
    }
  }
  if (removed > 0) notify();
  return removed;
}

export async function update(item: OutboxItem): Promise<void> {
  const db = await getDb();
  await db.put(STORE, item);
  notify();
}

export async function clearAll(): Promise<void> {
  const db = await getDb();
  await db.clear(STORE);
  notify();
}

export async function count(): Promise<number> {
  const db = await getDb();
  return db.count(STORE);
}

/**
 * Сколько записей реально уйдёт при следующей отправке.
 *
 * Отличается от `count()` тем, что не считает застрявшее: отклонённое
 * сервером (ждёт человека) и чужое (ждёт своего автора). Раньше такие
 * записи считались наравне с живыми, и приложение бесконечно запускало
 * отправку, которая ничего не отправляла, — телефон молотил впустую.
 */
export async function countSendable(): Promise<number> {
  const currentUserId = getCurrentUserId();
  const all = await listPending();
  return all.filter((i) => isSendable(i, currentUserId)).length;
}

/** Запись можно отправить прямо сейчас: не отклонена сервером и не чужая. */
export function isSendable(item: OutboxItem, currentUserId: string | null): boolean {
  if (item.failedHard) return false;
  return !(item.userId && currentUserId && item.userId !== currentUserId);
}

// --- live subscription -----------------------------------------------------
// Простая шина: подписчики получают пуш при любых изменениях очереди,
// чтобы UI badge перерисовывался без поллинга.

type Listener = () => void;
const listeners: Set<Listener> = new Set();

function notify() {
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* swallow listener errors */
    }
  }
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
