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
import { Bot, Send, X, Loader2, Check, Ban } from 'lucide-react';
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

export function ChatPanel() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const status = trpc.aiAssistant.status.useQuery(undefined, { staleTime: 60_000 });
  const send = trpc.aiAssistant.send.useMutation();
  const busy = send.isPending;
  const notConfigured = status.data?.configured === false;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, pending, busy, open]);

  async function handleSend() {
    const text = input.trim();
    if (!text || busy) return;
    setError(null);
    setPending(null);
    const history: ChatMessage[] = [...messages, { role: 'user', content: text }];
    setMessages(history);
    setInput('');
    try {
      const res = await send.mutateAsync({ messages: history });
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
        <div className="flex items-end gap-2">
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
            disabled={busy || !input.trim()}
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
