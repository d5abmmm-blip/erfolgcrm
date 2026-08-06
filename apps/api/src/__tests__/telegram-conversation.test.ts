/**
 * Этап 7-B — state machine диалога Telegram-бота.
 *
 * Юнит-тесты `applyAnswer` + `nextStep` (без Redis).
 */
import { describe, it, expect } from 'vitest';
import { applyAnswer, nextStep, type ConversationState } from '../modules/telegram/conversation';

function fresh(): ConversationState {
  return { step: 'ASK_NAME', startedAt: Date.now() };
}

describe('telegram conversation state machine', () => {
  it('ASK_NAME принимает строку >= 2 символа', () => {
    const s = fresh();
    expect(applyAnswer(s, 'А')).toBe(false);
    expect(applyAnswer(s, 'Иван Петров')).toBe(true);
    expect(s.fullName).toBe('Иван Петров');
  });

  it('ASK_PHONE требует минимум 10 цифр', () => {
    const s: ConversationState = { step: 'ASK_PHONE', startedAt: 0 };
    expect(applyAnswer(s, '123')).toBe(false);
    expect(applyAnswer(s, '+7 (928) 123-45-67')).toBe(true);
    expect(s.phone).toBe('+7 (928) 123-45-67');
  });

  it('ASK_SYMPTOM требует минимум 5 символов', () => {
    const s: ConversationState = { step: 'ASK_SYMPTOM', startedAt: 0 };
    expect(applyAnswer(s, 'нет')).toBe(false);
    expect(applyAnswer(s, 'УЗИ-аппарат не включается')).toBe(true);
    expect(s.symptom).toBe('УЗИ-аппарат не включается');
  });

  it('ASK_ADDRESS требует минимум 3 символа', () => {
    const s: ConversationState = { step: 'ASK_ADDRESS', startedAt: 0 };
    expect(applyAnswer(s, 'г')).toBe(false);
    expect(applyAnswer(s, 'г. Грозный, ул. Мичурина, 98')).toBe(true);
    expect(s.address).toBe('г. Грозный, ул. Мичурина, 98');
  });

  it('nextStep идёт по цепочке IDLE → NAME → PHONE → SYMPTOM → ADDRESS → DONE', () => {
    expect(nextStep('IDLE')).toBe('ASK_NAME');
    expect(nextStep('ASK_NAME')).toBe('ASK_PHONE');
    expect(nextStep('ASK_PHONE')).toBe('ASK_SYMPTOM');
    expect(nextStep('ASK_SYMPTOM')).toBe('ASK_ADDRESS');
    expect(nextStep('ASK_ADDRESS')).toBe('DONE');
    expect(nextStep('DONE')).toBe('DONE');
  });

  it('после полной цепочки все 4 поля заполнены', () => {
    const s = fresh();
    expect(applyAnswer(s, 'Иванов Иван Иванович')).toBe(true);
    s.step = nextStep(s.step);
    expect(applyAnswer(s, '8 928 555 12 34')).toBe(true);
    s.step = nextStep(s.step);
    expect(applyAnswer(s, 'УЗИ Mindray DC-30 не включается')).toBe(true);
    s.step = nextStep(s.step);
    expect(applyAnswer(s, 'г. Грозный, ЦРБ')).toBe(true);
    s.step = nextStep(s.step);

    expect(s.step).toBe('DONE');
    expect(s.fullName).toBe('Иванов Иван Иванович');
    expect(s.phone).toBe('8 928 555 12 34');
    expect(s.symptom).toBe('УЗИ Mindray DC-30 не включается');
    expect(s.address).toBe('г. Грозный, ЦРБ');
  });

  it('обрезка слишком длинных значений', () => {
    const long = 'a'.repeat(2000);
    const s: ConversationState = { step: 'ASK_SYMPTOM', startedAt: 0 };
    applyAnswer(s, long);
    expect(s.symptom?.length).toBe(1000);
  });
});
