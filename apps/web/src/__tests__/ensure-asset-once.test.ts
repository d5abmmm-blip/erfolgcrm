/**
 * Повторная отправка формы новой заявки не должна плодить копии аппарата.
 *
 * ЗАЧЕМ. В форме «Новая заявка» единица техники заводится ДО самой заявки: сначала
 * assets.create, потом tickets.create с её id. Если заявка не прошла — ошибка
 * сервера, потерялась связь, не заполнено поле, — человек правит форму и жмёт
 * «Создать» ещё раз. И заводилась ВТОРАЯ копия того же аппарата: в парке на бою
 * 5079 единиц, лишние там никому не видны и всплывают только при поиске по
 * серийнику.
 *
 * Правило: форма помнит заведённый аппарат и на повторной отправке ПРАВИТ ту же
 * запись, а не создаёт новую.
 */
import { describe, it, expect, vi } from 'vitest';
import { ensureAssetOnce } from '../lib/ensure-asset-once';

const PAYLOAD = {
  ownerClientId: 'client-1',
  assetModelId: 'model-1',
  model: 'Дефибриллятор',
  manufacturer: 'Zoll',
  serialNumber: 'SN-1',
  inventoryNumber: null,
  riskClass: null,
  requiredAttestationCategory: null,
};

function api() {
  return {
    create: vi.fn(() => Promise.resolve({ id: 'asset-1' })),
    update: vi.fn(() => Promise.resolve(undefined)),
  };
}

describe('ensureAssetOnce', () => {
  it('первый раз заводит аппарат', async () => {
    const memo = { current: null as string | null };
    const a = api();
    const id = await ensureAssetOnce(memo, PAYLOAD, a);
    expect(id).toBe('asset-1');
    expect(a.create).toHaveBeenCalledTimes(1);
    expect(a.update).not.toHaveBeenCalled();
    expect(memo.current).toBe('asset-1');
  });

  it('повторная отправка правит тот же аппарат, а не заводит второй', async () => {
    const memo = { current: null as string | null };
    const a = api();
    await ensureAssetOnce(memo, PAYLOAD, a);
    // Человек поправил серийник и нажал «Создать» ещё раз.
    const id = await ensureAssetOnce(memo, { ...PAYLOAD, serialNumber: 'SN-2' }, a);

    expect(id).toBe('asset-1');
    expect(a.create).toHaveBeenCalledTimes(1);
    expect(a.update).toHaveBeenCalledTimes(1);
    expect(a.update).toHaveBeenCalledWith({
      id: 'asset-1',
      patch: { ...PAYLOAD, serialNumber: 'SN-2' },
    });
  });

  it('третья попытка тоже не заводит нового', async () => {
    const memo = { current: null as string | null };
    const a = api();
    await ensureAssetOnce(memo, PAYLOAD, a);
    await ensureAssetOnce(memo, PAYLOAD, a);
    await ensureAssetOnce(memo, PAYLOAD, a);
    expect(a.create).toHaveBeenCalledTimes(1);
    expect(a.update).toHaveBeenCalledTimes(2);
  });

  it('если создание упало, аппарат не запоминается — следующая попытка заводит заново', async () => {
    const memo = { current: null as string | null };
    const a = {
      create: vi.fn(() => Promise.reject(new Error('нет связи'))),
      update: vi.fn(() => Promise.resolve(undefined)),
    };
    await expect(ensureAssetOnce(memo, PAYLOAD, a)).rejects.toThrow('нет связи');
    expect(memo.current).toBeNull();
  });
});
