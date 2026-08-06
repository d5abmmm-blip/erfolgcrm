/**
 * Извлечение содержимого из вложений AI-ассистента.
 *
 * Стратегия (модель в OpenRouter — vision):
 *  - Изображения (jpg/png/webp/gif) → отдаём модели НАПРЯМУЮ как image_url
 *    (data-URL), сервер их не распознаёт. Это работает только с vision-моделью.
 *  - Цифровой PDF / DOCX / TXT → извлекаем ТЕКСТ на сервере и кладём в контекст
 *    диалога. Работает с любой моделью.
 *  - PDF без текстового слоя (скан) → текст пустой: просим прислать фото/картинкой.
 *
 * Лимиты: размер файла валидируется на уровне tRPC-схемы (router.ts). Здесь —
 * только потолок на длину извлечённого текста, чтобы не раздувать токены.
 */
import { extractText, getDocumentProxy } from 'unpdf';
import mammoth from 'mammoth';

/** Максимум символов извлечённого текста на один документ (~5–7k токенов). */
const MAX_TEXT_CHARS = 20_000;

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);

export interface IncomingAttachment {
  name: string;
  mimeType: string;
  /** Содержимое файла в base64 (без префикса data:). */
  dataBase64: string;
}

export type ProcessedAttachment =
  | { name: string; kind: 'text'; text: string }
  | { name: string; kind: 'image'; imageDataUrl: string }
  | { name: string; kind: 'unsupported'; note: string };

export function isImageMime(mime: string): boolean {
  return IMAGE_MIMES.has(mime.toLowerCase());
}

function clip(text: string): string {
  const t = text.trim();
  if (t.length <= MAX_TEXT_CHARS) return t;
  return `${t.slice(0, MAX_TEXT_CHARS)}\n…[текст обрезан, документ длиннее ${MAX_TEXT_CHARS} символов]`;
}

async function extractPdf(buf: Buffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join('\n') : text;
}

async function extractDocx(buf: Buffer): Promise<string> {
  const { value } = await mammoth.extractRawText({ buffer: buf });
  return value;
}

/**
 * Разобрать одно вложение. Никогда не бросает — на ошибке возвращает kind:'unsupported'
 * с пояснением, чтобы ассистент мог честно сообщить пользователю.
 */
export async function processAttachment(att: IncomingAttachment): Promise<ProcessedAttachment> {
  const mime = att.mimeType.toLowerCase();
  let buf: Buffer;
  try {
    buf = Buffer.from(att.dataBase64, 'base64');
  } catch {
    return { name: att.name, kind: 'unsupported', note: 'не удалось прочитать файл' };
  }

  // Картинки — пробрасываем как есть (читает vision-модель).
  if (isImageMime(mime)) {
    return {
      name: att.name,
      kind: 'image',
      imageDataUrl: `data:${mime};base64,${att.dataBase64}`,
    };
  }

  try {
    if (mime === 'application/pdf' || att.name.toLowerCase().endsWith('.pdf')) {
      const text = clip(await extractPdf(buf));
      if (!text) {
        return {
          name: att.name,
          kind: 'unsupported',
          note: 'PDF без текстового слоя (похоже на скан). Пришлите документ фото/картинкой — его прочитает зрячая модель.',
        };
      }
      return { name: att.name, kind: 'text', text };
    }

    if (mime === DOCX_MIME || att.name.toLowerCase().endsWith('.docx')) {
      const text = clip(await extractDocx(buf));
      if (!text) {
        return { name: att.name, kind: 'unsupported', note: 'пустой документ Word' };
      }
      return { name: att.name, kind: 'text', text };
    }

    if (mime.startsWith('text/') || att.name.toLowerCase().endsWith('.txt')) {
      const text = clip(buf.toString('utf8'));
      return { name: att.name, kind: 'text', text };
    }
  } catch (err) {
    return {
      name: att.name,
      kind: 'unsupported',
      note: `не удалось разобрать (${err instanceof Error ? err.message : 'ошибка'})`,
    };
  }

  return {
    name: att.name,
    kind: 'unsupported',
    note: `формат не поддерживается (${att.mimeType}). Поддерживаются PDF, Word (.docx), txt и изображения.`,
  };
}
