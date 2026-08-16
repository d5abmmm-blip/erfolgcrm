/**
 * Единица техники, заводимая формой «Новая заявка», — ровно одна на попытку.
 *
 * ЗАЧЕМ. Аппарат заводится ДО самой заявки: сначала `assets.create`, потом
 * `tickets.create` с его id. Если заявка не прошла — ошибка сервера, потерялась
 * связь, не заполнено поле, — человек правит форму и жмёт «Создать» ещё раз, и
 * заводилась ВТОРАЯ копия того же аппарата. В парке на бою 5079 единиц: лишние
 * там никому не видны и всплывают потом при поиске по серийнику.
 *
 * Поэтому форма помнит заведённый id и на повторной отправке ПРАВИТ ту же запись.
 * Память живёт до ухода со страницы (useRef): дольше её хранить незачем — заявка
 * либо создалась, либо человек ушёл.
 *
 * Если создание упало, id не запоминается: записи не появилось, и следующая
 * попытка обязана завести её заново.
 *
 * Тип полезной нагрузки — параметр: он должен совпадать с тем, что принимают
 * процедуры assets.create / assets.update, а не жить здесь второй копией.
 */
export interface AssetApi<P> {
  create: (payload: P) => Promise<{ id: string }>;
  update: (args: { id: string; patch: P }) => Promise<unknown>;
}

export async function ensureAssetOnce<P>(
  memo: { current: string | null },
  payload: P,
  api: AssetApi<P>,
): Promise<string> {
  if (memo.current) {
    await api.update({ id: memo.current, patch: payload });
    return memo.current;
  }
  const created = await api.create(payload);
  memo.current = created.id;
  return created.id;
}
