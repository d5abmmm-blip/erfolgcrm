/**
 * Отправка накопленных фото. Сама загрузка передаётся снаружи, чтобы этот
 * файл не зависел ни от React, ни от tRPC-клиента (см. photo-runner.ts).
 *
 * Семантика повторов — не такая, как у очереди правок, и намеренно:
 *   - нет связи        → фото остаётся, попробуем в следующий раз;
 *   - отказ по существу→ фото ОСТАЁТСЯ с пометкой «не принято» и причиной,
 *                        но само больше не повторяется.
 *
 * Почему отказ не удаляет файл: снимок повреждённого аппарата — единственный,
 * переснять его после сдачи объекта нельзя. Пусть лучше висит в списке
 * «не отправлено», где человек решит: повторить или убрать.
 */
import { isNetworkError } from './executor';
import { humanUploadError } from '../photo-upload-error';
import {
  isPhotoSendable,
  listPendingPhotos,
  removePhoto,
  updatePhoto,
  type PendingPhoto,
} from './photo-queue';
import { getCurrentUserId } from './current-user';

export interface PhotoSyncResult {
  succeeded: number;
  /** Нет связи — остались в очереди, повторим сами. */
  failedSoft: number;
  /** Не приняты по существу — остались, но ждут человека. */
  failedHard: number;
  /** Снимки другого сотрудника — пропущены, ждут своего автора. */
  skippedOther: number;
}

export type PhotoUploader = (item: PendingPhoto) => Promise<void>;

/** Отправка идёт по одной за раз — слушателей очереди несколько. */
let sendInProgress = false;

export async function sendPendingPhotos(upload: PhotoUploader): Promise<PhotoSyncResult> {
  if (sendInProgress) return { succeeded: 0, failedSoft: 0, failedHard: 0, skippedOther: 0 };
  sendInProgress = true;
  try {
    return await runSend(upload);
  } finally {
    sendInProgress = false;
  }
}

async function runSend(upload: PhotoUploader): Promise<PhotoSyncResult> {
  const items = await listPendingPhotos();
  const currentUserId = getCurrentUserId();
  let succeeded = 0;
  let failedSoft = 0;
  let failedHard = 0;
  let skippedOther = 0;
  for (const item of items) {
    // Уже отвергнутое сервером не долбим при каждом возврате связи.
    if (item.failedHard) continue;
    // Чужой снимок: уйдёт под чужой сессией и запишется на другого человека.
    if (!isPhotoSendable(item, currentUserId)) {
      skippedOther++;
      continue;
    }
    try {
      await upload(item);
      await removePhoto(item.id);
      succeeded++;
    } catch (err) {
      const soft = isNetworkError(err);
      await updatePhoto({
        ...item,
        attempts: item.attempts + 1,
        lastError: humanUploadError(err),
        ...(soft ? {} : { failedHard: true }),
      });
      if (soft) failedSoft++;
      else failedHard++;
    }
  }
  return { succeeded, failedSoft, failedHard, skippedOther };
}
