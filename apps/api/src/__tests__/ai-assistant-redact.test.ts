/**
 * PII-1 (аудит 2026-07-06): результаты read-инструментов AI-ассистента чистятся от ПДн
 * клиента ПЕРЕД отправкой во внешний LLM (z.ai/КНР). Проверяем:
 *   1. поля с именем/контактами клиента заменяются на заглушку;
 *   2. имена инженеров и не-ПДн (модель/номер/суммы/статусы) сохраняются;
 *   3. рекурсия по массивам/вложенным объектам; Date/примитивы/null не ломаются;
 *   4. исходный объект не мутируется.
 */
import { describe, it, expect } from 'vitest';
import { redactClientPii, PII_PLACEHOLDER } from '../modules/ai-assistant/redact';

describe('redactClientPii', () => {
  it('вырезает имя/телефон/адрес/email клиента', () => {
    const ticket = {
      ticketNumber: 'WSP-42',
      status: 'in_progress',
      clientDisplayName: 'Петров П.П.',
      assignedEngineerName: 'Сидоров Сергей Иванович',
      assetModel: 'Philips HD11',
    };
    const out = redactClientPii(ticket) as typeof ticket;
    expect(out.clientDisplayName).toBe(PII_PLACEHOLDER);
    // не-ПДн и имя инженера сохраняются
    expect(out.ticketNumber).toBe('WSP-42');
    expect(out.status).toBe('in_progress');
    expect(out.assetModel).toBe('Philips HD11');
    expect(out.assignedEngineerName).toBe('Сидоров Сергей Иванович');
  });

  it('чистит список клиентов из search_clients: имя/телефон/почта — скрыты', () => {
    const clients = [
      { id: 'c1', displayName: 'Иванов И.И.', phone: '+79001112233', email: 'iv@mail.ru' },
      { id: 'c2', displayName: 'ООО Ромашка', phone: null },
    ];
    const out = redactClientPii(clients) as typeof clients;
    expect(out[0]!.displayName).toBe(PII_PLACEHOLDER);
    expect(out[0]!.phone).toBe(PII_PLACEHOLDER);
    expect(out[0]!.email).toBe(PII_PLACEHOLDER);
    expect(out[0]!.id).toBe('c1');
    // null не заменяется на заглушку
    expect(out[1]!.phone).toBeNull();
  });

  it('search_assets: имя клиента-владельца (ownerDisplayName) скрывается', () => {
    const assets = [
      { id: 'a1', model: 'Philips HD11', serialNumber: 'SN-777', ownerDisplayName: 'Петров П.П.' },
    ];
    const out = redactClientPii(assets) as typeof assets;
    expect(out[0]!.ownerDisplayName).toBe(PII_PLACEHOLDER);
    expect(out[0]!.model).toBe('Philips HD11');
    expect(out[0]!.serialNumber).toBe('SN-777');
  });

  it('ИНН физлица (type=individual) скрывается, ИНН юрлица (type=legal) остаётся', () => {
    const individual = {
      id: 'c1',
      type: 'individual',
      displayName: 'Сидоров С.С.',
      inn: '500100732259',
    };
    const legal = { id: 'c2', type: 'legal', displayName: 'ООО Ромашка', inn: '7701234567' };
    const outInd = redactClientPii(individual) as typeof individual;
    const outLegal = redactClientPii(legal) as typeof legal;
    // физлицо: и ФИО, и персональный ИНН скрыты
    expect(outInd.displayName).toBe(PII_PLACEHOLDER);
    expect(outInd.inn).toBe(PII_PLACEHOLDER);
    // юрлицо: ИНН публичный — остаётся (наименование скрыто консервативно)
    expect(outLegal.inn).toBe('7701234567');
  });

  it('рекурсивно обходит вложенные объекты', () => {
    const nested = { ticket: { clientDisplayName: 'Сидоров С.С.', asset: { model: 'GE Vivid' } } };
    const out = redactClientPii(nested) as typeof nested;
    expect(out.ticket.clientDisplayName).toBe(PII_PLACEHOLDER);
    expect(out.ticket.asset.model).toBe('GE Vivid');
  });

  it('не ломает Date, числа, boolean и null', () => {
    const now = new Date('2026-07-06T10:00:00Z');
    const input = { receivedAt: now, count: 5, active: true, note: null, phone: '+79990001122' };
    const out = redactClientPii(input) as typeof input;
    expect(out.receivedAt).toBeInstanceOf(Date);
    expect(out.receivedAt.getTime()).toBe(now.getTime());
    expect(out.count).toBe(5);
    expect(out.active).toBe(true);
    expect(out.note).toBeNull();
    expect(out.phone).toBe(PII_PLACEHOLDER);
  });

  it('не мутирует исходный объект', () => {
    const src = { clientDisplayName: 'Петров П.П.' };
    redactClientPii(src);
    expect(src.clientDisplayName).toBe('Петров П.П.');
  });

  it('пустую строку в ПДн-поле не трогает (нечего скрывать)', () => {
    const out = redactClientPii({ phone: '' }) as { phone: string };
    expect(out.phone).toBe('');
  });
});
