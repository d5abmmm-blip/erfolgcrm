/**
 * Юнит-тесты инструментов AI-ассистента (tools.ts) — без БД.
 * Подменяем tRPC-caller моком и проверяем, что write-инструменты вызывают нужные
 * процедуры с правильно смаппленными аргументами, а previews формируются.
 */
import { describe, it, expect } from 'vitest';
import { getTool, isWriteTool } from '../modules/ai-assistant/tools';

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
