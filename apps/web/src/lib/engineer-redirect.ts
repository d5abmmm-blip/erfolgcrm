/**
 * Автопереход инженера с корня на /m/queue — и как из него выйти.
 *
 * После входа инженер должен оказаться в мобильной очереди. Но переход обязан
 * уступать явному намерению: кнопка «Открыть полную версию» в мобильном профиле
 * ведёт на '/', и вечный редирект пружинил обратно — полная версия была
 * недостижима вовсе.
 *
 * Одного «сработать только раз за сессию» мало: PWA стартует сразу с /m/queue
 * (manifest start_url), инженер вообще не проходит через '/', и первое же
 * нажатие «Полной версии» читалось бы как «переход после входа». Поэтому кнопка
 * ставит явный флаг, а автопереход его уважает.
 *
 * Флаг живёт в sessionStorage: закрыл приложение и открыл заново — снова
 * очередь, как и ожидает инженер.
 */
const DESKTOP_INTENT_KEY = 'erfolg-engineer-wants-desktop';

export function markEngineerWantsDesktop(): void {
  try {
    sessionStorage.setItem(DESKTOP_INTENT_KEY, '1');
  } catch {
    /* приватный режим — переживём, редирект просто останется прежним */
  }
}

/** Вернулся в мобильный кабинет — намерение исчерпано. */
export function clearEngineerWantsDesktop(): void {
  try {
    sessionStorage.removeItem(DESKTOP_INTENT_KEY);
  } catch {
    /* ignore */
  }
}

export function engineerWantsDesktop(): boolean {
  try {
    return sessionStorage.getItem(DESKTOP_INTENT_KEY) === '1';
  } catch {
    return false;
  }
}

export function shouldAutoOpenEngineerQueue(
  role: 'director' | 'dispatcher' | 'engineer' | undefined,
  path: string,
  wantsDesktop: boolean,
): boolean {
  return role === 'engineer' && path === '/' && !wantsDesktop;
}
