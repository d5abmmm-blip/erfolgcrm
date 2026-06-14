/**
 * Модалка «Написать письмо». Используется на странице /mail и на карточках заявки/клиента.
 *
 * Вложения генерируются лениво на клиенте (PDF из lib/pdf) только при отправке — родитель
 * передаёт attachmentOptions с build(): тяжёлый pdfmake не тянется, пока пользователь не выберет.
 * Base64 уходит на сервер вместе с письмом (trpc.email.send), сервер пишет журнал.
 */
import { useEffect, useState } from 'react';
import { Loader2, Paperclip, Send, X } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { MAIL_TEMPLATES, applyTemplate } from '../lib/mail-templates';

export interface AttachmentOption {
  id: string;
  label: string;
  /** Тип документа для журнала ('invoice'|'work_act'|...). */
  kind: string;
  /** Лениво строит вложение (PDF → base64 без data:-префикса). */
  build: () => Promise<{ filename: string; base64: string }>;
}

interface ComposeEmailModalProps {
  open: boolean;
  onClose: () => void;
  initialTo?: string;
  initialSubject?: string;
  initialBody?: string;
  relatedTicketId?: string;
  relatedClientId?: string;
  /** Заголовок модалки (для «Ответить»/«Переслать»). По умолчанию — «Новое письмо». */
  title?: string;
  /** Тред-заголовки для ответа (In-Reply-To / References). Только при ответе. */
  inReplyTo?: string;
  references?: string[];
  /** Значения для подстановки в шаблоны ({{clientName}}, {{ticketNumber}}, ...). */
  templateVars?: Record<string, string | undefined>;
  attachmentOptions?: AttachmentOption[];
  onSent?: () => void;
}

export function ComposeEmailModal({
  open,
  onClose,
  initialTo = '',
  initialSubject = '',
  initialBody = '',
  relatedTicketId,
  relatedClientId,
  title = 'Новое письмо',
  inReplyTo,
  references,
  templateVars,
  attachmentOptions = [],
  onSent,
}: ComposeEmailModalProps) {
  const utils = trpc.useUtils();
  const [to, setTo] = useState(initialTo);
  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState(initialBody);
  const [attachmentId, setAttachmentId] = useState('');
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Пересинхронизируем поля при каждом открытии (родитель меняет initial*).
  useEffect(() => {
    if (open) {
      setTo(initialTo);
      setSubject(initialSubject);
      setBody(initialBody);
      setAttachmentId('');
      setError(null);
    }
  }, [open, initialTo, initialSubject, initialBody]);

  // Esc — закрыть.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const send = trpc.email.send.useMutation({
    onSuccess: async () => {
      await utils.email.list.invalidate();
      // Ответ помечает родителя прочитанным на сервере — обновим счётчик непрочитанных.
      await utils.email.unreadCount.invalidate();
      onSent?.();
      onClose();
    },
    onError: (e) => setError(e.message),
  });

  if (!open) return null;

  const applyTpl = (tplId: string) => {
    const tpl = MAIL_TEMPLATES.find((t) => t.id === tplId);
    if (!tpl) return;
    setSubject(applyTemplate(tpl.subject, templateVars ?? {}));
    setBody(applyTemplate(tpl.body, templateVars ?? {}));
  };

  const submit = async () => {
    setError(null);
    let attachment: { filename: string; base64: string; kind: string } | undefined;
    if (attachmentId) {
      const opt = attachmentOptions.find((a) => a.id === attachmentId);
      if (opt) {
        setBuilding(true);
        try {
          const built = await opt.build();
          attachment = { filename: built.filename, base64: built.base64, kind: opt.kind };
        } catch {
          setError('Не удалось сформировать вложение. Попробуйте ещё раз.');
          setBuilding(false);
          return;
        }
        setBuilding(false);
      }
    }
    send.mutate({
      to: to.trim(),
      subject: subject.trim(),
      bodyText: body,
      relatedTicketId,
      relatedClientId,
      attachment,
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(references && references.length > 0 ? { references } : {}),
    });
  };

  const busy = building || send.isPending;
  const canSend = to.trim().length > 0 && subject.trim().length > 0 && body.trim().length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="bg-card max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="flex items-center justify-between border-b px-5 py-3">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Send className="text-primary h-4 w-4" />
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:bg-muted hover:text-foreground grid h-7 w-7 place-items-center rounded transition"
            aria-label="Закрыть"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 p-5">
          {MAIL_TEMPLATES.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground text-xs">Шаблон:</span>
              {MAIL_TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => applyTpl(t.id)}
                  className="hover:bg-muted rounded-md border px-2.5 py-1 text-xs transition"
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}

          <label className="block">
            <span className="text-xs font-medium">Кому</span>
            <input
              type="email"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="client@example.com"
              className="bg-background focus:ring-primary/40 mt-1 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium">Тема</span>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="bg-background focus:ring-primary/40 mt-1 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium">Текст письма</span>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={10}
              className="bg-background focus:ring-primary/40 mt-1 w-full resize-y rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
          </label>

          {attachmentOptions.length > 0 && (
            <label className="block">
              <span className="flex items-center gap-1.5 text-xs font-medium">
                <Paperclip className="h-3.5 w-3.5" />
                Вложение
              </span>
              <select
                value={attachmentId}
                onChange={(e) => setAttachmentId(e.target.value)}
                className="bg-background focus:ring-primary/40 mt-1 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
              >
                <option value="">Без вложения</option>
                {attachmentOptions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          {error && <div className="text-destructive text-sm">{error}</div>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="hover:bg-muted rounded-md border px-4 py-2 text-sm font-medium"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSend || busy}
            className={cn(
              'bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium transition disabled:opacity-50',
            )}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {building ? 'Формируем вложение…' : send.isPending ? 'Отправляем…' : 'Отправить'}
          </button>
        </div>
      </div>
    </div>
  );
}
