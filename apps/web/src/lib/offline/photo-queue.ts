/**
 * Очередь фото, ждущих отправки.
 *
 * ЗАЧЕМ ОТДЕЛЬНО ОТ ОЧЕРЕДИ ПРАВОК. Текстовую правку можно положить в очередь
 * как есть и повторить один вызов. С фото так нельзя: отправка идёт в три
 * шага (получить ссылку → залить файл в хранилище → подтвердить), а ссылка
 * живёт 15 минут. Значит, повторять надо ВСЕ три шага, а до тех пор хранить
 * сам файл.
 *
 * Раньше непринятое фото жило в состоянии React — ровно пока открыт экран.
 * Инженер снял повреждение, нажал «назад» — снимка нет; переснять уже нельзя,
 * аппарат собран.
 *
 * Файл лежит как сырые байты (ArrayBuffer), а не как Blob и не как base64:
 * base64 раздул бы снимок на треть, а Blob в IndexedDB исторически подводит
 * на iOS. Blob собирается обратно при отправке и для превью — `photoBlob()`.
 */
import { openDB, type IDBPDatabase } from 'idb';

export type AttachmentKind =
  | 'ticket_photo'
  | 'asset_photo'
  | 'inventory_receipt'
  | 'damage_photo'
  | 'completion_photo'
  | 'contract_signed'
  | 'document';

export type AttachmentRefType =
  | 'ticket'
  | 'asset'
  | 'inventory_batch'
  | 'work_order_line'
  | 'contract';

export interface PendingPhoto {
  id: string;
  kind: AttachmentKind;
  referenceType: AttachmentRefType;
  referenceId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  bytes: ArrayBuffer;
  createdAt: number;
  attempts: number;
  lastError?: string;
  /**
   * Отказ по существу: хранилище или сервер файл не приняли. Такое фото
   * НЕ удаляем (это единственный снимок) и НЕ повторяем само — иначе оно
   * билось бы в стену при каждом возврате связи. Ждёт решения человека.
   */
  failedHard?: boolean;
  tenantSubdomain: string | null;
}

/**
 * Сколько неотправленных фото держим в памяти телефона.
 *
 * Снимок с телефона — 3–8 МБ, то есть это два-три десятка кадров: смена
 * инженера без связи с запасом. Больше держать нельзя: браузер сам начнёт
 * выбрасывать хранилище, и мы потеряем ВСЁ, а не последний кадр.
 */
export const PHOTO_QUEUE_MAX_BYTES = 100 * 1024 * 1024;

const DB_NAME = 'erfolg-offline-photos';
const DB_VERSION = 1;
const STORE = 'photos';

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
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(0);
}

/** Текст при переполнении: что случилось и что с этим делать. */
export function photoQueueFullMessage(usedBytes: number, incomingBytes: number): string {
  return (
    `Не помещается: в памяти телефона уже ${mb(usedBytes)} МБ неотправленных фото` +
    ` (предел ${mb(PHOTO_QUEUE_MAX_BYTES)} МБ), а этот файл — ${mb(incomingBytes)} МБ.` +
    ' Выйдите туда, где есть связь, дождитесь отправки — и снимайте дальше.'
  );
}

export class PhotoQueueFullError extends Error {
  constructor(usedBytes: number, incomingBytes: number) {
    super(photoQueueFullMessage(usedBytes, incomingBytes));
    this.name = 'PhotoQueueFullError';
  }
}

export interface EnqueuePhotoInput {
  kind: AttachmentKind;
  referenceType: AttachmentRefType;
  referenceId: string;
  file: File;
  tenantSubdomain: string | null;
  /** Причина, по которой фото сюда попало — показываем её человеку. */
  lastError?: string;
  /** Отказ по существу: класть в очередь, но само не повторять. */
  failedHard?: boolean;
}

export async function enqueuePhoto(input: EnqueuePhotoInput): Promise<PendingPhoto> {
  const used = await pendingPhotoBytes();
  if (used + input.file.size > PHOTO_QUEUE_MAX_BYTES) {
    throw new PhotoQueueFullError(used, input.file.size);
  }
  const item: PendingPhoto = {
    id: newId(),
    kind: input.kind,
    referenceType: input.referenceType,
    referenceId: input.referenceId,
    fileName: input.file.name,
    mimeType: input.file.type,
    sizeBytes: input.file.size,
    bytes: await input.file.arrayBuffer(),
    createdAt: Date.now(),
    attempts: 0,
    tenantSubdomain: input.tenantSubdomain,
    ...(input.lastError ? { lastError: input.lastError } : {}),
    ...(input.failedHard ? { failedHard: true } : {}),
  };
  const db = await getDb();
  await db.put(STORE, item);
  notify();
  return item;
}

/** Файл для отправки и для превью в галерее. */
export function photoBlob(item: PendingPhoto): Blob {
  return new Blob([item.bytes], { type: item.mimeType });
}

export async function listPendingPhotos(filter?: {
  referenceType: AttachmentRefType;
  referenceId: string;
}): Promise<PendingPhoto[]> {
  const db = await getDb();
  const all = (await db.getAllFromIndex(STORE, 'byCreatedAt')) as PendingPhoto[];
  if (!filter) return all;
  return all.filter(
    (p) => p.referenceType === filter.referenceType && p.referenceId === filter.referenceId,
  );
}

export async function updatePhoto(item: PendingPhoto): Promise<void> {
  const db = await getDb();
  await db.put(STORE, item);
  notify();
}

export async function removePhoto(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE, id);
  notify();
}

/** Снять пометку «не принято», чтобы фото снова участвовало в отправке. */
export async function retryPhoto(id: string): Promise<void> {
  const db = await getDb();
  const item = (await db.get(STORE, id)) as PendingPhoto | undefined;
  if (!item) return;
  const { failedHard: _dropped, lastError: _alsoDropped, ...rest } = item;
  await db.put(STORE, { ...rest, attempts: 0 });
  notify();
}

export async function countPendingPhotos(): Promise<number> {
  const db = await getDb();
  return db.count(STORE);
}

export async function pendingPhotoBytes(): Promise<number> {
  const all = await listPendingPhotos();
  return all.reduce((sum, p) => sum + p.sizeBytes, 0);
}

export async function clearAllPhotos(): Promise<void> {
  const db = await getDb();
  await db.clear(STORE);
  notify();
}

// --- подписка, чтобы бейдж в шапке перерисовывался без опроса ---------------

type Listener = () => void;
const listeners: Set<Listener> = new Set();

function notify() {
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* подписчик не должен ронять очередь */
    }
  }
}

export function subscribePhotos(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
