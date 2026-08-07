/**
 * Нижняя навигация мобильной оболочки инженера.
 *
 * «Выйти» из таб-бара убран: случайный тап по крайней вкладке разлогинивал
 * инженера в поле (а кнопка выхода и так есть в «Профиле»). Стережём состав
 * вкладок и отсутствие «Выйти»; заодно — что отключённый модуль прячет вкладку.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import { MobileShell } from '../components/MobileShell';

/**
 * Провайдер запросов нужен с тех пор, как оболочка после отправки очереди
 * перечитывает экраны: без него инженер видел «Отправлено 1», а свою правку
 * в истории не находил.
 */
function withQueryClient(ui: ReactNode) {
  return <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;
}

afterEach(cleanup);

function session(disabledModules: string[] = []) {
  return {
    user: {
      id: 'u1',
      username: 'engineer',
      fullName: 'Ислаев Умар',
      role: 'engineer' as const,
    },
    tenant: { id: 't1', subdomain: 'erfolg', displayName: 'ООО «Эрфольг»', disabledModules },
  };
}

describe('MobileShell: нижняя навигация', () => {
  it('вкладки на месте, «Выйти» среди них нет', () => {
    render(
      withQueryClient(
        <MobileShell session={session()}>
          <div>содержимое</div>
        </MobileShell>,
      ),
    );
    for (const label of ['Очередь', 'Задачи', 'Сканер', 'Склад', 'Профиль']) {
      expect(screen.queryByText(label)).not.toBeNull();
    }
    expect(screen.queryByText('Выйти')).toBeNull();
  });

  it('отключённый модуль прячет вкладку «Склад»', () => {
    render(
      withQueryClient(
        <MobileShell session={session(['inventory'])}>
          <div>содержимое</div>
        </MobileShell>,
      ),
    );
    expect(screen.queryByText('Склад')).toBeNull();
    expect(screen.queryByText('Очередь')).not.toBeNull();
  });
});
