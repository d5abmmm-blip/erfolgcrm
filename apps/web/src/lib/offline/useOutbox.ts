/**
 * useOutbox — React-хук для подписки на состояние оффлайн-очереди.
 * Возвращает {pending, isOnline, sync} и автоматически запускает sync при
 * переходе offline → online.
 *
 * Очередей две — правки и фото — но для человека это одна: «сколько всего ещё
 * не ушло». Поэтому бейдж в шапке и кнопка «Синхронизировать» считают и то и
 * другое. Иначе инженер видел бы «онлайн, очередь пуста», пока в памяти
 * телефона лежат неотправленные снимки.
 *
 * Итог синхронизации показывается сам — через общий тост. Раньше результат
 * молча выбрасывался, и записи, отклонённые сервером, исчезали бесследно.
 */
import { useCallback, useEffect, useState } from 'react';
import { count, listPending, subscribe } from './queue';
import { countPendingPhotos, subscribePhotos } from './photo-queue';
import { syncOutbox, type SyncResult } from './executor';
import { sendPendingPhotos, type PhotoSyncResult } from './photo-sender';
import { runOutboxItem, uploadPendingPhoto } from './runner';
import { showToast } from '../toast';

/** Человеческий отчёт по итогам отправки очереди. */
export function reportSync(r: SyncResult, photos?: PhotoSyncResult): void {
  const sent = r.succeeded + (photos?.succeeded ?? 0);
  const stuck = r.failedSoft + (photos?.failedSoft ?? 0);
  const photosRejected = photos?.failedHard ?? 0;
  if (sent === 0 && stuck === 0 && r.failedHard === 0 && photosRejected === 0) return;

  // Отклонённое сервером повторить нельзя — такие записи удалены. Это самое
  // важное в отчёте: работа инженера пропала, и он должен об этом узнать.
  if (r.failedHard > 0) {
    showToast(
      'error',
      `Сервер не принял ${r.failedHard} ${plural(r.failedHard, 'изменение', 'изменения', 'изменений')}` +
        ' — их придётся внести заново',
    );
  }
  // Фото при отказе НЕ пропадает: оно остаётся в карточке заявки с причиной
  // и кнопками «повторить» / «убрать».
  if (photosRejected > 0) {
    showToast(
      'error',
      `Не принято фото: ${photosRejected} — они остались в заявке, откройте её и посмотрите причину`,
    );
  }
  if (sent > 0) {
    showToast('ok', `Отправлено ${sent} ${plural(sent, 'изменение', 'изменения', 'изменений')}`);
  }
  if (stuck > 0) {
    showToast('queued', `Связи всё ещё нет — ${stuck} в очереди, попробуем позже`);
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
    const [mutations, photos] = await Promise.all([count(), countPendingPhotos()]);
    const n = mutations + photos;
    setState((s) => (s.pending === n ? s : { ...s, pending: n }));
  }, []);

  useEffect(() => {
    void refreshCount();
    const unsub = subscribe(() => {
      void refreshCount();
    });
    const unsubPhotos = subscribePhotos(() => {
      void refreshCount();
    });
    return () => {
      unsub();
      unsubPhotos();
    };
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
      // Сначала правки, потом фото: правка может создать строку наряда,
      // к которой фото и относится, обратной зависимости нет.
      const r = await syncOutbox(runOutboxItem);
      const photos = await sendPendingPhotos(uploadPendingPhoto);
      await refreshCount();
      reportSync(r, photos);
      return r;
    } finally {
      setState((s) => ({ ...s, isSyncing: false }));
    }
  }, [refreshCount]);

  // Авто-синк при возврате онлайн, если что-то накопилось
  useEffect(() => {
    if (!state.isOnline) return;
    void (async () => {
      const [items, photos] = await Promise.all([listPending(), countPendingPhotos()]);
      if ((items.length > 0 || photos > 0) && !state.isSyncing) {
        await sync();
      }
    })();
  }, [state.isOnline, state.isSyncing, sync]);

  return { ...state, sync };
}
