import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { AppToaster } from './components/AppToaster';
import { ErrorBoundary } from './components/ErrorBoundary';
import { OutboxAutoSync } from './components/OutboxAutoSync';
import { humanizeError } from './lib/error-message';
import { ThemeProvider } from './lib/theme';
import { showToast } from './lib/toast';
import { trpc, trpcClient } from './lib/trpc';
// Фирменный шрифт интерфейса: Golos Text (кириллица из коробки, variable —
// один файл на все начертания). Self-hosted — работает офлайн в PWA.
import '@fontsource-variable/golos-text';
import './styles/globals.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
  // Подстраховка на всё приложение: если сохранение не удалось и экран сам ничего
  // не показал — сотрудник увидит сообщение, а не решит, что данные записались.
  // Молчим там, где ошибку уже показывают рядом с полем: у такой мутации задан
  // свой onError либо стоит пометка meta.silentError.
  mutationCache: new MutationCache({
    onError: (error, _variables, _onMutateResult, mutation) => {
      if (mutation.options.onError) return;
      if ((mutation.options.meta as { silentError?: boolean })?.silentError) return;
      showToast('error', humanizeError(error));
    },
  }),
});

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

createRoot(rootEl).render(
  <StrictMode>
    <ThemeProvider defaultTheme="system" storageKey="erfolg-theme">
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <ErrorBoundary>
            <App />
          </ErrorBoundary>
          {/* Вне ErrorBoundary: сообщение должно доживать до экрана даже если
              упал сам экран. */}
          <AppToaster />
          <OutboxAutoSync />
        </QueryClientProvider>
      </trpc.Provider>
    </ThemeProvider>
  </StrictMode>,
);
