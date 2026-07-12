import { useEffect, useState } from 'react';

/**
 * true на «телефонной» ширине (< 768px — тот же порог, что `md:` в Tailwind,
 * где десктопная оболочка показывает боковое меню). Реактивно следит за
 * поворотом/ресайзом.
 */
const QUERY = '(max-width: 767px)';

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(QUERY).matches : false,
  );

  useEffect(() => {
    const mql = window.matchMedia(QUERY);
    const onChange = () => setIsMobile(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}
