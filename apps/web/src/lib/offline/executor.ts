/**
 * executeOrQueue: выполняет мутацию через переданный mutateAsync,
 * а при сетевом сбое складывает её в outbox для последующего воспроизведения.
 *
 * Решение «сетевой ли сбой» намеренно консервативное: если запрос вернулся
 * с TRPC-кодом (BAD_REQUEST, FORBIDDEN, NOT_FOUND, INTERNAL_SERVER_ERROR) —
 * это бизнес-ошибка, в очередь НЕ кладём. Очередь — только для случаев,
 * когда сервер не ответил вообще (offline, fetch failed).
 *
 * Возвращает дискриминированный результат — UI сам решает что показать.
 */
import { TRPCClientError } from '@trpc/client';
import { enqueue, listPending, remove, update, type MutationKind, type OutboxItem } from './queue';
import { getCurrentUserId } from './current-user';

export type ExecResult<T> =
  | { status: 'ok'; data: T }
  | { status: 'queued'; item: OutboxItem }
  | { status: 'error'; error: Error };

/** True если ошибка похожа на сетевой сбой (нет связи / DNS / CORS preflight failure). */
function isNetworkError(err: unknown): boolean {
  if (!navigator.onLine) return true;
  if (err instanceof TypeError) return true; // fetch throws TypeError on network failure
  if (err instanceof TRPCClientError) {
    // TRPCClientError со встроенным cause === TypeError (Failed to fetch)
    if (err.cause instanceof TypeError) return true;
    // У TRPCClientError для сетевых ошибок нет data.code (data is null)
    if (err.data == null) return true;
  }
  return false;
}

export async function executeOrQueue<P, T>(
  kind: MutationKind,
  payload: P,
  fn: (payload: P) => Promise<T>,
  tenantSubdomain: string | null,
  /** Склейка повторов одной сущности — см. OutboxItem.dedupeKey. */
  dedupeKey?: string,
  /** Номер заявки или название задачи — чтобы человек узнал запись глазами. */
  label?: string,
): Promise<ExecResult<T>> {
  try {
    const data = await fn(payload);
    return { status: 'ok', data };
  } catch (err) {
    if (isNetworkError(err)) {
      const item = await enqueue<P>(kind, payload, tenantSubdomain, dedupeKey, label);
      return { status: 'queued', item };
    }
    return { status: 'error', error: err instanceof Error ? err : new Error(String(err)) };
  }
}

/**
 * Сессия кончилась, пока человек работал без связи.
 *
 * Это НЕ отказ по существу: правка верная, просто её сейчас некому принять.
 * Раньше очередь считала такой ответ обычной бизнес-ошибкой и стирала ВСЮ
 * накопленную за смену работу — молча, одним числом в тосте.
 */
function isSessionExpired(err: unknown): boolean {
  if (!(err instanceof TRPCClientError)) return false;
  const code = (err.data as { code?: string } | null | undefined)?.code;
  return code === 'UNAUTHORIZED';
}

/**
 * Воспроизведение: вытягивает все pending записи и пробует выполнить через
 * runner (tRPC vanilla client передаётся снаружи, чтобы не тащить React-зависимость).
 *
 * Семантика повторов:
 *  - успех                → запись удаляется;
 *  - нет связи            → остаётся, attempts++, повторим сами;
 *  - сессия кончилась     → остаётся ЧИСТОЙ, просим войти заново;
 *  - отказ по существу    → ОСТАЁТСЯ с пометкой «не принято» и причиной,
 *                           но сама больше не повторяется;
 *  - запись чужая         → не трогаем вовсе, ждёт своего человека.
 *
 * Ключевое отличие от прежнего поведения: ничего не удаляется молча. Раньше
 * отказ стирал работу инженера навсегда, а он видел только число в тосте.
 */
export interface SyncResult {
  succeeded: number;
  /** Нет связи — остались в очереди, повторим сами. */
  failedSoft: number;
  /** Отказ по существу — остались с пометкой, ждут человека. */
  failedHard: number;
  /** Записи другого сотрудника — пропущены. */
  skippedOther: number;
  /** Сервер ответил «вы не авторизованы» — нужен повторный вход. */
  needsLogin: boolean;
}

const EMPTY_RESULT: SyncResult = {
  succeeded: 0,
  failedSoft: 0,
  failedHard: 0,
  skippedOther: 0,
  needsLogin: false,
};

/**
 * Отправка идёт ровно одна за раз. Слушателей очереди несколько (оболочка
 * приложения, экран профиля, событие «связь вернулась»), и без этого замка два
 * одновременных прохода взяли бы один и тот же список — правка ушла бы дважды.
 */
let syncInProgress = false;

export async function syncOutbox(
  runner: (item: OutboxItem) => Promise<unknown>,
): Promise<SyncResult> {
  if (syncInProgress) return { ...EMPTY_RESULT };
  syncInProgress = true;
  try {
    return await runSync(runner);
  } finally {
    syncInProgress = false;
  }
}

async function runSync(runner: (item: OutboxItem) => Promise<unknown>): Promise<SyncResult> {
  const items = await listPending();
  const currentUserId = getCurrentUserId();
  const result: SyncResult = { ...EMPTY_RESULT };
  for (const item of items) {
    // Уже отвергнутое сервером не долбим при каждом возврате связи —
    // ждём, пока человек нажмёт «Повторить».
    if (item.failedHard) continue;
    // Чужая работа: инженер А вышел, вошёл Б. Отправить от имени Б нельзя
    // (это его зарплата), стереть тоже нельзя — пусть дождётся автора.
    if (item.userId && currentUserId && item.userId !== currentUserId) {
      result.skippedOther++;
      continue;
    }
    try {
      await runner(item);
      await remove(item.id);
      result.succeeded++;
    } catch (err) {
      if (isNetworkError(err)) {
        await update({
          ...item,
          attempts: item.attempts + 1,
          lastError: err instanceof Error ? err.message : String(err),
        });
        result.failedSoft++;
      } else if (isSessionExpired(err)) {
        // Правка верная — просто некому принять. Держим её ЧИСТОЙ, чтобы
        // после входа ушла сама, и просим человека войти.
        result.needsLogin = true;
        result.failedSoft++;
      } else {
        await update({
          ...item,
          attempts: item.attempts + 1,
          failedHard: true,
          lastError: err instanceof Error ? err.message : String(err),
        });
        result.failedHard++;
      }
    }
  }
  return result;
}
