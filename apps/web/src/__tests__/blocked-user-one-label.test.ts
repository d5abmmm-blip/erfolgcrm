/**
 * У неактивного сотрудника ОДНА подпись на всех экранах: «(заблокирован)».
 *
 * ЗАЧЕМ. На карточке заявки назначение инженера подписывало неактивного
 * «(заблокирован)» (TicketCardPage, два места), а редактор наряда НА ТОЙ ЖЕ
 * странице — «(уволен)». Одно и то же состояние (is_active = false) под двумя
 * именами путает: «уволен» — интерпретация (человека могли заблокировать не
 * увольняя: декрет, импортный аккаунт-двойник), «заблокирован» — факт системы,
 * и именно этим словом действие называется в «Пользователях».
 *
 * Сторож — по исходнику (приём PR #171): подпись собирается инлайном в разных
 * компонентах, и обычный рендер-тест ловил бы только один из них.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = [join(__dirname, '..', 'components'), join(__dirname, '..', 'pages')];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.tsx') ? [p] : [];
  });
}

describe('подпись неактивного сотрудника', () => {
  it('суффикса «(уволен)» в интерфейсе нет — только «(заблокирован)»', () => {
    const offenders = ROOTS.flatMap(walk).filter((f) =>
      readFileSync(f, 'utf8').includes('(уволен)'),
    );
    expect(offenders).toEqual([]);
  });
});
