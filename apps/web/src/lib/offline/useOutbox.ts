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
import { useQueryClient } from '@tanstack/react-query';
import { count, countSendable, subscribe } from './queue';
import { countPendingPhotos, countSendablePhotos, subscribePhotos } from './photo-queue';
import { subscribeCurrentUser } from './current-user';
import { syncOutbox, type SyncResult } from './executor';
import { sendPendingPhotos, type PhotoSyncResult } from './photo-sender';
import { runOutboxItem, uploadPendingPhoto } from './runner';
import { showToast } from '../toast';

/** Человеческий отчёт по итогам отправки очереди. */
export function reportSync(r: SyncResult, photos?: PhotoSyncResult): void {
  const sent = r.succeeded + (photos?.succeeded ?? 0);
  const stuck = r.failedSoft + (photos?.failedSoft ?? 0);
  const photosRejected = photos?.failedHard ?? 0;
  if (
    sent === 0 &&
    stuck === 0 &&
    r.failedHard === 0 &&
    photosRejected === 0 &&
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
  // При протухшей сессии про «связи всё ещё нет» молчим — причина другая,
  // и она уже названа выше.
  if (stuck > 0 && !r.needsLogin) {
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
  /** Сколько всего лежит в очередях — это число видит человек. */
  pending: number;
  /**
   * Сколько из них реально уйдёт при следующей отправке.
   *
   * Отличается от `pending` застрявшим: отклонённое сервером ждёт человека,
   * чужое — своего автора. Раньше этой величины не было, и приложение
   * бесконечно запускало отправку, которая ничего не отправляла: очередь
   * никогда не пустела, а каждый круг перезапускал сам себя.
   */
  sendable: number;
  isOnline: boolean;
  isSyncing: boolean;
}

export function useOutbox() {
  const queryClient = useQueryClient();
  const [state, setState] = useState<OutboxState>({
    pending: 0,
    sendable: 0,
    isOnline: typeof navigator === 'undefined' ? true : navigator.onLine,
    isSyncing: false,
  });

  const refreshCount = useCallback(async () => {
    const [mutations, photos, sendableMutations, sendablePhotos] = await Promise.all([
      count(),
      countPendingPhotos(),
      countSendable(),
      countSendablePhotos(),
    ]);
    const n = mutations + photos;
    const s2 = sendableMutations + sendablePhotos;
    setState((s) =>
      s.pending === n && s.sendable === s2 ? s : { ...s, pending: n, sendable: s2 },
    );
  }, []);

  useEffect(() => {
    void refreshCount();
    const unsub = subscribe(() => {
      void refreshCount();
    });
    const unsubPhotos = subscribePhotos(() => {
      void refreshCount();
    });
    // Смена человека меняет «что можно отправить», не меняя саму очередь:
    // при запуске имя вошедшего приходит позже очереди, и до него отправка
    // молчит. Пришло — пересчитываем, автосинк подхватывает своё.
    const unsubUser = subscribeCurrentUser(() => {
      void refreshCount();
    });
    return () => {
      unsub();
      unsubPhotos();
      unsubUser();
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
      // Что-то реально ушло — перечитываем экраны. Без этого инженер видит
      // «Отправлено 1», а его комментарий в истории не появляется: данные на
      // сервере уже новые, а на экране лежат старые. Так недолго и написать
      // ту же работу второй раз.
      if (r.succeeded > 0 || photos.succeeded > 0) {
        await queryClient.invalidateQueries();
      }
      reportSync(r, photos);
      return r;
    } finally {
      setState((s) => ({ ...s, isSyncing: false }));
    }
  }, [refreshCount, queryClient]);

  // Авто-синк при возврате онлайн, если накопилось то, что реально уйдёт.
  // Считаем именно `sendable`: по `pending` этот эффект крутился вечно —
  // застрявшая запись не убывала, условие оставалось истинным, а смена
  // isSyncing туда-обратно перезапускала эффект на новый круг.
  useEffect(() => {
    if (!state.isOnline || state.isSyncing || state.sendable === 0) return;
    void sync();
  }, [state.isOnline, state.isSyncing, state.sendable, sync]);

  return { ...state, sync };
}
