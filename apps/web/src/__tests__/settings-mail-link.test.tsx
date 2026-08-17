/**
 * В «Настройках» видна ссылка на почту.
 *
 * ЗАЧЕМ. Страница настроек почты (/settings/email — ящик, SMTP/IMAP,
 * «Проверить связь») существует и работает, но попасть на неё можно было
 * только руками набрав адрес: в индексе «Настройки» карточки не было.
 * Для владельца это выглядело как «настроек почты в системе нет».
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SettingsPage } from '../pages/SettingsPage';

afterEach(cleanup);

describe('индекс настроек', () => {
  it('содержит карточку «Почта» со ссылкой на /settings/email', () => {
    render(<SettingsPage />);
    const title = screen.getByText('Почта');
    const link = title.closest('a');
    expect(link).toBeTruthy();
    expect(link!.getAttribute('href')).toBe('/settings/email');
  });
});
