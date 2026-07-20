/**
 * Очередь инженера (/m/queue): плашка «Назначено новых» и подпись «показано N из M».
 *
 * Две находки аудита, которые нельзя чинить порознь:
 *   • список молча обрезался на 100 заявках — ни счётчика, ни кнопки «ещё».
 *     У живых инженеров 416/404/359/331/288/269/249 заявок, то есть обрезало
 *     почти у каждого, и выглядело это как «заявки нет»;
 *   • плашка считалась от total ТОГО ЖЕ запроса и от одного ключа localStorage
 *     на обе вкладки: отметив просмотренным архив на 480 заявок, инженер
 *     больше никогда не увидел бы плашку на «Активных».
 */
import { describe, it, expect } from 'vitest';
import {
  newAssignmentsCount,
  nextPageSize,
  readSeen,
  rebasedSeen,
  seenStorageKey,
  shownOfTotal,
} from '../lib/queue-badge';

describe('плашка «Назначено новых»', () => {
  it('показывает разницу с прошлого визита', () => {
    expect(newAssignmentsCount(12, 9)).toBe(3);
  });

  it('молчит, когда нового нет', () => {
    expect(newAssignmentsCount(9, 9)).toBe(0);
  });

  it('не уходит в минус, когда заявок стало меньше', () => {
    // Инженер закрыл несколько — это не «минус три новых».
    expect(newAssignmentsCount(6, 9)).toBe(0);
  });

  it('на первом заходе молчит, а не кричит про все заявки', () => {
    expect(newAssignmentsCount(12, null)).toBe(0);
  });

  it('считается от активных, поэтому архив на 480 заявок её не глушит', () => {
    // Старая логика: seen = 480 (общее число со вкладки «Все»),
    // активных 12 → max(0, 12 - 480) = 0, плашка не появлялась НИКОГДА.
    // Теперь обе величины — про активные заявки.
    const активныхБыло = 12;
    const активныхСтало = 15;
    expect(newAssignmentsCount(активныхСтало, активныхБыло)).toBe(3);
  });

  it('ключ хранения новый — старое значение из «Все» не мешает', () => {
    expect(seenStorageKey('eng-1')).toBe('m-queue-seen-active-eng-1');
    expect(seenStorageKey('eng-1')).not.toBe('m-queue-seen-eng-1');
  });
});

describe('отметка опускается, когда заявки закрыли', () => {
  // Поймано на dev-проверке, а не тестом: закрыл 25 заявок из 60 → активных 38,
  // а в памяти осталось 60. Следующее назначение (39) плашку бы не показало.
  it('активных стало меньше запомненного → отметка опускается', () => {
    expect(rebasedSeen(38, 60)).toBe(38);
  });

  it('после опускания следующее назначение сразу видно', () => {
    const опущено = rebasedSeen(38, 60);
    expect(newAssignmentsCount(39, опущено)).toBe(1);
  });

  it('активных столько же или больше → трогать не надо', () => {
    expect(rebasedSeen(60, 60)).toBeNull();
    expect(rebasedSeen(63, 60)).toBeNull();
  });

  it('первый заход отдельно, здесь не вмешиваемся', () => {
    expect(rebasedSeen(10, null)).toBeNull();
  });
});

describe('чтение отметки из localStorage', () => {
  it('нет записи → первый заход', () => {
    expect(readSeen(null)).toBeNull();
  });

  it('число читается', () => {
    expect(readSeen('7')).toBe(7);
    expect(readSeen('0')).toBe(0);
  });

  it('мусор и отрицательные не ломают экран', () => {
    expect(readSeen('абв')).toBeNull();
    expect(readSeen('')).toBeNull();
    expect(readSeen('-3')).toBeNull();
  });
});

describe('подпись «показано N из M»', () => {
  it('молчит, когда показано всё', () => {
    expect(shownOfTotal(12, 12)).toBeNull();
    expect(shownOfTotal(50, 0)).toBeNull();
  });

  it('говорит, когда список обрезан — это и была жалоба', () => {
    expect(shownOfTotal(50, 416)).toBe('Показано 50 из 416');
  });
});

describe('догрузка', () => {
  it('растёт шагами', () => {
    expect(nextPageSize(50, 50, 500)).toBe(100);
    expect(nextPageSize(100, 50, 500)).toBe(150);
  });

  it('не просит у сервера больше, чем он отдаёт', () => {
    expect(nextPageSize(480, 50, 500)).toBe(500);
    expect(nextPageSize(500, 50, 500)).toBe(500);
  });

  it('доходит до 416 заявок самого загруженного инженера', () => {
    let n = 50;
    let шагов = 0;
    while (n < 416 && шагов < 50) {
      n = nextPageSize(n, 50, 500);
      шагов += 1;
    }
    expect(n).toBeGreaterThanOrEqual(416);
  });
});
