/**
 * Фича №14 «Пакет документов одной кнопкой» — combineDocDefs.
 *
 * Проверяем чистую склейку нескольких pdfmake-документов в один:
 *   • content всех документов идёт последовательно;
 *   • перед каждым следующим документом — разрыв страницы (отдельный маркер);
 *   • единая раскладка A4 portrait + заголовок в info;
 *   • крайние случаи: один документ (без разрывов), пустой список, одиночный content.
 */
import { describe, it, expect } from 'vitest';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import { combineDocDefs } from '../lib/pdf';

/** Узкий структурный тип для чтения полей элементов content (без any). */
type Item = { text?: string; pageBreak?: string };

function doc(...items: string[]): TDocumentDefinitions {
  return { content: items.map((t) => ({ text: t })) };
}

function contentOf(d: TDocumentDefinitions): Item[] {
  return d.content as unknown as Item[];
}

describe('combineDocDefs — пакет документов', () => {
  it('склеивает content всех документов с разрывами страниц между ними', () => {
    const combined = combineDocDefs(
      [doc('A1', 'A2'), doc('B1'), doc('C1', 'C2', 'C3')],
      'Пакет T-1',
    );
    const content = contentOf(combined);
    // 2 + 1 + 3 = 6 элементов + 2 разрыва (перед B и перед C)
    expect(content.length).toBe(8);
    expect(content[2]?.pageBreak).toBe('before'); // маркер перед B
    expect(content[4]?.pageBreak).toBe('before'); // маркер перед C
    // порядок и содержимое сохранены (маркеры — с пустым текстом)
    const texts = content.map((x) => x.text).filter((t): t is string => !!t);
    expect(texts).toEqual(['A1', 'A2', 'B1', 'C1', 'C2', 'C3']);
  });

  it('один документ — без разрывов', () => {
    const content = contentOf(combineDocDefs([doc('X1', 'X2')], 't'));
    expect(content.length).toBe(2);
    expect(content.some((x) => x.pageBreak)).toBe(false);
  });

  it('единая раскладка A4 portrait и заголовок в info', () => {
    const combined = combineDocDefs([doc('X')], 'Пакет T-9');
    expect(combined.pageSize).toBe('A4');
    expect(combined.pageOrientation).toBe('portrait');
    expect(combined.pageMargins).toEqual([42, 42, 42, 42]);
    expect(combined.info?.title).toBe('Пакет T-9');
  });

  it('пустой список документов → пустой content', () => {
    expect(contentOf(combineDocDefs([], 't')).length).toBe(0);
  });

  it('поддерживает документ с одиночным (не-массив) content', () => {
    const single: TDocumentDefinitions = { content: { text: 'solo' } };
    const content = contentOf(combineDocDefs([single, doc('B')], 't'));
    expect(content.length).toBe(3); // solo + разрыв + B
    expect(content[0]?.text).toBe('solo');
    expect(content[1]?.pageBreak).toBe('before');
    expect(content[2]?.text).toBe('B');
  });
});
