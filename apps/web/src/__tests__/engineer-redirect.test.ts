/**
 * Автопереход инженера с корня в /m/queue должен быть РАЗОВЫМ: раньше он был
 * вечным, и «Открыть полную версию» из мобильного профиля (ссылка на '/')
 * пружинила обратно в очередь — полная версия была недостижима.
 */
import { describe, expect, it } from 'vitest';
import { shouldAutoOpenEngineerQueue } from '../lib/engineer-redirect';

describe('shouldAutoOpenEngineerQueue', () => {
  it('инженер на корне, редиректа ещё не было — переходим', () => {
    expect(shouldAutoOpenEngineerQueue('engineer', '/', false)).toBe(true);
  });

  it('редирект уже был — инженер сознательно открыл полную версию, не трогаем', () => {
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
