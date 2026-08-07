/**
 * useOutbox — React-хук для подписки на состояние оффлайн-очереди.
 * Возвращает {pending, isOnline, sync} и автоматически запускает sync при
 * переходе offline → online.
 *
 * Итог синхронизации показывается сам — через общий тост. Раньше результат
 * молча выбрасывался, и записи, отклонённые сервером, исчезали бесследно.
 */
import { useCallback, useEffect, useState } from 'react';
import { count, listPending, subscribe } from './queue';
import { syncOutbox, type SyncResult } from './executor';
import { runOutboxItem } from './runner';
import { showToast } from '../toast';

/** Человеческий отчёт по итогам отправки очереди. */
export function reportSync(r: SyncResult): void {
  if (
    r.succeeded === 0 &&
    r.failedSoft === 0 &&
    r.failedHard === 0 &&
    r.skippedOther === 0 &&
    !r.needsLogin
  ) {
    return;
  }

  // Сессия кончилась, пока человек работал без связи. Раньше это считалось
  // отказом по существу и стирало ВСЮ накопленную за смену работу молча.
  if (r.needsLogin) {
    showToast(
      'error',
      'Вход в систему закончился — войдите заново. Накопленное сохранено и уйдёт само.',
    );
  }
  // Отклонённое сервером теперь не пропадает: оно лежит в «Профиль → Не
  // отправлено», где видно, что именно и почему, и можно повторить.
  if (r.failedHard > 0) {
    showToast(
      'error',
      `Сервер не принял ${r.failedHard} ${plural(r.failedHard, 'изменение', 'изменения', 'изменений')}` +
        ' — они сохранены, откройте «Профиль → Не отправлено»',
    );
  }
  if (r.skippedOther > 0) {
    showToast(
      'queued',
      `${r.skippedOther} ${plural(r.skippedOther, 'изменение', 'изменения', 'изменений')} другого сотрудника` +
        ' — уйдут, когда он войдёт на этом телефоне',
    );
  }
  if (r.succeeded > 0) {
    showToast(
      'ok',
      `Отправлено ${r.succeeded} ${plural(r.succeeded, 'изменение', 'изменения', 'изменений')}`,
    );
  }
  if (r.failedSoft > 0 && !r.needsLogin) {
    showToast('queued', `Связи всё ещё нет — ${r.failedSoft} в очереди, попробуем позже`);
  }
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

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
      reportSync(r);
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
