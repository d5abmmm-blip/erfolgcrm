/**
 * Простейшая шина всплывающих сообщений.
 *
 * Нужна потому, что сообщение об ошибке должен уметь показать не только
 * React-компонент, но и глобальный перехватчик мутаций (он живёт в main.tsx,
 * вне дерева компонентов). Подписчик — единственный <AppToaster/>.
 */
export type ToastKind = 'ok' | 'queued' | 'error';

export interface ToastMessage {
  id: number;
  kind: ToastKind;
  text: string;
}

type Listener = (t: ToastMessage) => void;

const listeners = new Set<Listener>();
let seq = 0;

/**
 * Склейка одинаковых сообщений.
 *
 * Отправку очереди запускают трое независимо — оболочка приложения, экран
 * профиля и фоновый автосинк, — и каждый показывает свой итог. Человек получал
 * три одинаковых красных сообщения подряд, что читается как поломка.
 * Проверено вживую: «Вход в систему закончился» показывалось трижды.
 */
const REPEAT_WINDOW_MS = 3_000;
let lastText: string | null = null;
let lastKind: ToastKind | null = null;
let lastAt = 0;

export function showToast(kind: ToastKind, text: string): ToastMessage {
  const now = Date.now();
  const isRepeat = text === lastText && kind === lastKind && now - lastAt < REPEAT_WINDOW_MS;
  lastText = text;
  lastKind = kind;
  lastAt = now;
  const msg: ToastMessage = { id: ++seq, kind, text };
  if (isRepeat) return msg;
  for (const l of listeners) {
    try {
      l(msg);
    } catch {
      /* упавший подписчик не должен ронять того, кто показывает сообщение */
    }
  }
  return msg;
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
