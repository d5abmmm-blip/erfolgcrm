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
import {
  enqueue,
  listPending,
  remove,
  update,
  type MutationKind,
  type OutboxItem,
} from './queue';

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
): Promise<ExecResult<T>> {
  try {
    const data = await fn(payload);
    return { status: 'ok', data };
  } catch (err) {
    if (isNetworkError(err)) {
      const item = await enqueue<P>(kind, payload, tenantSubdomain);
      return { status: 'queued', item };
    }
    return { status: 'error', error: err instanceof Error ? err : new Error(String(err)) };
  }
}

/**
 * Воспроизведение: вытягивает все pending записи и пробует выполнить через
 * runner (tRPC vanilla client передаётся снаружи, чтобы не тащить React-зависимость).
 *
 * Семантика повторов:
 *  - сетевая ошибка → запись остаётся, attempts++
 *  - бизнес-ошибка (4xx/5xx с TRPC code) → запись удаляется (нечего повторять)
 *  - успех → запись удаляется
 *
 * Возвращает агрегат для UI badge.
 */
export interface SyncResult {
  succeeded: number;
  failedSoft: number; // network — оставлены в очереди
  failedHard: number; // business error — удалены
}

export async function syncOutbox(
  runner: (item: OutboxItem) => Promise<unknown>,
): Promise<SyncResult> {
  const items = await listPending();
  let succeeded = 0;
  let failedSoft = 0;
  let failedHard = 0;
  for (const item of items) {
    try {
      await runner(item);
      await remove(item.id);
      succeeded++;
    } catch (err) {
      if (isNetworkError(err)) {
        await update({
          ...item,
          attempts: item.attempts + 1,
          lastError: err instanceof Error ? err.message : String(err),
        });
        failedSoft++;
      } else {
        await remove(item.id);
        failedHard++;
      }
    }
  }
  return { succeeded, failedSoft, failedHard };
}
