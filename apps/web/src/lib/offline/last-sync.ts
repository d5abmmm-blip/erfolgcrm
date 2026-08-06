/**
 * «Когда в последний раз была связь» — одно число на всё приложение.
 *
 * Нужно, чтобы шапка мобильного кабинета могла честно написать
 * «нет связи · данные от 14:32». Держим отдельным крошечным хранилищем, а не
 * читаем кэш react-query из шапки: оболочка рисуется и там, где провайдера
 * запросов нет, и лишняя зависимость сделала бы её хрупкой.
 *
 * Значение проставляет query-persist.ts — и при сохранении снимка, и при его
 * подъёме после перезапуска.
 */
import { useSyncExternalStore } from 'react';

let lastSyncAt: number | null = null;
const listeners = new Set<() => void>();

export function noteSync(at: number | null): void {
  if (lastSyncAt === at) return;
  lastSyncAt = at;
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* подписчик не должен ронять сохранение */
    }
  }
}

export function getLastSyncAt(): number | null {
  return lastSyncAt;
}

export function subscribeLastSync(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useLastSyncAt(): number | null {
  return useSyncExternalStore(subscribeLastSync, getLastSyncAt, getLastSyncAt);
}
