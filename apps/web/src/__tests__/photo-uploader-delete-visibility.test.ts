/**
 * Кому показывать корзинку на вложении.
 *
 * Сервер разрешает инженеру удалять только СВОЁ вложение (чужие и безавторные —
 * менеджер/директор). Экран не должен дразнить кнопкой, которая гарантированно
 * кончится отказом: корзинка на чужом вложении у инженера прячется.
 */
import { describe, it, expect } from 'vitest';
import { mayDeleteAttachment } from '../components/PhotoUploader';

const ENGINEER = { id: 'u-eng', role: 'engineer' };
const DISPATCHER = { id: 'u-disp', role: 'dispatcher' };

describe('mayDeleteAttachment', () => {
  it('инженер видит корзинку только на своём вложении', () => {
    expect(mayDeleteAttachment(ENGINEER, 'u-eng', true)).toBe(true);
    expect(mayDeleteAttachment(ENGINEER, 'u-disp', true)).toBe(false);
  });

  it('безавторное (импортированное) вложение инженеру не удалить', () => {
    expect(mayDeleteAttachment(ENGINEER, null, true)).toBe(false);
  });

  it('менеджер видит корзинку на любом вложении', () => {
    expect(mayDeleteAttachment(DISPATCHER, 'u-eng', true)).toBe(true);
    expect(mayDeleteAttachment(DISPATCHER, null, true)).toBe(true);
  });

  it('без права удаления корзинки нет ни у кого', () => {
    expect(mayDeleteAttachment(DISPATCHER, 'u-disp', false)).toBe(false);
    expect(mayDeleteAttachment(ENGINEER, 'u-eng', false)).toBe(false);
  });

  it('пока пользователь не загружен — корзинку не показываем', () => {
    expect(mayDeleteAttachment(undefined, 'u-eng', true)).toBe(false);
    expect(mayDeleteAttachment(null, 'u-eng', true)).toBe(false);
  });
});
