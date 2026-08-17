/**
 * Карточка сотрудника, вкладка «Деньги»: про кассу говорим ровно один раз.
 *
 * ЧТО БЫЛО. На вкладке стояли ДВА блока про кассу подряд:
 *   • «В ведомостях» — правда: месячная ведомость с колонкой «Касса»
 *     (проведена / черновик). Её проводит директор на странице «Зарплата»
 *     кнопкой «Провести в кассу», и это работает.
 *   • «Выплаты через кассу» — читал `payroll_payouts`, ОТДЕЛЬНЫЙ механизм
 *     (аванс/расчёт/премия конкретному человеку). Сервер его умеет и покрыт
 *     тестами, но не пишет в него ни один экран. Блок был пуст всегда, а его
 *     пояснение советовало «провести аванс, расчёт или премию на странице
 *     „Зарплата“» — кнопки с таким действием там нет.
 *
 * РЕШЕНИЕ ВЛАДЕЛЬЦА 2026-08-17: пустой блок убрать, второй путь записи
 * зарплаты в кассу не заводить — две независимых дороги в одну кассу это
 * ровно тот случай, когда цифры расходятся, а по январю–июлю 2026 зарплата
 * уже выплачена вне CRM и задвоилась бы.
 *
 * Серверные процедуры и таблица ОСТАВЛЕНЫ (как флаг и воркер уведомлений в
 * #164): убираем обещание в интерфейсе, а не рабочий код.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import { trpc } from '../lib/trpc';
import { MUTATION_DEFAULTS, QUERY_DEFAULTS } from '../lib/query-defaults';
import { StaffMoneyTab } from '../components/StaffMoneyTab';

const USER_ID = 'ffffffff-0000-4000-8000-0000000000e1';

const CARD = { statsSince: new Date('2026-07-05T00:00:00Z') };

const MONEY = {
  userId: USER_ID,
  fullName: 'Чулаев А. А.',
  isActive: true,
  config: {
    hasPersonal: true,
    personalBaseSalaryKopecks: '4000000',
    personalBonusPercent: 15,
    ruleMode: 'salary_bonus' as const,
    rulePieceworkPercent: 30,
    ruleBaseSalaryKopecks: '4000000',
    ruleBonusPercent: 15,
    effectiveWorkPercent: 15,
  },
  earnings: null,
  // Сервер это поле всё ещё отдаёт — экран его больше не показывает.
  payouts: [
    {
      id: 'p-1',
      kind: 'advance',
      amountKopecks: '1000000',
      paidOn: '2026-08-05',
      comment: null,
      createdAt: '2026-08-05T10:00:00.000Z',
    },
  ],
  sheetRows: [
    {
      month: '2026-07',
      salaryKopecks: '4000000',
      pieceworkKopecks: '615000',
      advanceKopecks: '1000000',
      bonusKopecks: '0',
      toPayKopecks: '3615000',
      posted: true,
    },
  ],
};

function answerFor(path: string): unknown {
  if (path === 'staff.get') return CARD;
  if (path === 'payroll.staffMoney') return MONEY;
  return null;
}

function renderTab() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { ...QUERY_DEFAULTS, retry: false }, mutations: MUTATION_DEFAULTS },
  });
  const client = trpc.createClient({
    links: [
      httpBatchLink({
        url: 'http://test.invalid/api/v1/trpc',
        transformer: superjson,
        fetch: (input) => {
          const url = typeof input === 'string' ? input : (input as Request).url;
          const paths = (url.split('/trpc/')[1] ?? '').split('?')[0]?.split(',') ?? [];
          const payload = paths.map((p) => ({
            result: { data: superjson.serialize(answerFor(p)) },
          }));
          return Promise.resolve(
            new Response(JSON.stringify(payload), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        },
      }),
    ],
  });
  return render(
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <StaffMoneyTab userId={USER_ID} />
      </QueryClientProvider>
    </trpc.Provider>,
  );
}

afterEach(cleanup);

describe('вкладка «Деньги» и касса', () => {
  it('показывает ведомости с отметкой о проведении — это и есть касса', async () => {
    renderTab();

    expect(await screen.findByText('В ведомостях')).toBeTruthy();
    expect(screen.getByText('проведена')).toBeTruthy();
  });

  it('не обещает выплат, которых негде завести', async () => {
    renderTab();
    await screen.findByText('В ведомостях');

    expect(screen.queryByText('Выплаты через кассу')).toBeNull();
    expect(screen.queryByText(/проводят аванс, расчёт или премию/)).toBeNull();
  });
});
