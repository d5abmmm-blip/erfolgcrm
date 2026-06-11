/**
 * Лёгкий безопасный Markdown-рендерер для предпросмотра статей базы знаний.
 *
 * Не подключаем react-markdown / marked, чтобы не тащить ~80kb на тысячу
 * читателей в день. Поддерживаем только то, что реально пишут менеджеры:
 *   - заголовки `# ## ###`
 *   - жирный `**…**`, курсив `*…*`
 *   - инлайн-код `` `…` ``, блоки кода ``` …``` ```
 *   - маркированные/нумерованные списки
 *   - параграфы и переносы
 *   - ссылки `[text](https://…)`
 *
 * Безопасность:
 *   1. Сырой ввод сначала прогоняется через escapeHtml — никакого html через preview не пройдёт.
 *   2. Ссылки разрешены только если URL начинается с http(s):// — javascript: блокируется.
 *   3. На атрибуты добавляется rel="noopener noreferrer" и target="_blank".
 *   4. Никаких eval/innerHTML кроме результата renderMarkdown — он сам экранирует.
 *
 * Это не полный CommonMark, но и не нужен — для inline-вики 11 человек хватит.
 */

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch] ?? ch);
}

function renderInline(text: string): string {
  let out = escapeHtml(text);
  // Inline-код: `…` (до bold/italic, чтобы * внутри не сломал)
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Жирный + курсив: ***x***
  out = out.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  // Жирный: **x**
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Курсив: *x*
  out = out.replace(/(^|\s)\*([^*\s][^*]*[^*\s]|[^*\s])\*/g, '$1<em>$2</em>');
  // Ссылки: [text](https://...)
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  return out;
}

/**
 * Главный рендер. Возвращает HTML, который безопасен для dangerouslySetInnerHTML
 * — все источники прошли escapeHtml перед сборкой тегов.
 */
export function renderMarkdown(input: string | null | undefined): string {
  if (!input) return '<p class="text-muted-foreground">Пусто.</p>';
  const lines = input.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];

  let inCode = false;
  let codeBuf: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let paraBuf: string[] = [];

  function flushPara() {
    if (paraBuf.length === 0) return;
    out.push('<p>' + renderInline(paraBuf.join(' ').trim()) + '</p>');
    paraBuf = [];
  }
  function flushList() {
    if (!listType) return;
    out.push(`</${listType}>`);
    listType = null;
  }

  for (const line of lines) {
    if (inCode) {
      if (line.trim() === '```') {
        out.push('<pre><code>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>');
        codeBuf = [];
        inCode = false;
      } else {
        codeBuf.push(line);
      }
      continue;
    }
    if (line.trim().startsWith('```')) {
      flushPara();
      flushList();
      inCode = true;
      continue;
    }
    if (line.trim() === '') {
      flushPara();
      flushList();
      continue;
    }
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      flushPara();
      flushList();
      const level = headingMatch[1]!.length;
      out.push(`<h${level}>${renderInline(headingMatch[2]!)}</h${level}>`);
      continue;
    }
    const ulMatch = /^[\s]*[-*]\s+(.+)$/.exec(line);
    if (ulMatch) {
      flushPara();
      if (listType !== 'ul') {
        flushList();
        out.push('<ul>');
        listType = 'ul';
      }
      out.push('<li>' + renderInline(ulMatch[1]!) + '</li>');
      continue;
    }
    const olMatch = /^[\s]*\d+\.\s+(.+)$/.exec(line);
    if (olMatch) {
      flushPara();
      if (listType !== 'ol') {
        flushList();
        out.push('<ol>');
        listType = 'ol';
      }
      out.push('<li>' + renderInline(olMatch[1]!) + '</li>');
      continue;
    }
    flushList();
    paraBuf.push(line);
  }
  flushPara();
  flushList();
  if (inCode) {
    // незакрытый блок кода — отдадим как есть, чтобы пользователь видел проблему
    out.push('<pre><code>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>');
  }
  return out.join('\n');
}
