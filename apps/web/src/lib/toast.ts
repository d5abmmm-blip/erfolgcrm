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

export function showToast(kind: ToastKind, text: string): ToastMessage {
  const msg: ToastMessage = { id: ++seq, kind, text };
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
