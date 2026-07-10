/**
 * «Замок приложения» для мобильной оболочки инженера (маршруты /m/*).
 *
 * Делает экран телефона неотличимым от нативного приложения:
 *   • нельзя увеличить/уменьшить пальцами (пинч) и двойным тапом;
 *   • нет «резинового» отскока и pull-to-refresh;
 *   • нет серой вспышки при тапе, текст не «раздувается» при повороте.
 *
 * Действует ТОЛЬКО пока смонтирована мобильная оболочка. Десктоп и публичные
 * экраны (логин, трек-ссылка клиента) не затронуты — там масштабирование
 * остаётся доступным, это важно для доступности: клиент может быть слабовидящим.
 */
import { useEffect } from 'react';

const LOCKED_VIEWPORT =
  'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';

export function useAppViewportLock(): void {
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const originalViewport = meta?.content ?? null;
    if (meta) meta.content = LOCKED_VIEWPORT;
    document.documentElement.classList.add('app-locked');

    /**
     * iOS Safari (в браузере, не в установленном PWA) намеренно игнорирует
     * user-scalable=no — поэтому пинч дополнительно глушим на уровне жестов.
     * Это Safari-специфичные события; в остальных браузерах их просто нет.
     */
    const preventGesture = (e: Event) => e.preventDefault();
    const opts: AddEventListenerOptions = { passive: false };
    document.addEventListener('gesturestart', preventGesture, opts);
    document.addEventListener('gesturechange', preventGesture, opts);
    document.addEventListener('gestureend', preventGesture, opts);

    return () => {
      if (meta && originalViewport !== null) meta.content = originalViewport;
      document.documentElement.classList.remove('app-locked');
      document.removeEventListener('gesturestart', preventGesture, opts);
      document.removeEventListener('gesturechange', preventGesture, opts);
      document.removeEventListener('gestureend', preventGesture, opts);
    };
  }, []);
}
