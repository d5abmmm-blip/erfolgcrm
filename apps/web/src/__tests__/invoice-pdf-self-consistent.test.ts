/**
 * Печатный счёт сходится сам с собой.
 *
 * ЧТО БЫЛО. Карточка счёта собирала данные для PDF из ДВУХ источников сразу, и
 * в коде это стояло прямо как компромисс: итог и ставка НДС — из «замороженного»
 * снимка счёта, а детализация строк — из ЖИВОГО наряда, «best available».
 * Поправил менеджер наряд после выставления — и в напечатанном счёте строки
 * складываются в одну сумму, а «Всего к оплате» показывает другую. Документ при
 * этом подписывают и отдают клиенту.
 *
 * РЕШЕНИЕ ВЛАДЕЛЬЦА 2026-08-17: замораживать и строки. Теперь сервер хранит
 * снимок строк рядом с суммой, а экран печатает ЕГО.
 *
 * Сторожим по исходнику: карточка счёта тянет наряд, клиента и заявку, и
 * компонентный тест здесь был бы дороже и хрупче самой проверки — тот же приём,
 * что у сторожа «на телефоне инженера нет рублей».
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, '../pages/InvoiceCardPage.tsx'), 'utf8');

describe('счёт печатается из своего снимка', () => {
  it('строки берутся из счёта, а наряд — только запасной вариант', () => {
    expect(src).toMatch(/toPdfLines\(inv\.data\.lines \?\? workOrderQuery\.lines\)/);
  });

  it('живой наряд больше не единственный источник строк', () => {
    expect(src).not.toMatch(/lines:\s*toPdfLines\(workOrderQuery\.lines\)/);
  });

  it('итог по-прежнему из счёта, а не из наряда', () => {
    expect(src).toMatch(/totalAmountKopecks:\s*Number\(inv\.data\.totalAmountKopecks\)/);
  });

  it('старое описание компромисса убрано из кода', () => {
    expect(src).not.toMatch(/best available/i);
  });
});
