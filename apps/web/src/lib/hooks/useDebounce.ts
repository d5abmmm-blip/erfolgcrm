import { useEffect, useState } from 'react';

/**
 * Возвращает значение, обновляемое с задержкой `delay` мс после последнего изменения исходного.
 * Используется в полях поиска: input -> useDebounce -> запрос на бэкенд.
 *
 * @example
 *   const [search, setSearch] = useState('');
 *   const debounced = useDebounce(search, 300);
 *   trpc.clients.list.useQuery({ search: debounced });
 */
export function useDebounce<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState<T>(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
