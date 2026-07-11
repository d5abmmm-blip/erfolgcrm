/**
 * Юнит-тесты инструментов AI-ассистента (tools.ts) — без БД.
 * Подменяем tRPC-caller моком и проверяем, что write-инструменты вызывают нужные
 * процедуры с правильно смаппленными аргументами, а previews формируются.
 */
import { describe, it, expect, vi } from 'vitest';

// Мокаем read-запросы (бьют в БД) — проверяем только маппинг аргументов в диспатче.
vi.mock('../modules/ai-assistant/read-queries', () => ({
  getFinanceSummary: vi.fn(() => Promise.resolve({ ok: 'finance' })),
  listAgedTickets: vi.fn(() => Promise.resolve({ ok: 'aged' })),
  getTicketsStats: vi.fn(() => Promise.resolve({ ok: 'stats' })),
}));

import { getTool, isWriteTool, toolDefsForRole } from '../modules/ai-assistant/tools';
import * as readQueries from '../modules/ai-assistant/read-queries';

const STAFF_ONLY_TOOLS = ['get_finance_summary', 'list_aged_tickets', 'get_tickets_stats'] as const;

interface RecordedCall {
  proc: string;
  arg: unknown;
}

function mockCaller() {
  const calls: RecordedCall[] = [];
  const rec = (proc: string) => (arg: unknown) => {
    calls.push({ proc, arg });
    return Promise.resolve({ id: `id-${proc}` });
  };
  const caller = {
    clients: { create: rec('clients.create') },
    assets: { create: rec('assets.create') },
    contracts: { create: rec('contracts.create') },
    users: { create: rec('users.create') },
  };
  // tools.run типизирован под реальный Caller; в юнит-тесте это мок.
  return { caller: caller as unknown as Parameters<NonNullable<ReturnType<typeof getTool>>['run']>[0], calls };
}

describe('реестр инструментов', () => {
  it('новые инструменты создания — write', () => {
    for (const name of ['create_client', 'create_asset', 'create_contract', 'create_engineer']) {
      expect(isWriteTool(name)).toBe(true);
      expect(getTool(name)?.kind).toBe('write');
    }
  });

  it('поисковые инструменты остаются read', () => {
    expect(getTool('search_clients')?.kind).toBe('read');
  });

  it('инструменты «спроси у системы» — read (выполняются без подтверждения)', () => {
    for (const name of ['get_finance_summary', 'list_aged_tickets', 'get_tickets_stats']) {
      expect(getTool(name)?.kind).toBe('read');
      expect(isWriteTool(name)).toBe(false);
    }
  });
});

describe('read-инструменты «спроси у системы»', () => {
  // Фейковый ctx (db+tenant+role) — в моках реальные значения не используются.
  // role='director' (staff) — чтобы staff-only инструменты проходили RBAC-гейт.
  const ctx = { db: {} as never, tenant: { id: 't1' } as never, role: 'director' as const };
  const caller = {} as Parameters<NonNullable<ReturnType<typeof getTool>>['run']>[0];

  it('get_finance_summary: пресет по умолчанию month', async () => {
    const res = await getTool('get_finance_summary')!.run(caller, {}, ctx);
    expect(res).toEqual({ ok: 'finance' });
    expect(readQueries.getFinanceSummary).toHaveBeenCalledWith(ctx.db, ctx.tenant, 'month');
  });

  it('get_finance_summary: пробрасывает корректный period', async () => {
    await getTool('get_finance_summary')!.run(caller, { period: 'prev_month' }, ctx);
    expect(readQueries.getFinanceSummary).toHaveBeenCalledWith(ctx.db, ctx.tenant, 'prev_month');
  });

  it('get_finance_summary: невалидный period → month', async () => {
    await getTool('get_finance_summary')!.run(caller, { period: 'вчера' }, ctx);
    expect(readQueries.getFinanceSummary).toHaveBeenCalledWith(ctx.db, ctx.tenant, 'month');
  });

  it('list_aged_tickets: по умолчанию порог 7 дней', async () => {
    await getTool('list_aged_tickets')!.run(caller, {}, ctx);
    expect(readQueries.listAgedTickets).toHaveBeenCalledWith(ctx.db, ctx.tenant, 7);
  });

  it('list_aged_tickets: принимает число дней (в т.ч. строкой)', async () => {
    await getTool('list_aged_tickets')!.run(caller, { days: '14' }, ctx);
    expect(readQueries.listAgedTickets).toHaveBeenCalledWith(ctx.db, ctx.tenant, 14);
  });

  it('get_tickets_stats: пробрасывает period', async () => {
    await getTool('get_tickets_stats')!.run(caller, { period: 'week' }, ctx);
    expect(readQueries.getTicketsStats).toHaveBeenCalledWith(ctx.db, ctx.tenant, 'week');
  });

  it('read-инструмент без ctx бросает понятную ошибку', () => {
    expect(() => getTool('get_finance_summary')!.run(caller, {})).toThrow(/контекст/i);
  });
});

