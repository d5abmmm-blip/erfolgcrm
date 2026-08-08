/**
 * Черновик набранного текста в памяти телефона.
 *
 * ЗАЧЕМ. Наряд записывается при уходе курсора из поля и при уходе с экрана
 * (см. use-flush-on-leave). Оба пути асинхронные — они успевают, пока страница
 * жива. Но если систему выбило приложение из памяти, страница умирает вместе с
 * незавершённой записью: измерено живой проверкой — после настоящей выгрузки
 * очередь оставалась ПУСТОЙ, набранное пропадало.
 *
 * Поэтому здесь ДРУГОЙ инструмент: `localStorage` пишется синхронно, прямо в
 * обработчике нажатия клавиши. Он не заменяет отправку — он страхует её.
 *
 * Правила, на которых это держится:
 *  1. Черновик — только про НЕОТПРАВЛЕННОЕ. Как только сервер (или очередь)
 *     принял текст, черновик стирается: иначе он будет воскрешать старое
 *     поверх нового.
 *  2. Черновик привязан к заявке и полю, а не к экрану.
 *  3. Срок годности — неделя. Забытый черновик не должен всплыть через месяц
 *     поверх работы другого человека.
 *  4. Хранилище может отказать (приватный режим, переполнение) — тогда всё
 *     работает как раньше, без страховки, но НЕ падает.
 */

const PREFIX = 'erfolg-draft:';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface StoredDraft {
  text: string;
  at: number;
}

function keyOf(scope: string, field: string): string {
  return `${PREFIX}${scope}:${field}`;
}

/** Хранилище может быть недоступно — тогда просто живём без черновиков. */
function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Запомнить набранное. Зовётся на каждое нажатие клавиши, поэтому делает
 * ровно одну дешёвую операцию и никогда не бросает.
 */
export function rememberDraft(scope: string, field: string, text: string): void {
  const store = storage();
  if (!store) return;
  try {
    if (text === '') {
      store.removeItem(keyOf(scope, field));
      return;
    }
    const value: StoredDraft = { text, at: Date.now() };
    store.setItem(keyOf(scope, field), JSON.stringify(value));
  } catch {
    /* переполнилось или запрещено — работаем без страховки */
  }
}

/** Текст пережил закрытие приложения? Протухший — выбрасываем молча. */
export function readDraft(scope: string, field: string): string | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(keyOf(scope, field));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredDraft>;
    if (typeof parsed.text !== 'string' || typeof parsed.at !== 'number') return null;
    if (Date.now() - parsed.at > MAX_AGE_MS) {
      store.removeItem(keyOf(scope, field));
      return null;
    }
    return parsed.text;
  } catch {
    return null;
  }
}

/** Текст принят (сервером или очередью) — страховка больше не нужна. */
export function forgetDraft(scope: string, field: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(keyOf(scope, field));
  } catch {
    /* см. rememberDraft */
  }
}

/**
 * Снять страховку ТОЛЬКО с того текста, который реально записали.
 *
 * ⚠️ ЗАЧЕМ ОТДЕЛЬНАЯ ФУНКЦИЯ. Запись асинхронная: без связи она идёт через
 * IndexedDB, и это не мгновенно. Человек в это время продолжает печатать —
 * а по ответу мы стирали черновик целиком, вместе с дописанным. Дописанное
 * оставалось без страховки вовсе: выбило приложение — и оно пропало, хотя
 * ради этого случая черновик и заведён.
 *
 * Поэтому сверяем: в хранилище лежит ровно то, что уехало? Тогда убираем.
 * Лежит другое — значит человек уже продолжил, и это ЕГО текст, не наш.
 */
export function forgetDraftIfUnchanged(scope: string, field: string, sent: string): void {
  if (readDraft(scope, field) !== sent) return;
  forgetDraft(scope, field);
}

/**
 * Уборка протухших черновиков. Зовётся при старте приложения: без неё
 * хранилище копило бы записи по всем заявкам, которые инженер когда-либо
 * открывал.
 */
export function sweepDrafts(now: number = Date.now()): number {
  const store = storage();
  if (!store) return 0;
  let removed = 0;
  try {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k && k.startsWith(PREFIX)) keys.push(k);
    }
    for (const k of keys) {
      const raw = store.getItem(k);
      let stale = true;
      try {
        const parsed = JSON.parse(raw ?? '') as Partial<StoredDraft>;
        stale = typeof parsed.at !== 'number' || now - parsed.at > MAX_AGE_MS;
      } catch {
        stale = true;
      }
      if (stale) {
        store.removeItem(k);
        removed++;
      }
    }
  } catch {
    /* см. rememberDraft */
  }
  return removed;
}
