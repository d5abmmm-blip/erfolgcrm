/**
 * Разовый автопереход инженера с корня на /m/queue.
 *
 * После входа инженер должен оказаться в мобильной очереди. Но переход обязан
 * быть РАЗОВЫМ на сессию вкладки: кнопка «Открыть полную версию» в мобильном
 * профиле ведёт на '/', и вечный редирект пружинил обратно в /m/queue —
 * полная версия для инженера была недостижима вовсе.
 */
export function shouldAutoOpenEngineerQueue(
  role: 'director' | 'dispatcher' | 'engineer' | undefined,
  path: string,
  alreadyRedirected: boolean,
): boolean {
  return role === 'engineer' && path === '/' && !alreadyRedirected;
}
