/**
 * useOutbox — React-хук для подписки на состояние оффлайн-очереди.
 * Возвращает {pending, isOnline, sync} и автоматически запускает sync при
 * переходе offline → online. UI должен сам показывать тост по итогу.
 */
import { useCallback, useEffect, useState } from 'react';
import { count, listPending, subscribe } from './queue';
import { syncOutbox, type SyncResult } from './executor';
import { runOutboxItem } from './runner';

export interface OutboxState {
  pending: number;
  isOnline: boolean;
  isSyncing: boolean;
}

export function useOutbox() {
  const [state, setState] = useState<OutboxState>({
    pending: 0,
    isOnline: typeof navigator === 'undefined' ? true : navigator.onLine,
    isSyncing: false,
  });

  const refreshCount = useCallback(async () => {
    const n = await count();
    setState((s) => (s.pending === n ? s : { ...s, pending: n }));
  }, []);

  useEffect(() => {
    void refreshCount();
    const unsub = subscribe(() => {
      void refreshCount();
    });
    return unsub;
  }, [refreshCount]);

  useEffect(() => {
    const onOnline = () => setState((s) => ({ ...s, isOnline: true }));
    const onOffline = () => setState((s) => ({ ...s, isOnline: false }));
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  const sync = useCallback(async (): Promise<SyncResult> => {
    setState((s) => ({ ...s, isSyncing: true }));
    try {
      const r = await syncOutbox(runOutboxItem);
      await refreshCount();
      return r;
    } finally {
      setState((s) => ({ ...s, isSyncing: false }));
    }
  }, [refreshCount]);

  // Авто-синк при возврате онлайн, если что-то накопилось
  useEffect(() => {
    if (!state.isOnline) return;
    void (async () => {
      const items = await listPending();
      if (items.length > 0 && !state.isSyncing) {
        await sync();
      }
    })();
  }, [state.isOnline, state.isSyncing, sync]);

  return { ...state, sync };
}
