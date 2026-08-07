/**
 * Отметка состояния записи для одного поля: «записываю…» → «записано».
 *
 * Зелёная отметка гаснет сама через пару секунд — иначе экран наряда
 * зарастает галочками и они перестают что-либо значить. «Ждёт связи»
 * не гаснет: пока правка не ушла, человек должен это видеть.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { SAVED_MARK_MS, saveMarkFromResult, type SaveMarkState } from './save-state';

export function useSaveMark() {
  const [state, setState] = useState<SaveMarkState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const markSaving = useCallback(() => {
    clearTimer();
    setState('saving');
  }, []);

  const markResult = useCallback((status: 'ok' | 'queued' | 'error') => {
    clearTimer();
    const next = saveMarkFromResult(status);
    setState(next);
    if (next === 'saved') {
      timer.current = setTimeout(() => setState('idle'), SAVED_MARK_MS);
    }
  }, []);

  return { state, markSaving, markResult };
}
