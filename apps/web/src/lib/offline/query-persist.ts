/**
 * Память приложения между запусками: снимок кэша react-query в IndexedDB.
 *
 * ЗАЧЕМ. До этого кэш жил только в оперативной памяти вкладки. Инженер закрыл
 * приложение (или система выгрузила PWA, что на телефоне происходит постоянно)
 * — и в подвале больницы, где связи нет, он видел не свою очередь, а экран
 * входа: `auth.me` не отвечает → App.tsx показывает LoginPage. Теперь при
 * старте снимок поднимается, и приложение открывается таким, каким было
 * в последний раз со связью.
 *
 * ЧТО ИМЕННО СОХРАНЯЕТСЯ — см. persisted-queries.ts (белый список, ПДн туда
 * не попадают).
 *
 * ПОРЯДОК ПРИ СТАРТЕ ВАЖЕН: сначала поднять снимок, потом рисовать приложение.
 * Иначе первый кадр — это экран входа, и инженер успевает его увидеть.
 */
import { openDB, type IDBPDatabase } from 'idb';
import { dehydrate, hydrate, type DehydratedState, type QueryClient } from '@tanstack/react-query';
import { lastSyncedAt, shouldPersistQuery } from './persisted-queries';
import { noteSync } from './last-sync';

const DB_NAME = 'erfolg-offline-cache';
const DB_VERSION = 1;
const STORE = 'query-cache';
const RECORD_ID = 'engineer';

/**
 * Поднимаем только снимок своей версии. Поднять число — когда меняется ФОРМА
 * сохраняемых ответов (поле убрали или переименовали): старый снимок мог бы
 * отрисоваться экраном с ошибкой. Добавление полей номер менять не требует.
 */
export const CACHE_SCHEMA_VERSION = 1;

/** Старше недели — уже не «последнее, что успело загрузиться», а музей. */
export const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Сколько ответов держим. Очередь, задачи, склад и полсотни открытых заявок —
 * с запасом; без предела снимок рос бы с каждой открытой карточкой.
 */
export const CACHE_MAX_ENTRIES = 60;

export interface CacheSnapshot {
  id: string;
  schemaVersion: number;
  savedAt: number;
  state: DehydratedState;
}

type StoredQuery = DehydratedState['queries'][number];

function updatedAt(q: StoredQuery): number {
  return q.state.dataUpdatedAt ?? 0;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      },
    });
  }
  return dbPromise;
}

/**
 * Слить уже сохранённое со свежим.
 *
 * ЗАЧЕМ СЛИВАТЬ, А НЕ ПЕРЕЗАПИСЫВАТЬ. Запуск без связи выглядит так: снимок
 * поднялся, экран нарисовался, и тут же каждый запрос уходит в сеть, которой
 * нет, и падает. Если после этого записать снимок «из того, что сейчас успешно
 * загружено», он окажется пустым — офлайн-память сама себя стирала бы после
 * первого же запуска без связи, и на второй инженер видел бы экран входа.
 *
 * Поэтому упавший запрос не отменяет прежний ответ: он просто не приносит
 * нового. Заменяем только то, что сейчас успешно перезагрузилось.
 */
function mergeQueries(previous: StoredQuery[], fresh: StoredQuery[]): StoredQuery[] {
  const byHash = new Map<string, StoredQuery>();
  for (const q of previous) byHash.set(q.queryHash, q);
  for (const q of fresh) byHash.set(q.queryHash, q);
  const cutoff = Date.now() - CACHE_MAX_AGE_MS;
  return [...byHash.values()]
    .filter((q) => shouldPersistQuery(q.queryKey) && updatedAt(q) > cutoff)
    .sort((a, b) => updatedAt(b) - updatedAt(a))
    .slice(0, CACHE_MAX_ENTRIES);
}

/** Снять снимок разрешённых запросов и записать его. Ошибки хранилища глушим. */
export async function persistNow(queryClient: QueryClient): Promise<void> {
  const fresh = dehydrate(queryClient, {
    // Только успешно загруженное и только из белого списка. Ошибки и «в процессе»
    // не сохраняем — но и не считаем поводом забыть прежний ответ (см. mergeQueries).
    shouldDehydrateQuery: (q) => q.state.status === 'success' && shouldPersistQuery(q.queryKey),
    shouldDehydrateMutation: () => false,
  });
  const previous = await readSnapshot();
  const keepPrevious =
    previous && previous.schemaVersion === CACHE_SCHEMA_VERSION ? previous.state.queries : [];
  const queries = mergeQueries(keepPrevious, fresh.queries);
  noteSync(lastSyncedAt(queries));
  await writeSnapshot({
    id: RECORD_ID,
    schemaVersion: CACHE_SCHEMA_VERSION,
    savedAt: Date.now(),
    state: { ...fresh, queries },
  });
}

export async function writeSnapshot(snapshot: CacheSnapshot): Promise<void> {
  try {
    const db = await getDb();
    await db.put(STORE, snapshot);
  } catch {
    // Приватный режим, кончилось место, запрет на хранилище — приложение
    // продолжает работать ровно так, как работало до этой правки.
  }
}

export async function readSnapshot(): Promise<CacheSnapshot | undefined> {
  try {
    const db = await getDb();
    return (await db.get(STORE, RECORD_ID)) as CacheSnapshot | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Поднять снимок в кэш. Возвращает true, если что-то подняли.
 * Вызывать ДО первой отрисовки приложения.
 */
export async function restorePersistedQueries(queryClient: QueryClient): Promise<boolean> {
  const snapshot = await readSnapshot();
  if (!snapshot) return false;
  if (snapshot.schemaVersion !== CACHE_SCHEMA_VERSION) {
    await clearPersistedQueries();
    return false;
  }
  // Возраст считаем по каждому ответу, а не по снимку целиком: снимок
  // переписывается при каждом обновлении, и общая дата ничего не сказала бы
  // о заявке, которую последний раз видели неделю назад.
  const cutoff = Date.now() - CACHE_MAX_AGE_MS;
  const queries = snapshot.state.queries.filter((q) => updatedAt(q) > cutoff);
  if (queries.length === 0) {
    await clearPersistedQueries();
    return false;
  }
  try {
    hydrate(queryClient, { ...snapshot.state, queries });
  } catch {
    // Снимок оказался нечитаемым — начинаем с чистого листа, а не падаем.
    await clearPersistedQueries();
    return false;
  }
  noteSync(lastSyncedAt(queries));
  return true;
}

/** Выход из аккаунта: на диске не должно остаться ничего от прошлого человека. */
export async function clearPersistedQueries(): Promise<void> {
  noteSync(null);
  try {
    const db = await getDb();
    await db.delete(STORE, RECORD_ID);
  } catch {
    /* нечего чистить */
  }
}

/**
 * Следить за кэшем и записывать снимок. Пишем с задержкой: за одну загрузку
 * экрана кэш меняется десятки раз, и запись на каждое изменение — лишняя
 * работа для телефона.
 */
export function startPersistingQueries(queryClient: QueryClient, delayMs = 1_000): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    const queryKey = event.query.queryKey as readonly unknown[];
    if (!shouldPersistQuery(queryKey)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void persistNow(queryClient);
    }, delayMs);
  });
  return () => {
    if (timer) clearTimeout(timer);
    unsubscribe();
  };
}
