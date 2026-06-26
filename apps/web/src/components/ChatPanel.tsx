/**
 * Плавающая панель AI-ассистента.
 *
 * История диалога живёт на клиенте и целиком отправляется на сервер при каждом
 * запросе (бэкенд stateless). Операции записи бэкенд не выполняет сразу — он
 * возвращает превью действия, которое пользователь подтверждает кнопкой.
 *
 * LLM провайдеро-независимый (OpenRouter/DeepSeek/Qwen/локальные) — настраивается
 * через LLM_* в .env на стороне API. Если ключ не задан — панель показывает подсказку.
 */
import { useEffect, useRef, useState } from 'react';
import { Bot, Send, X, Loader2, Check, Ban, Paperclip, FileText } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}
interface PendingAction {
  tool: string;
  args: Record<string, unknown>;
  preview: string;
}
interface Attachment {
  name: string;
  mimeType: string;
  /** base64 без префикса data:. */
  dataBase64: string;
  size: number;
}

const MAX_FILES = 4;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 МБ

/** File → base64 (без data:-префикса). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = typeof reader.result === 'string' ? reader.result : '';
      const comma = res.indexOf(',');
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Не удалось прочитать файл'));
    reader.readAsDataURL(file);
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

export function ChatPanel() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const status = trpc.aiAssistant.status.useQuery(undefined, { staleTime: 60_000 });
  const send = trpc.aiAssistant.send.useMutation();
  const busy = send.isPending;
  const notConfigured = status.data?.configured === false;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, pending, busy, open]);

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    const room = MAX_FILES - attachments.length;
    if (room <= 0) {
      setError(`Можно приложить не более ${MAX_FILES} файлов`);
      return;
    }
    const added: Attachment[] = [];
    for (const f of Array.from(files).slice(0, room)) {
      if (f.size > MAX_FILE_BYTES) {
        setError(`Файл «${f.name}» больше 10 МБ`);
        continue;
      }
      try {
        const dataBase64 = await fileToBase64(f);
        added.push({
          name: f.name,
          mimeType: f.type || 'application/octet-stream',
          dataBase64,
          size: f.size,
        });
      } catch {
        setError(`Не удалось прочитать «${f.name}»`);
      }
    }
    if (added.length) setAttachments((a) => [...a, ...added]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function removeAttachment(idx: number) {
    setAttachments((a) => a.filter((_, i) => i !== idx));
  }

  async function handleSend() {
    if (busy) return;
    const hasFiles = attachments.length > 0;
    const text =
      input.trim() ||
      (hasFiles ? 'Разбери приложенные документы и предложи, что внести в CRM.' : '');
    if (!text) return;
    setError(null);
    setPending(null);
    const history: ChatMessage[] = [...messages, { role: 'user', content: text }];
    setMessages(history);
    setInput('');
    const filesToSend = attachments;
    setAttachments([]);
    try {
      const res = await send.mutateAsync({
        messages: history,
        attachments: hasFiles
          ? filesToSend.map(({ name, mimeType, dataBase64 }) => ({ name, mimeType, dataBase64 }))
          : undefined,
      });
      if (res.kind === 'message') {
        setMessages([...history, { role: 'assistant', content: res.text || '(пустой ответ)' }]);
      } else {
        if (res.text) setMessages([...history, { role: 'assistant', content: res.text }]);
        setPending(res.pendingAction);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка запроса');
    }
  }

  async function handleConfirm() {
    if (!pending || busy) return;
    setError(null);
    const action = pending;
    setPending(null);
    try {
      const res = await send.mutateAsync({
        messages,
        confirm: { tool: action.tool, args: action.args },
      });
      if (res.kind === 'message') {
        setMessages((m) => [...m, { role: 'assistant', content: res.text || '(готово)' }]);
      } else {
        if (res.text) setMessages((m) => [...m, { role: 'assistant', content: res.text! }]);
        setPending(res.pendingAction);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка выполнения');
      setPending(action); // вернуть карточку, чтобы можно было повторить/отменить
    }
  }

  function handleCancelAction() {
    setPending(null);
    setMessages((m) => [...m, { role: 'assistant', content: 'Действие отменено.' }]);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="AI-ассистент"
        aria-label="Открыть AI-ассистента"
        className="bg-primary text-primary-foreground fixed bottom-5 right-5 z-50 grid h-12 w-12 place-items-center rounded-full shadow-lg transition hover:opacity-90"
      >
        <Bot className="h-6 w-6" />
      </button>
    );
  }

  return (
    <div className="bg-card text-foreground fixed bottom-5 right-5 z-50 flex h-[34rem] max-h-[calc(100vh-2.5rem)] w-[24rem] max-w-[calc(100vw-2.5rem)] flex-col rounded-xl border shadow-2xl">
      {/* Шапка */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-3">
        <div className="flex items-center gap-2">
          <Bot className="text-primary h-5 w-5" />
          <span className="text-sm font-semibold">AI-ассистент</span>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-muted-foreground hover:bg-muted hover:text-foreground grid h-7 w-7 place-items-center rounded transition"
          aria-label="Свернуть"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Лента сообщений */}
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-3">
        {messages.length === 0 && (
          <div className="text-muted-foreground space-y-2 text-xs">
            <p>Помогу с заявками, клиентами, техникой и счетами. Например:</p>
            <ul className="list-disc space-y-1 pl-4">
              <li>«Найди клиента ООО Ромашка»</li>
              <li>«Создай заявку для … на ремонт тонометра»</li>
              <li>«Назначь инженера Петрова на заявку …»</li>
            </ul>
            <p>
              Через <Paperclip className="inline h-3 w-3" /> можно приложить договор или фото
              документов (PDF, Word, картинки) — разберу и предложу, что внести в CRM.
            </p>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
            <div
              className={cn(
                'max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm',
                m.role === 'user'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-foreground',
              )}
            >
              {m.content}
            </div>
          </div>
        ))}

        {busy && (
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Думаю…
          </div>
        )}

        {/* Карточка подтверждения write-действия */}
        {pending && (
          <div className="border-primary/40 bg-primary/5 space-y-2 rounded-lg border p-3">
            <div className="text-foreground text-xs font-semibold">Подтвердите действие</div>
            <div className="text-foreground/90 whitespace-pre-wrap text-xs">{pending.preview}</div>
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => void handleConfirm()}
                disabled={busy}
                className="bg-primary text-primary-foreground inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition hover:opacity-90 disabled:opacity-50"
              >
                <Check className="h-3.5 w-3.5" /> Подтвердить
              </button>
              <button
                type="button"
                onClick={handleCancelAction}
                disabled={busy}
                className="bg-secondary text-foreground hover:bg-muted inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition disabled:opacity-50"
              >
                <Ban className="h-3.5 w-3.5" /> Отмена
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="bg-destructive/10 text-destructive rounded-lg px-3 py-2 text-xs">
            {error}
          </div>
        )}

        {notConfigured && (
          <div className="bg-muted text-muted-foreground rounded-lg px-3 py-2 text-xs">
            LLM не настроен. Добавьте <code>LLM_BASE_URL</code>, <code>LLM_API_KEY</code> и{' '}
            <code>LLM_MODEL</code> в <code>.env</code> API и перезапустите сервер.
          </div>
        )}
      </div>

      {/* Ввод */}
      <div className="shrink-0 border-t p-2">
        {/* Чипы приложенных файлов */}
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachments.map((a, i) => (
              <span
                key={i}
                className="bg-muted text-foreground inline-flex max-w-[14rem] items-center gap-1 rounded-md px-2 py-1 text-xs"
                title={`${a.name} · ${formatSize(a.size)}`}
              >
                <FileText className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{a.name}</span>
                <span className="text-muted-foreground shrink-0">{formatSize(a.size)}</span>
                <button
                  type="button"
                  onClick={() => removeAttachment(i)}
                  className="hover:text-destructive shrink-0"
                  aria-label={`Убрать ${a.name}`}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.docx,.txt,image/*,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="hidden"
            onChange={(e) => void handleFiles(e.target.files)}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy || attachments.length >= MAX_FILES}
            title="Прикрепить документы или фото (PDF, Word, изображения)"
            aria-label="Прикрепить файл"
            className="text-muted-foreground hover:bg-muted hover:text-foreground grid h-9 w-9 shrink-0 place-items-center rounded-md transition disabled:opacity-50"
          >
            <Paperclip className="h-4 w-4" />
          </button>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            rows={1}
            placeholder="Сообщение…  (Enter — отправить)"
            className="bg-background focus:ring-primary/40 max-h-32 min-h-[2.25rem] flex-1 resize-none rounded-md border px-2.5 py-2 text-sm outline-none focus:ring-2"
          />
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={busy || (!input.trim() && attachments.length === 0)}
            className="bg-primary text-primary-foreground grid h-9 w-9 shrink-0 place-items-center rounded-md transition hover:opacity-90 disabled:opacity-50"
            aria-label="Отправить"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
