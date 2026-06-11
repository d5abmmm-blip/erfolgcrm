import { useRegisterSW } from 'virtual:pwa-register/react';
import { RefreshCw, X } from 'lucide-react';

/**
 * Подписка на обновления service worker. При появлении новой версии — toast
 * с кнопкой «Обновить» в нижнем углу. Если SW работает оффлайн готовности —
 * единоразовый toast «Работает оффлайн».
 *
 * Намеренно НЕ авто-перезагружаем страницу: инженер может быть в середине ввода
 * работ, потеря текущего ввода была бы неприятной.
 */
export function PWARegister() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError(error) {
       
      console.error('SW registration failed', error);
    },
  });

  if (!needRefresh && !offlineReady) return null;

  const close = () => {
    setNeedRefresh(false);
    setOfflineReady(false);
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex justify-center px-3 md:bottom-4">
      <div className="bg-card text-card-foreground pointer-events-auto flex max-w-md flex-1 items-center justify-between gap-3 rounded-lg border p-3 shadow-lg">
        <div className="text-sm">
          {needRefresh
            ? 'Доступна новая версия приложения'
            : 'Приложение готово работать оффлайн'}
        </div>
        <div className="flex items-center gap-1.5">
          {needRefresh && (
            <button
              type="button"
              onClick={() => void updateServiceWorker(true)}
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Обновить
            </button>
          )}
          <button
            type="button"
            onClick={close}
            className="text-muted-foreground hover:text-foreground hover:bg-muted grid h-8 w-8 place-items-center rounded transition"
            aria-label="Закрыть"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
