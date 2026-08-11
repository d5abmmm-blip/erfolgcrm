/**
 * Превращает ошибку мутации в короткую фразу для человека.
 *
 * Зачем: сервер отдаёт в INTERNAL_SERVER_ERROR текст исходной ошибки
 * (`lib/errors.ts:169`) — туда попадает SQL, а Zod присылает JSON-массив.
 * Показывать это сотруднику нельзя, поэтому наружу выпускаем только
 * заранее написанные фразы, а «сырой» текст — лишь когда он заведомо
 * человеческий (доменные ошибки с понятным сообщением).
 */
import { TRPCClientError } from '@trpc/client';

/**
 * Фразы по коду ответа — понятны без объяснений и всегда говорят о судьбе правки.
 *
 * ⚠️ О судьбе можно говорить только то, что ЗНАЕШЬ. UNAUTHORIZED/FORBIDDEN —
 * сервер отказал ДО записи, «не сохранено» честно. А TIMEOUT и
 * INTERNAL_SERVER_ERROR — исход неизвестен: запись могла пройти, а упасть
 * могло уже ПОСЛЕ неё (журнал действий пишется отдельной операцией следом).
 * Прежний текст утверждал «не сохранено, попробуйте ещё раз» — и на операциях
 * без защиты от повтора это превращало удавшееся действие в двойное:
 * списание запчасти, например, уходило со склада дважды.
 */
const BY_CODE: Record<string, string> = {
  UNAUTHORIZED: 'Сессия истекла — войдите заново. Изменение не сохранено',
  FORBIDDEN: 'Недостаточно прав для этого действия. Изменение не сохранено',
  NOT_FOUND: 'Запись не найдена — возможно, её удалил другой сотрудник',
  CONFLICT: 'Запись только что изменил другой сотрудник — обновите страницу',
  TIMEOUT:
    'Сервер не ответил вовремя. Сохранилось ли изменение — неизвестно: обновите страницу и проверьте',
  TOO_MANY_REQUESTS: 'Слишком часто — подождите немного и повторите',
  PAYLOAD_TOO_LARGE: 'Файл слишком большой',
  INTERNAL_SERVER_ERROR:
    'Ошибка на сервере. Сохранилось ли изменение — неизвестно: обновите страницу и проверьте',
};

/** Машинные коды, которые сервер шлёт вместо текста. */
const BY_MACHINE_CODE: Record<string, string> = {
  NOT_ENOUGH_STOCK: 'Недостаточно остатков на складе',
  RETURN_EXCEEDS_BATCH_INITIAL: 'Возврат больше, чем было выдано из партии',
};

const FALLBACK = 'Не удалось сохранить изменение';

/**
 * Те же коды, но для СБОЯ ЗАГРУЗКИ, а не сохранения.
 *
 * Отдельный список нужен из-за концовки: «Изменение не сохранено» после неудачной
 * загрузки — вранье, ничего и не сохранялось. Человек должен понять другое: то,
 * что он видит на экране, — не данные, а пустота из-за ошибки.
 */
const LOAD_BY_CODE: Record<string, string> = {
  UNAUTHORIZED: 'Сессия истекла — войдите заново, чтобы увидеть данные',
  FORBIDDEN: 'Недостаточно прав, чтобы посмотреть эти данные',
  NOT_FOUND: 'Запись не найдена — возможно, её удалил другой сотрудник',
  TIMEOUT: 'Сервер не ответил вовремя — данные не загружены',
  TOO_MANY_REQUESTS: 'Слишком часто — подождите немного и обновите страницу',
  INTERNAL_SERVER_ERROR: 'Ошибка на сервере — данные не загружены',
};

const LOAD_FALLBACK = 'Не удалось загрузить данные';

