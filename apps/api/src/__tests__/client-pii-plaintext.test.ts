/**
 * ПДн клиентов и контактов хранятся ОТКРЫТО (миграция 0078 + скрипт decrypt-pii).
 *
 * Зачем сняли шифрование: ключ PII_ENCRYPTION_KEY лежал в .env на том же сервере,
 * что и база, поэтому от кражи сервера не защищал (об этом прямо написано в
 * packages/db/src/crypto.ts), зато создавал единственный в системе риск «потерял
 * ключ — потерял данные навсегда при живой базе». Защита копии перенесена на
 * уровень файла бэкапа.
 *
 * Что стерегут тесты:
 *   1-3. Запись и чтение ФИО/телефона/адреса физлица без всякого ключа.
 *   4.   Контакт вообще создаётся. Это не формальность: у contacts шифрованные
 *        колонки были NOT NULL, и без `DROP NOT NULL` в миграции первый же
 *        новый контакт падал бы на проде с ошибкой вставки.
 *   5-7. Поиск. До этой правки физлицо было НЕЛЬЗЯ найти по полному ФИО и телефону:
 *        searchClients смотрел только в display_name (инициалы «Иванов И.И.») и ИНН.
 *        Это и есть видимая польза от снятия шифрования.
 *   8.   Поиск существующего физлица по телефону (защита от дублей из Telegram-бота)
 *        работает на открытой колонке и терпит разные записи номера.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { like } from 'drizzle-orm';
import { clients, getDb, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import {
  createClient,
  createContact,
  findIndividualClientIdByPhone,
  getClient,
  phoneSearchDigits,
  searchClients,
  updateClient,
  updateContact,
} from '../modules/clients/repository';

const TEST_PREFIX = 'TESTPII-';

let erfolgId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
});

afterAll(async () => {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    // Контакты уезжают каскадом за клиентом (contacts.client_id ON DELETE CASCADE).
    await tx.delete(clients).where(like(clients.displayName, `${TEST_PREFIX}%`));
  });
});

/** Уникальный хвост, чтобы параллельные прогоны не находили чужие строки. */
const uniq = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

async function makeIndividual(fields: {
  displayName: string;
  fullName?: string;
  phone?: string;
  address?: string;
}): Promise<string> {
  const { id } = await createClient(getDb(), erfolgId, {
    type: 'individual',
    displayName: fields.displayName,
    individualFullName: fields.fullName ?? null,
    individualPhone: fields.phone ?? null,
    individualAddress: fields.address ?? null,
  });
  return id;
}

describe('ПДн физлица хранятся открыто', () => {
  it('1. ФИО, телефон и адрес записываются и читаются без ключа шифрования', async () => {
    const tag = uniq();
    const id = await makeIndividual({
      displayName: `${TEST_PREFIX}Петров П.П.-${tag}`,
      fullName: `Петров Пётр Петрович ${tag}`,
      phone: '+7 928 111-22-33',
      address: 'Грозный, ул. Мира, 1',
    });

    const dto = await getClient(getDb(), erfolgId, id);
    expect(dto?.individualFullName).toBe(`Петров Пётр Петрович ${tag}`);
    expect(dto?.individualPhone).toBe('+7 928 111-22-33');
    expect(dto?.individualAddress).toBe('Грозный, ул. Мира, 1');
  });

  it('2. значение лежит в базе открытым текстом, а не байтами', async () => {
    const tag = uniq();
    const fio = `Сидоров Сидор Сидорович ${tag}`;
    await makeIndividual({ displayName: `${TEST_PREFIX}Сидоров С.С.-${tag}`, fullName: fio });

    // Читаем колонку НАПРЯМУЮ, минуя репозиторий: если бы значение шифровалось,
    // сравнение со строкой не сошлось бы.
    const rows = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ v: clients.individualFullName })
        .from(clients)
        .where(like(clients.individualFullName, `%${tag}`)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.v).toBe(fio);
  });

  it('3. правка ФИО сохраняется, явный null очищает поле', async () => {
    const tag = uniq();
    const id = await makeIndividual({
      displayName: `${TEST_PREFIX}Правка-${tag}`,
      fullName: 'Было Было Было',
      phone: '+7 900 000-00-00',
    });

    await updateClient(getDb(), erfolgId, id, { individualFullName: `Стало Стало ${tag}` });
    expect((await getClient(getDb(), erfolgId, id))?.individualFullName).toBe(`Стало Стало ${tag}`);

    await updateClient(getDb(), erfolgId, id, { individualPhone: null });
    const after = await getClient(getDb(), erfolgId, id);
    expect(after?.individualPhone).toBeNull();
    // Соседнее поле не задето — правка ЧАСТИЧНАЯ.
    expect(after?.individualFullName).toBe(`Стало Стало ${tag}`);
  });
});

describe('контактное лицо', () => {
  it('4. создаётся и правится (шифрованные колонки были NOT NULL — миграция сняла)', async () => {
    const tag = uniq();
    const clientId = await makeIndividual({ displayName: `${TEST_PREFIX}СКонтактом-${tag}` });

    const { id: contactId } = await createContact(getDb(), erfolgId, {
      clientId,
      fullName: `Иванова Мария Ивановна ${tag}`,
      phone: '+7 928 555-44-33',
      position: 'главный инженер',
      isPrimary: true,
    });

    const dto = await getClient(getDb(), erfolgId, clientId);
    expect(dto?.contacts).toHaveLength(1);
    expect(dto?.contacts[0]?.fullName).toBe(`Иванова Мария Ивановна ${tag}`);
    expect(dto?.contacts[0]?.phone).toBe('+7 928 555-44-33');

    await updateContact(getDb(), erfolgId, contactId, { phone: '+7 928 000-11-22' });
    const after = await getClient(getDb(), erfolgId, clientId);
    expect(after?.contacts[0]?.phone).toBe('+7 928 000-11-22');
    expect(after?.contacts[0]?.fullName).toBe(`Иванова Мария Ивановна ${tag}`);
  });
});

