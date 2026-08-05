/**
 * Debounce для поисковых инпутов (склад слал запрос на каждую букву).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDebouncedValue } from '../lib/use-debounced-value';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useDebouncedValue', () => {
  it('отдаёт значение только после паузы', () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 300), {
      initialProps: { v: '' },
    });
    rerender({ v: 'д' });
    rerender({ v: 'дат' });
    rerender({ v: 'датчик' });
    expect(result.current).toBe('');
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(result.current).toBe('');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe('датчик');
  });
});