describe('RBAC: staff-only read-инструменты (финансы / заявки с ПДн)', () => {
  const caller = {} as Parameters<NonNullable<ReturnType<typeof getTool>>['run']>[0];
  const mkCtx = (role: 'director' | 'dispatcher' | 'engineer') => ({
    db: {} as never,
    tenant: { id: 't1' } as never,
    role,
  });

  // run() с гейтом бросает синхронно (как reqString в write-инструментах) — это
  // ловит try/catch вокруг await в service.ts. Оборачиваем в Promise.resolve().then,
  // чтобы и синхронный, и асинхронный бросок попали в .rejects.
  const callTool = (name: string, role: 'director' | 'dispatcher' | 'engineer') =>
    Promise.resolve().then(() => getTool(name)!.run(caller, {}, mkCtx(role)));

  it('инженер: все три staff-only инструмента отклоняются по правам (FORBIDDEN)', async () => {
    for (const name of STAFF_ONLY_TOOLS) {
      await expect(callTool(name, 'engineer')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('директор: staff-only инструменты проходят гейт (вызывают read-запрос)', async () => {
    for (const name of STAFF_ONLY_TOOLS) {
      await expect(callTool(name, 'director')).resolves.toBeDefined();
    }
  });

  it('диспетчер: staff-only инструменты проходят гейт', async () => {
    for (const name of STAFF_ONLY_TOOLS) {
      await expect(callTool(name, 'dispatcher')).resolves.toBeDefined();
    }
  });

  it('инженеру staff-only инструменты не отдаются в список для модели', () => {
    const names = toolDefsForRole('engineer').map((d) => d.function.name);
    for (const name of STAFF_ONLY_TOOLS) {
      expect(names).not.toContain(name);
    }
    // обычные read/write остаются доступны инженеру
    expect(names).toContain('search_tickets');
    expect(names).toContain('create_ticket');
  });

  it('search_clients теперь staff-only (PII-2): инженеру не отдаётся и блокируется по правам', async () => {
    // Инженер вызвать не может — requireStaff бросает FORBIDDEN до обращения к caller.
    await expect(callTool('search_clients', 'engineer')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // И модели инженера этот инструмент даже не предлагается.
    expect(toolDefsForRole('engineer').map((d) => d.function.name)).not.toContain('search_clients');
    // Staff по-прежнему видит его в списке.
    expect(toolDefsForRole('director').map((d) => d.function.name)).toContain('search_clients');
  });

  it('staff (директор/диспетчер) получают полный список, включая staff-only', () => {
    for (const role of ['director', 'dispatcher'] as const) {
      const names = toolDefsForRole(role).map((d) => d.function.name);
      for (const name of STAFF_ONLY_TOOLS) {
        expect(names).toContain(name);
      }
    }
  });

  it('режим read_only: write-инструменты не отдаются, read — остаются', () => {
    const readOnly = toolDefsForRole('director', 'read_only').map((d) => d.function.name);
    // Ни одного write-инструмента.
    for (const name of readOnly) {
      expect(isWriteTool(name)).toBe(false);
    }
    for (const w of ['create_ticket', 'change_ticket_status', 'assign_engineer']) {
      expect(readOnly).not.toContain(w);
    }
    // Read-инструменты по-прежнему доступны.
    expect(readOnly).toContain('search_tickets');
    expect(readOnly).toContain('search_kb');
    // В полном режиме write-инструменты есть.
    const full = toolDefsForRole('director', 'full').map((d) => d.function.name);
    expect(full).toContain('create_ticket');
  });
});

describe('create_client', () => {
  it('организация → clients.create type=legal с реквизитами', async () => {
    const { caller, calls } = mockCaller();
    await getTool('create_client')!.run(caller, {
      clientType: 'legal',
      displayName: 'ООО Ромашка',
      inn: '7700000000',
      legalAddress: 'г. Москва',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.proc).toBe('clients.create');
    expect(calls[0]!.arg).toMatchObject({
      type: 'legal',
      displayName: 'ООО Ромашка',
      inn: '7700000000',
      legalAddress: 'г. Москва',
    });
  });

  it('физлицо → clients.create type=individual', async () => {
    const { caller, calls } = mockCaller();
    await getTool('create_client')!.run(caller, {
      clientType: 'individual',
      individualFullName: 'Иванов Иван Иванович',
      individualPhone: '+79990001122',
    });
    expect(calls[0]!.arg).toMatchObject({
      type: 'individual',
      individualFullName: 'Иванов Иван Иванович',
    });
  });

  it('бросает понятную ошибку, если у организации нет названия', () => {
    const { caller } = mockCaller();
    // reqString бросает синхронно (в service.ts это ловится try/catch вокруг await run).
    expect(() => getTool('create_client')!.run(caller, { clientType: 'legal' })).toThrow(/displayName/);
  });
});

describe('create_asset / create_contract', () => {
  it('asset требует ownerClientId и model', async () => {
    const { caller, calls } = mockCaller();
    await getTool('create_asset')!.run(caller, {
      ownerClientId: 'client-uuid',
      model: 'Тонометр UA-777',
      serialNumber: 'SN123',
    });
    expect(calls[0]!.proc).toBe('assets.create');
    expect(calls[0]!.arg).toMatchObject({ ownerClientId: 'client-uuid', model: 'Тонометр UA-777' });
  });

  it('contract маппит номер и дату', async () => {
    const { caller, calls } = mockCaller();
    await getTool('create_contract')!.run(caller, {
      clientId: 'client-uuid',
      contractNumber: 'РО-42',
      contractDate: '2026-06-01',
    });
    expect(calls[0]!.arg).toMatchObject({
      clientId: 'client-uuid',
      contractNumber: 'РО-42',
      contractDate: '2026-06-01',
    });
  });
});

describe('create_engineer', () => {
  it('генерирует валидный логин и временный пароль, роль по умолчанию engineer', async () => {
    const { caller, calls } = mockCaller();
    const res = (await getTool('create_engineer')!.run(caller, {
      fullName: 'Петров Пётр',
    })) as { loginInstructions: { username: string; tempPassword: string } };

    expect(calls[0]!.proc).toBe('users.create');
    expect(calls[0]!.arg).toMatchObject({ fullName: 'Петров Пётр', role: 'engineer' });

    const { username, tempPassword } = res.loginInstructions;
    expect(username).toMatch(/^[a-z0-9._-]{3,64}$/);
    expect(tempPassword.length).toBeGreaterThanOrEqual(8);
    // пароль, который ушёл в users.create, совпадает с выданным
    expect(calls[0]!.arg).toMatchObject({ username, password: tempPassword });
  });

  it('пробрасывает выбранную роль', async () => {
    const { caller, calls } = mockCaller();
    await getTool('create_engineer')!.run(caller, { fullName: 'Сидоров С.', role: 'dispatcher' });
    expect(calls[0]!.arg).toMatchObject({ role: 'dispatcher' });
  });
});

describe('previews', () => {
  it('write-инструменты дают непустой текст подтверждения', () => {
    expect(getTool('create_client')!.preview!({ clientType: 'legal', displayName: 'ООО Ромашка' })).toContain(
      'ООО Ромашка',
    );
    expect(getTool('create_engineer')!.preview!({ fullName: 'Петров Пётр' })).toContain('Петров Пётр');
  });
});
