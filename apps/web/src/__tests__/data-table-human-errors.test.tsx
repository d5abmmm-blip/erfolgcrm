/**
 * Списки говорят об ошибке загрузки человеческим языком.
 *
 * ЗАЧЕМ. DataTable показывал сырой error.message: SQL из INTERNAL_SERVER_ERROR,
 * JSON-массив от Zod. Человек в списке счетов видел «insert or update on
 * table…» и не понимал, ни что случилось, ни что делать. Готовый переводчик
 * humanizeLoadError в проекте уже был (им говорят карточки и офлайн-плашки) —
 * списки его просто не звали: страницы передавали в таблицу голый message.
 *
 * ПОСЛЕ ПРАВКИ. DataTable принимает саму ошибку (unknown) и переводит её
 * внутри — единой точкой для всех ~20 списков; заодно офлайн-случай получает
 * честное «Нет связи с сервером…» вместо технического TypeError.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TRPCClientError } from '@trpc/client';
import { DataTable } from '../components/ui/DataTable';
import type { AppRouter } from '@erfolg/api';

function loadError(message: string, code: string, httpStatus = 500) {
  return new TRPCClientError<AppRouter>(message, {
    result: {
      error: { code: -32600, message, data: { code, httpStatus, path: 'invoices.list' } },
    },
  } as never);
}

const SQL_RAW = 'insert or update on table "invoices" violates foreign key constraint';

describe('DataTable: ошибка загрузки — человеческим языком', () => {
  it('SQL из INTERNAL_SERVER_ERROR наружу не выходит', () => {
    render(
      <DataTable
        data={[]}
        columns={[]}
        rowKey={() => ''}
        error={loadError(SQL_RAW, 'INTERNAL_SERVER_ERROR')}
      />,
    );
    expect(screen.queryByText(/insert or update on table/)).toBeNull();
    expect(screen.getByText(/Ошибка на сервере — данные не загружены/)).toBeTruthy();
  });

  it('FORBIDDEN — про права, без текста для программиста', () => {
    render(
      <DataTable
        data={[]}
        columns={[]}
        rowKey={() => ''}
        error={loadError('FORBIDDEN', 'FORBIDDEN', 403)}
      />,
    );
    expect(screen.getByText(/Недостаточно прав, чтобы посмотреть эти данные/)).toBeTruthy();
  });
});