/**
 * Превращает ошибку ЗАГРУЗКИ (useQuery) в короткую фразу для человека.
 *
 * Зачем отдельно от `humanizeError`: тот написан под мутации и всюду обещает
 * «Изменение не сохранено». Здесь важно не это, а то, что **пустой экран — это
 * ошибка, а не отсутствие данных**. Пустая таблица журнала аудита без такой
 * фразы читается как «нарушений не было».
 */
export function humanizeLoadError(err: unknown): string {
  if (isOfflineError(err)) {
    return 'Нет связи с сервером — данные не загружены';
  }

  if (err instanceof TRPCClientError) {
    const code = (err.data as { code?: string } | null | undefined)?.code;
    const raw = firstLine(err.message);
    if (raw && BY_MACHINE_CODE[raw]) return BY_MACHINE_CODE[raw];
    if (code && LOAD_BY_CODE[code]) return LOAD_BY_CODE[code];
    // SQL из INTERNAL_SERVER_ERROR и JSON от Zod наружу не выпускаем.
    if (looksTechnical(raw)) return LOAD_FALLBACK;
    return raw || LOAD_FALLBACK;
  }

  if (err instanceof Error) {
    const raw = firstLine(err.message);
    return looksTechnical(raw) ? LOAD_FALLBACK : raw || LOAD_FALLBACK;
  }

  return LOAD_FALLBACK;
}

/**
 * Пометка для useMutation: экран показывает ошибку сам (рядом с полем или
 * в диалоге), глобальный тост дублировать не нужно. Читается в main.tsx.
 */
export const SILENT_ERROR = { silentError: true } as const;

/**
 * Похоже ли на сетевой сбой (нет связи, сервер недоступен).
 * Намеренно совпадает с логикой offline/executor.ts — оба места решают
 * один и тот же вопрос «сервер не ответил или ответил отказом».
 */
export function isOfflineError(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return true;
  if (err instanceof TypeError) return true; // fetch бросает TypeError при сетевом сбое
  if (err instanceof TRPCClientError) {
    if (err.cause instanceof TypeError) return true;
    if (err.data == null) return true; // у сетевых ошибок tRPC нет data.code
  }
  return false;
}

export function humanizeError(err: unknown): string {
  if (isOfflineError(err)) {
    return 'Нет связи с сервером. Изменение не сохранено';
  }

  if (err instanceof TRPCClientError) {
    const code = (err.data as { code?: string } | null | undefined)?.code;
    const raw = firstLine(err.message);

    // Машинный код важнее кода ответа: он точнее объясняет причину.
    if (raw && BY_MACHINE_CODE[raw]) return BY_MACHINE_CODE[raw];
    if (code && BY_CODE[code]) return BY_CODE[code];

    // Ошибки валидации приходят JSON-массивом от Zod — наружу его не пускаем.
    if (looksTechnical(raw)) return 'Проверьте заполнение полей — сервер не принял данные';
    return raw || FALLBACK;
  }

  if (err instanceof Error) {
    const raw = firstLine(err.message);
    if (raw && BY_MACHINE_CODE[raw]) return BY_MACHINE_CODE[raw];
    return looksTechnical(raw) ? FALLBACK : raw || FALLBACK;
  }

  return FALLBACK;
}

/** Первая строка сообщения, обрезанная до читаемой длины (без стека). */
function firstLine(msg: string): string {
  const line = (msg ?? '').split('\n')[0]!.trim();
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}

/**
 * Технический ли текст: JSON от Zod, SQL или служебный код без пробелов.
 * Такие строки сотруднику ничего не объясняют — показываем общую фразу.
 */
function looksTechnical(line: string): boolean {
  if (!line) return true;
  if (line.startsWith('[') || line.startsWith('{')) return true;
  if (/^[A-Z][A-Z0-9_]{3,}$/.test(line)) return true; // ВЕРСАЛЬНЫЙ_КОД
  if (/\b(select|insert|update|delete)\b .*\b(from|into|set|where)\b/i.test(line)) return true;
  if (/(relation|column|constraint|duplicate key|violates)\b/i.test(line)) return true;
  return false;
}
