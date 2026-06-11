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

export type MutationKind =
  | 'tickets.changeStatus'
  | 'tickets.addNote'
  | 'workOrders.upsertLine'
  | 'workOrders.deleteLine'
  | 'workOrders.updateHeader'
  // Этап 5: списание со склада в наряд (FEFO). На сервере: SELECT FOR UPDATE.
  // При NOT_ENOUGH_STOCK сервер возвращает UNPROCESSABLE_CONTENT — это бизнес-ошибка,
  // не сетевая, поэтому при синке мутация пометится как failedHard и не повторится.
  | 'inventoryMovements.issueToWorkOrder'
  // Этап 5: запись о выполненном ТО.
  | 'maintenance.recordPerformed';

export interface OutboxItem<P = unknown> {
  id: string;
  kind: MutationKind;
  payload: P;
  createdAt: number;
  attempts: number;
  /** Заголовок tenant — мутации могут «зависнуть» после смены tenant, тогда воспроизведение пропустится. */
  tenantSubdomain: string | null;
  lastError?: string;
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
): Promise<OutboxItem<P>> {
  const db = await getDb();
  const item: OutboxItem<P> = {
    id: newId(),
    kind,
    payload,
    createdAt: Date.now(),
    attempts: 0,
    tenantSubdomain,
  };
  await db.put(STORE, item);
  notify();
  return item;
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
