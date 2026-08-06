/**
 * Модалка «Написать письмо». Используется на странице /mail и на карточках заявки/клиента.
 *
 * Вложения генерируются лениво на клиенте (PDF из lib/pdf) только при отправке — родитель
 * передаёт attachmentOptions с build(): тяжёлый pdfmake не тянется, пока пользователь не выберет.
 * Base64 уходит на сервер вместе с письмом (trpc.email.send), сервер пишет журнал.
 */
import { useEffect, useRef, useState } from 'react';
import { Clock, FileText, Loader2, Paperclip, Send, X } from 'lucide-react';
import { trpc } from '../lib/trpc';
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
  /** id черновика для редактирования: сохранение/отправка обновят ту же строку. */
  draftId?: string;
  /** Предзаполненные копия / скрытая копия (при правке черновика/запланированного). */
  initialCc?: string;
  initialBcc?: string;
  /** Предзаполненное время отложенной отправки (datetime-local) — при правке запланированного. */
  initialScheduledAt?: string;
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
  draftId,
  initialCc,
  initialBcc,
  initialScheduledAt,
  templateVars,
  attachmentOptions = [],
  onSent,
}: ComposeEmailModalProps) {
  const utils = trpc.useUtils();
  const rootRef = useRef<HTMLDivElement>(null);
  const [to, setTo] = useState(initialTo);
  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState(initialBody);
  const [attachmentId, setAttachmentId] = useState('');
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // id текущего черновика: при «Сохранить черновик»/отправке обновляем ту же строку.
  const [currentDraftId, setCurrentDraftId] = useState<string | undefined>(draftId);
  // Копия / скрытая копия (поля скрыты, пока не понадобятся).
  const [cc, setCc] = useState(initialCc ?? '');
  const [bcc, setBcc] = useState(initialBcc ?? '');
  const [showCc, setShowCc] = useState(Boolean(initialCc || initialBcc));
  // Отложенная отправка: время (datetime-local) и показ блока выбора.
  const [scheduleAt, setScheduleAt] = useState(initialScheduledAt ?? '');
  const [showSchedule, setShowSchedule] = useState(Boolean(initialScheduledAt));
  // Подпись компании (для подсказки — добавляется на сервере при отправке).
  const signature = trpc.email.getSignature.useQuery(undefined, { staleTime: 300_000 });

  // Пересинхронизируем поля при каждом открытии (родитель меняет initial*).
  useEffect(() => {
    if (open) {
      setTo(initialTo);
      setSubject(initialSubject);
      setBody(initialBody);
      setAttachmentId('');
      setError(null);
      setCurrentDraftId(draftId);
      setCc(initialCc ?? '');
      setBcc(initialBcc ?? '');
      setShowCc(Boolean(initialCc || initialBcc));
      setScheduleAt(initialScheduledAt ?? '');
      setShowSchedule(Boolean(initialScheduledAt));
    }
  }, [
    open,
    initialTo,
    initialSubject,
    initialBody,
    draftId,
    initialCc,
    initialBcc,
    initialScheduledAt,
  ]);

  // Esc — закрыть; Tab — фокус-ловушка внутри модалки (WAI-ARIA), фокус на первое поле.
  useEffect(() => {
    if (!open) return;
    rootRef.current?.querySelector<HTMLElement>('input, textarea, select')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'Tab' && rootRef.current) {
        const focusables = rootRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input, textarea, select, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !rootRef.current.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !rootRef.current.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }
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

  const saveDraft = trpc.email.saveDraft.useMutation({
    onSuccess: async (res) => {
      setCurrentDraftId(res.id);
      await utils.email.list.invalidate();
      onSent?.();
      onClose();
    },
    onError: (e) => setError(e.message),
  });

  const scheduleSend = trpc.email.schedule.useMutation({
    onSuccess: async () => {
      await utils.email.list.invalidate();
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
      ...(cc.trim() ? { cc: cc.trim() } : {}),
      ...(bcc.trim() ? { bcc: bcc.trim() } : {}),
      subject: subject.trim(),
      bodyText: body,
      relatedTicketId,
      relatedClientId,
      attachment,
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(references && references.length > 0 ? { references } : {}),
      ...(currentDraftId ? { fromDraftId: currentDraftId } : {}),
    });
  };

  const saveDraftNow = () => {
    setError(null);
    saveDraft.mutate({
      id: currentDraftId,
      to: to.trim() || undefined,
      cc: cc.trim() || undefined,
      bcc: bcc.trim() || undefined,
      subject: subject.trim() || undefined,
      bodyText: body || undefined,
      relatedTicketId,
      relatedClientId,
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(references && references.length > 0 ? { references } : {}),
    });
  };

  const submitSchedule = () => {
    setError(null);
    if (!scheduleAt) {
      setError('Укажите дату и время отправки.');
      return;
    }
    const when = new Date(scheduleAt);
    if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now() + 60_000) {
      setError('Время отправки должно быть в будущем (хотя бы через минуту).');
      return;
    }
    scheduleSend.mutate({
      to: to.trim(),
      ...(cc.trim() ? { cc: cc.trim() } : {}),
      ...(bcc.trim() ? { bcc: bcc.trim() } : {}),
      subject: subject.trim(),
      bodyText: body,
      scheduledAt: when,
      relatedTicketId,
      relatedClientId,
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(references && references.length > 0 ? { references } : {}),
      ...(currentDraftId ? { fromDraftId: currentDraftId } : {}),
    });
  };

  const busy = building || send.isPending || saveDraft.isPending || scheduleSend.isPending;
  const canSend = to.trim().length > 0 && subject.trim().length > 0 && body.trim().length > 0;
  const canSaveDraft = to.trim().length > 0 || subject.trim().length > 0 || body.trim().length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={rootRef}
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

          <div>
            <div className="flex items-center justify-between">
              <label htmlFor="compose-to" className="text-xs font-medium">
                Кому
              </label>
              {!showCc && (
                <button
                  type="button"
                  onClick={() => setShowCc(true)}
                  className="text-muted-foreground hover:text-foreground text-xs"
                >
                  Копия / Скрытая
                </button>
              )}
            </div>
            <input
              id="compose-to"
              type="email"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="client@example.com"
              className="bg-background focus:ring-primary/40 mt-1 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
          </div>

          {showCc && (
            <>
              <label className="block">
                <span className="text-xs font-medium">Копия (Cc)</span>
                <input
                  type="text"
                  value={cc}
                  onChange={(e) => setCc(e.target.value)}
                  placeholder="несколько адресов через запятую"
                  className="bg-background focus:ring-primary/40 mt-1 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium">Скрытая копия (Bcc)</span>
                <input
                  type="text"
                  value={bcc}
                  onChange={(e) => setBcc(e.target.value)}
                  placeholder="несколько адресов через запятую"
                  className="bg-background focus:ring-primary/40 mt-1 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
                />
              </label>
            </>
          )}

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

          {signature.data && signature.data.trim() && (
            <p className="text-muted-foreground text-xs">
              К письму автоматически добавится подпись компании.
            </p>
          )}

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

          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setShowSchedule((v) => !v)}
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-xs font-medium"
            >
              <Clock className="h-3.5 w-3.5" />
              {showSchedule ? 'Отправить сразу' : 'Отправить позже'}
            </button>
            {showSchedule && (
              <input
                type="datetime-local"
                value={scheduleAt}
                onChange={(e) => setScheduleAt(e.target.value)}
                className="bg-background focus:ring-primary/40 block w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
              />
            )}
          </div>

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
            onClick={saveDraftNow}
            disabled={!canSaveDraft || busy}
            className="hover:bg-muted inline-flex items-center gap-1.5 rounded-md border px-4 py-2 text-sm font-medium transition disabled:opacity-50"
          >
            {saveDraft.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FileText className="h-4 w-4" />
            )}
            Сохранить черновик
          </button>
          {showSchedule ? (
            <button
              type="button"
              onClick={submitSchedule}
              disabled={!canSend || busy}
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium transition disabled:opacity-50"
            >
              {scheduleSend.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Clock className="h-4 w-4" />
              )}
              Запланировать
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canSend || busy}
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium transition disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {building ? 'Формируем вложение…' : send.isPending ? 'Отправляем…' : 'Отправить'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