describe('поиск клиента', () => {
  it('5. находит физлицо по ПОЛНОМУ ФИО (раньше было невозможно)', async () => {
    const tag = uniq();
    const id = await makeIndividual({
      // В display_name только инициалы — как их и кладёт интерфейс.
      displayName: `${TEST_PREFIX}Магомадов М.М.-${tag}`,
      fullName: `Магомадов Муслим Магомедович ${tag}`,
    });

    const found = await searchClients(getDb(), erfolgId, `Муслим Магомедович ${tag}`);
    expect(found.map((c) => c.id)).toContain(id);
  });

  it('6. находит физлицо по отчеству (в инициалах его нет вовсе)', async () => {
    const tag = uniq();
    const id = await makeIndividual({
      displayName: `${TEST_PREFIX}Хасанов Х.Х.-${tag}`,
      fullName: `Хасанов Хас Вахитович${tag}`,
    });

    const found = await searchClients(getDb(), erfolgId, `Вахитович${tag}`);
    expect(found.map((c) => c.id)).toContain(id);
  });

  it('7. находит физлицо по телефону, КАК БЫ ОН НИ БЫЛ ЗАПИСАН', async () => {
    // На боевых данных один и тот же номер записан шестью способами:
    // «8-928-…», «8(928) …», «89281234567» и т.д. Поэтому сравниваем только цифры —
    // иначе поиск работал бы лишь при угадывании формата.
    const tag = uniq().slice(-7);
    const id = await makeIndividual({
      displayName: `${TEST_PREFIX}ПоТелефону-${tag}`,
      fullName: 'Телефонов Т.Т.',
      phone: `8(963) ${tag.slice(0, 3)}-${tag.slice(3, 5)}-${tag.slice(5)}`,
    });

    // Набрано сплошными цифрами — в базе номер со скобками и дефисами.
    const byDigits = await searchClients(getDb(), erfolgId, tag);
    expect(byDigits.map((c) => c.id)).toContain(id);

    // Набрано в другом формате, чем записано.
    const byOtherFormat = await searchClients(
      getDb(),
      erfolgId,
      `963-${tag.slice(0, 3)} ${tag.slice(3)}`,
    );
    expect(byOtherFormat.map((c) => c.id)).toContain(id);
  });

  it('7б. короткий цифровой запрос не тянет пол-картотеки', async () => {
    const tag = uniq().slice(-7);
    // ⚠️ Имя НАМЕРЕННО без единой цифры. searchClients ищет и по названию тоже,
    // поэтому если цифры запроса встречаются в имени, клиент находится ПО ИМЕНИ —
    // и порог по телефону проверять уже нечем. Раньше имя содержало тот же tag,
    // тест был обречён находить клиента и «проходил» лишь по случайности: в
    // засорённой локальной базе строка не попадала в LIMIT 10. На чистой базе
    // (CI) он сразу упал. Отсюда буквы вместо цифр — один в один по позициям.
    const nameTag = tag.replace(/\d/g, (d) => 'абвгдежзий'[Number(d)] ?? 'я');
    const id = await makeIndividual({
      displayName: `${TEST_PREFIX}Короткий-${nameTag}`,
      fullName: 'Короткий К.К.',
      phone: `8(963) ${tag}`,
    });

    // Две цифры — ниже порога, условие по телефону не добавляется вовсе,
    // а зацепиться в этой записи цифрам больше не за что.
    const found = await searchClients(getDb(), erfolgId, tag.slice(0, 2));
    expect(found.map((c) => c.id)).not.toContain(id);
  });

  /**
   * Сам порог — отдельно и без базы.
   *
   * Проверка выше зависит от `LIMIT 10` в searchClients: если строк, подходящих
   * под две цифры, больше десяти, нужная не попадёт в выдачу и тест пройдёт даже
   * со сломанным порогом. Ровно так и случилось при проверке 2026-08-06. Поэтому
   * условие проверяется ещё и напрямую — этот тест падает от любой правки порога.
   */
  it('7в. порог в три цифры — проверка без базы', () => {
    expect(phoneSearchDigits('1')).toBeNull();
    expect(phoneSearchDigits('12')).toBeNull();
    expect(phoneSearchDigits('Иванов')).toBeNull();
    expect(phoneSearchDigits('8-9')).toBeNull();

    expect(phoneSearchDigits('123')).toBe('123');
    expect(phoneSearchDigits('8(963) 123-45-67')).toBe('89631234567');
    expect(phoneSearchDigits('дом 12, кв 3')).toBe('123');
  });
});

describe('поиск физлица по телефону для защиты от дублей', () => {
  it('8. один номер в разных записях считается одним человеком', async () => {
    const tail = uniq().slice(-7);
    const id = await makeIndividual({
      displayName: `${TEST_PREFIX}Дубль-${tail}`,
      fullName: 'Дублев Д.Д.',
      phone: `+7 928 ${tail}`,
    });

    // Тот же номер, записанный иначе — «8928…» вместо «+7 928 …».
    const viaEight = await findIndividualClientIdByPhone(getDb(), erfolgId, `8928${tail}`);
    expect(viaEight).toBe(id);

    // Чужой номер не находится.
    const other = await findIndividualClientIdByPhone(getDb(), erfolgId, '+7 999 0000000');
    expect(other).not.toBe(id);
  });
});
