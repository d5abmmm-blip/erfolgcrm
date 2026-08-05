/**
 * Автопереход инженера с корня в /m/queue и выход в полную версию.
 *
 * Найдено ЖИВОЙ проверкой в браузере, а не тестом: первой версией правки была
 * защита «сработать один раз за сессию», и она не помогла — PWA стартует сразу
 * с /m/queue (manifest start_url), инженер вообще не проходит через '/', и
 * первое же нажатие «Открыть полную версию» читалось как переход после входа.
 * Поэтому решает не счётчик, а явное намерение пользователя.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearEngineerWantsDesktop,
  engineerWantsDesktop,
  markEngineerWantsDesktop,
  shouldAutoOpenEngineerQueue,
} from '../lib/engineer-redirect';

afterEach(() => {
  clearEngineerWantsDesktop();
});

describe('shouldAutoOpenEngineerQueue', () => {
  it('инженер на корне без намерения — уводим в очередь', () => {
    expect(shouldAutoOpenEngineerQueue('engineer', '/', false)).toBe(true);
  });

  it('нажал «Открыть полную версию» — НЕ пружиним обратно', () => {
    expect(shouldAutoOpenEngineerQueue('engineer', '/', true)).toBe(false);
  });

  it('не корень — не вмешиваемся (глубокие ссылки полной версии работают)', () => {
    expect(shouldAutoOpenEngineerQueue('engineer', '/tickets', false)).toBe(false);
  });

  it('staff и неизвестная роль — никогда', () => {
    expect(shouldAutoOpenEngineerQueue('director', '/', false)).toBe(false);
    expect(shouldAutoOpenEngineerQueue('dispatcher', '/', false)).toBe(false);
    expect(shouldAutoOpenEngineerQueue(undefined, '/', false)).toBe(false);
  });
});

describe('флаг намерения', () => {
  it('по умолчанию выключен, кнопка включает, возврат в мобилку сбрасывает', () => {
    expect(engineerWantsDesktop()).toBe(false);
    markEngineerWantsDesktop();
    expect(engineerWantsDesktop()).toBe(true);
    clearEngineerWantsDesktop();
    expect(engineerWantsDesktop()).toBe(false);
  });

  it('сценарий целиком: PWA стартовал с /m/queue, корень через кнопку не уводит назад', () => {
    // Инженер '/' ни разу не открывал — старая защита «раз за сессию» тут не спасала.
    markEngineerWantsDesktop();
    expect(shouldAutoOpenEngineerQueue('engineer', '/', engineerWantsDesktop())).toBe(false);
    // Вернулся в кабинет — намерение исчерпано, корень снова уводит в очередь.
    clearEngineerWantsDesktop();
    expect(shouldAutoOpenEngineerQueue('engineer', '/', engineerWantsDesktop())).toBe(true);
  });
});
