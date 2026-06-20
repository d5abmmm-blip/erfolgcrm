import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/**
 * Глобальный перехватчик ошибок рендера. Без него любой неожиданный сбой
 * (например null там, где ждали объект) гасит весь экран в белое — для
 * непрограммиста это «программа сломалась». Здесь показываем понятный экран
 * с кнопкой «Перезагрузить».
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // Лог в консоль (в проде подхватится Sentry, когда подключат SENTRY_DSN).
    console.error('Сбой интерфейса:', error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="bg-background text-foreground flex min-h-screen items-center justify-center p-6">
        <div className="bg-card w-full max-w-md rounded-xl border p-6 text-center shadow-sm">
          <div className="text-2xl">⚠️</div>
          <h1 className="mt-2 text-lg font-semibold">Что-то пошло не так</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            Произошёл сбой на этой странице. Данные не потеряны — попробуйте перезагрузить.
            Если повторяется — сообщите директору.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="bg-primary text-primary-foreground hover:bg-primary/90 mt-4 inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition"
          >
            Перезагрузить
          </button>
        </div>
      </div>
    );
  }
}
