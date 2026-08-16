/**
 * На телефоне инженера рублей нет.
 *
 * РЕШЕНИЕ ВЛАДЕЛЬЦА (#122). Цену и строки наряда заводит менеджер в десктопе: у
 * инженера на телефоне нет ни строк, ни рублей. Причина не в секретности —
 * себестоимость труда считается как процент от цены строки, поэтому одним числом
 * инженер и счёт клиенту выставлял бы, и сделку себе назначал.
 *
 * Кнопка «Журнал работ» при этом печатала итог наряда прямо на экране заявки —
 * ровно ту сумму, которую от него прячут двумя экранами дальше.
 *
 * Сторож — по исходнику, а не по отрисовке: экран тянет десяток процедур, и
 * компонентный тест здесь был бы дороже и хрупче, чем сама проверка. Заработок
 * самого инженера (/m/earnings) — отдельная страница со своим переключателем в
 * настройках, её этот сторож не касается.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const mobileDir = resolve(here, '../pages/mobile');

/** Страницы кабинета инженера, где денег быть не должно. */
const PAGES = ['MobileTicketPage.tsx', 'MobileQueuePage.tsx', 'MobileWorkLogPage.tsx'];

describe('мобильный кабинет инженера не показывает деньги', () => {
  for (const page of PAGES) {
    it(`${page} не печатает рублёвых сумм`, () => {
      const src = readFileSync(resolve(mobileDir, page), 'utf8');
      // Ищем знак рубля в разметке и обращения к денежным полям наряда.
      expect(src).not.toMatch(/₽/);
      expect(src).not.toMatch(/totalAmountKopecks\)\s*\/\s*100/);
    });
  }
});
