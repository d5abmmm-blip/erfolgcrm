/**
 * Плашка «данные не загрузились» и её тексты.
 *
 * Зачем эти тесты. Из 74 экранов с запросами 26 при сбое загрузки молчали —
 * показывали пустую таблицу. Опаснее всего журнал аудита: пустая таблица там
 * читается как «нарушений не было». Здесь стережём три вещи:
 *   1. наружу не просачивается техническое (SQL из INTERNAL_SERVER_ERROR,
 *      JSON-массив от Zod) — сервер кладёт исходный текст ошибки прямо в ответ;
 *   2. текст говорит про ЗАГРУЗКУ, а не про сохранение («Изменение не сохранено»
 *      после неудачного чтения — вранье, ничего и не сохранялось);
 *   3. в таблице плашка выходит строкой <tr>, а не <div>: <div> внутри <tbody>
 *      браузер выкидывает из таблицы, и сообщение уезжает в неожиданное место.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TRPCClientError } from '@trpc/client';
import { humanizeLoadError } from '../lib/error-message';
import { QueryError, QueryErrorRow } from '../components/QueryError';
import type { AppRouter } from '@erfolg/api';

function trpcError(message: string, code: string, httpStatus = 500) {
  return new TRPCClientError<AppRouter>(message, {
    result: {
      error: { code: -32600, message, data: { code, httpStatus, path: 'audit.list' } },
    },
  } as never);
}

beforeEach(() => {
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: true });
});

// Авто-очистка @testing-library в проекте не подключена (jest-dom тоже нет),
// поэтому без этого отрисованное предыдущим тестом остаётся в DOM и getByText
// находит два совпадения.
afterEach(cleanup);

describe('humanizeLoadError', () => {
  it('SQL из INTERNAL_SERVER_ERROR наружу не выходит', () => {
    const err = trpcError(
      'select "id" from "audit_log" where "tenant_id" = $1 — relation does not exist',
      'INTERNAL_SERVER_ERROR',
    );
    const text = humanizeLoadError(err);
    expect(text).not.toContain('select');
    expect(text).not.toContain('audit_log');
    expect(text).toBe('Ошибка на сервере — данные не загружены');
  });

  it('JSON от Zod наружу не выходит', () => {
    const err = trpcError('[{"code":"invalid_type","path":["limit"]}]', 'BAD_REQUEST');
    const text = humanizeLoadError(err);
    expect(text).not.toContain('invalid_type');
    expect(text).toBe('Не удалось загрузить данные');
  });

  it('истёкшая сессия объясняется по-человечески и БЕЗ «изменение не сохранено»', () => {
    const text = humanizeLoadError(trpcError('UNAUTHORIZED', 'UNAUTHORIZED', 401));
    expect(text).toContain('Сессия истекла');
    // Ключевое отличие от humanizeError: при чтении ничего не сохранялось.
    expect(text).not.toContain('не сохранен');
  });

  it('нет связи — говорит про связь, а не про сохранение', () => {
    Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: false });
    const text = humanizeLoadError(new TypeError('Failed to fetch'));
    expect(text).toBe('Нет связи с сервером — данные не загружены');
  });

  it('доменную ошибку с понятным текстом показываем как есть', () => {
    const text = humanizeLoadError(trpcError('Недостаточно остатков на складе', 'BAD_REQUEST'));
    expect(text).toBe('Недостаточно остатков на складе');
  });

  it('незнакомое значение не роняет и даёт запасную фразу', () => {
    expect(humanizeLoadError(undefined)).toBe('Не удалось загрузить данные');
    expect(humanizeLoadError({ странное: true })).toBe('Не удалось загрузить данные');
  });
});

describe('<QueryError>', () => {
  it('без ошибки не рисует ничего', () => {
    const { container } = render(<QueryError error={null} what="журнал действий" />);
    expect(container.innerHTML).toBe('');
  });

  it('называет, что именно не загрузилось, и объясняет причину', () => {
    render(
      <QueryError error={trpcError('boom', 'INTERNAL_SERVER_ERROR')} what="журнал действий" />,
    );
    expect(screen.queryByText('Не удалось загрузить журнал действий')).not.toBeNull();
    expect(screen.queryByText('Ошибка на сервере — данные не загружены')).not.toBeNull();
  });

  it('замороженный офлайном запрос показывается БЕЗ ошибки', () => {
    // Половина случаев проходила бы мимо: при потере связи react-query не роняет
    // запрос, а ставит его на паузу — error остаётся пустым НАВСЕГДА, и экран ведёт
    // себя как при пустых данных. Обнаружено проверкой в браузере, не тестом.
    render(<QueryError error={null} paused what="журнал действий" />);
    expect(screen.queryByText('Не удалось загрузить журнал действий')).not.toBeNull();
    expect(screen.queryByText('Нет связи с сервером — загрузка приостановлена')).not.toBeNull();
  });

  it('ошибка важнее паузы: показываем причину, а не общую фразу про связь', () => {
    render(<QueryError error={trpcError('x', 'FORBIDDEN', 403)} paused what="журнал действий" />);
    expect(screen.queryByText('Недостаточно прав, чтобы посмотреть эти данные')).not.toBeNull();
  });

  it('кнопка «Повторить» появляется только когда есть что вызывать', () => {
    const { rerender } = render(<QueryError error={trpcError('x', 'TIMEOUT')} />);
    expect(screen.queryByRole('button', { name: 'Повторить' })).toBeNull();

    rerender(<QueryError error={trpcError('x', 'TIMEOUT')} onRetry={() => undefined} />);
    expect(screen.queryByRole('button', { name: 'Повторить' })).not.toBeNull();
  });
});

describe('<QueryErrorRow>', () => {
  it('рисует именно строку таблицы на всю ширину', () => {
    const { container } = render(
      <table>
        <tbody>
          <QueryErrorRow error={trpcError('x', 'TIMEOUT')} what="список клиентов" colSpan={7} />
        </tbody>
      </table>,
    );

    const cell = container.querySelector('tbody > tr > td');
    expect(cell).not.toBeNull();
    // Без colSpan плашка сжалась бы в первую колонку и текст стал бы нечитаемым.
    expect(cell?.getAttribute('colspan')).toBe('7');
    expect(screen.queryByText('Не удалось загрузить список клиентов')).not.toBeNull();
  });

  it('без ошибки не добавляет пустую строку в таблицу', () => {
    const { container } = render(
      <table>
        <tbody>
          <QueryErrorRow error={undefined} colSpan={3} />
        </tbody>
      </table>,
    );
    expect(container.querySelector('tbody > tr')).toBeNull();
  });
});
