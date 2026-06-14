/**
 * /mail — раздел «Почта» в виде почтового клиента (3 панели, как Gmail/webmail):
 *   слева  — рельс папок + «Написать» + «Настройки»;
 *   центр  — список писем выбранной папки (поиск, пагинация);
 *   справа — область чтения выбранного письма (тема/от/кому/дата/тело/вложение + «Ответить»).
 *
 * RBAC: staff. Настройки ящика — только директор. Письма живут на ящике reg.ru;
 * «Входящие» наполнятся после подключения приёма по IMAP (Этап B) — папка уже готова.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import {
  ChevronLeft,
  File as FileIcon,
  Forward,
  Inbox,
  Info,
  Loader2,
  Mail,
  Paperclip,
  RefreshCw,
  Reply,
  Search,
  Send,
  Settings,
  ShieldAlert,
} from 'lucide-react';
import { trpc } from '../lib/trpc';
import type { RouterOutputs } from '../lib/trpc-types';
import { useDebounce } from '../lib/hooks/useDebounce';
import { cn } from '../lib/utils';
import { StatusBadge, type StatusBadgeVariant } from '../components/ui/StatusBadge';
import { Pagination } from '../components/ui/Pagination';
import { ComposeEmailModal } from '../components/ComposeEmailModal';
import {
  buildForwardBody,
  buildReferences,
  buildReplyBody,
  forwardSubject,
  replySubject,
} from '../lib/mail-quote';

/** Письмо треда (полное письмо + вложения) — элемент вывода `email.thread`. */
type ThreadMessage = RouterOutputs['email']['thread'][number];
/** Вложение письма (готовая presigned-ссылка). */
type MailAttachment = ThreadMessage['attachments'][number];

const PAGE_SIZE = 25;

/** Папка интерфейса. Маппится в параметры `email.list` (direction + spam). */
type Folder = 'in' | 'out' | 'spam';

const FOLDER_QUERY: Record<Folder, { direction: 'in' | 'out'; spam?: boolean }> = {
  in: { direction: 'in', spam: false },
  out: { direction: 'out' },
  spam: { direction: 'in', spam: true },
};

const FOLDER_TITLE: Record<Folder, string> = {
  in: 'Входящие',
  out: 'Отправленные',
  spam: 'Спам',
};

const FOLDER_EMPTY: Record<Folder, string> = {
  in: 'Входящих писем пока нет',
  out: 'Отправленных писем пока нет',
  spam: 'Спама нет',
};

const STATUS_META: Record<string, { label: string; variant: StatusBadgeVariant }> = {
  sent: { label: 'Отправлено', variant: 'success' },
  skipped: { label: 'Пропущено', variant: 'muted' },
  failed: { label: 'Ошибка', variant: 'danger' },
  received: { label: 'Входящее', variant: 'info' },
};

function fmtDate(d: Date | string | null): string {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return String(d);
  return date.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}

function fmtSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

interface ComposeInit {
  to?: string;
  subject?: string;
  body?: string;
  relatedTicketId?: string;
  relatedClientId?: string;
  inReplyTo?: string;
  references?: string[];
  title?: string;
}

export function MailListPage() {
  const me = trpc.auth.me.useQuery(undefined, { staleTime: 60_000 });
  const isDirector = me.data?.user.role === 'director';

  const [folder, setFolder] = useState<Folder>('in');
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search.trim(), 300);
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeInit, setComposeInit] = useState<ComposeInit>({});

  const folderQuery = FOLDER_QUERY[folder];
  const list = trpc.email.list.useQuery({
    search: debounced || undefined,
    page,
    pageSize: PAGE_SIZE,
    direction: folderQuery.direction,
    ...(folderQuery.spam !== undefined ? { spam: folderQuery.spam } : {}),
  });
  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;

  const unread = trpc.email.unreadCount.useQuery(undefined, { staleTime: 30_000 });
  const unreadCount = unread.data ?? 0;

  const utils = trpc.useUtils();
  const fetchNow = trpc.email.fetchNow.useMutation({
    onSuccess: async () => {
      await utils.email.list.invalidate();
      await utils.email.unreadCount.invalidate();
    },
  });

  const switchFolder = (f: Folder) => {
    setFolder(f);
    setPage(1);
    setSearch('');
    setSelectedId(null);
  };

  const openCompose = (init: ComposeInit = {}) => {
    setComposeInit(init);
    setComposeOpen(true);
  };

  return (
    <div className="flex h-full min-h-0">
      {/* ── Левый рельс: папки ── */}
      <aside className="bg-card/40 hidden w-56 shrink-0 flex-col border-r p-3 md:flex">
        <div className="mb-3 flex items-center gap-2 px-1">
          <Mail className="text-primary h-5 w-5" />
          <span className="font-semibold">Почта</span>
        </div>
        <button
          type="button"
          onClick={() => openCompose()}
          className="bg-primary text-primary-foreground hover:bg-primary/90 mb-3 inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium shadow-sm transition"
        >
          <Send className="h-4 w-4" />
          Написать
        </button>
        <nav className="space-y-0.5">
          <RailItem
            icon={Inbox}
            label="Входящие"
            active={folder === 'in'}
            onClick={() => switchFolder('in')}
            badge={unreadCount}
          />
          <RailItem icon={Send} label="Отправленные" active={folder === 'out'} onClick={() => switchFolder('out')} />
          <RailItem icon={ShieldAlert} label="Спам" active={folder === 'spam'} onClick={() => switchFolder('spam')} />
        </nav>
        {isDirector && (
          <div className="border-sidebar-border mt-auto border-t pt-2">
            <Link
              href="/settings/email"
              className="text-muted-foreground hover:bg-muted hover:text-foreground flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition"
            >
              <Settings className="h-4 w-4" />
              Настройки почты
            </Link>
          </div>
        )}
      </aside>

      {/* ── Центр: список писем ── */}
      <div
        className={cn(
          'flex w-full min-h-0 flex-col border-r md:w-80 lg:w-96',
          selectedId && 'hidden md:flex',
        )}
      >
        {/* Заголовок + мобильное переключение папок */}
        <div className="space-y-2 border-b p-3">
          <div className="flex items-center justify-between gap-2 md:hidden">
            <div className="bg-secondary inline-flex rounded-md p-0.5">
              <MiniFolder label="Входящие" active={folder === 'in'} onClick={() => switchFolder('in')} badge={unreadCount} />
              <MiniFolder label="Отправленные" active={folder === 'out'} onClick={() => switchFolder('out')} />
              <MiniFolder label="Спам" active={folder === 'spam'} onClick={() => switchFolder('spam')} />
            </div>
            <button
              type="button"
              onClick={() => openCompose()}
              className="bg-primary text-primary-foreground inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium"
            >
              <Send className="h-3.5 w-3.5" />
              Написать
            </button>
          </div>
          <div className="hidden items-baseline justify-between md:flex">
            <h2 className="text-sm font-semibold">{FOLDER_TITLE[folder]}</h2>
            <span className="text-muted-foreground text-xs">{total}</span>
          </div>
          <div className="relative">
            <Search className="text-muted-foreground absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2" />
            <input
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Поиск по теме или адресу"
              className="bg-background focus:ring-primary/40 w-full rounded-md border py-1.5 pl-8 pr-3 text-sm outline-none focus:ring-2"
            />
          </div>
        </div>

        {folderQuery.direction === 'in' && (
          <div className="bg-primary/5 space-y-1.5 border-b border-primary/10 p-3 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground flex items-start gap-2">
                <Info className="text-primary mt-0.5 h-3.5 w-3.5 shrink-0" />
                Письма приходят на ящик компании. Проверьте вручную или дождитесь авто-проверки.
              </span>
              <button
                type="button"
                onClick={() => fetchNow.mutate()}
                disabled={fetchNow.isPending}
                className="hover:bg-muted inline-flex shrink-0 items-center gap-1.5 rounded-md border bg-background px-2.5 py-1.5 font-medium transition disabled:opacity-50"
              >
                {fetchNow.isPending ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                Проверить почту
              </button>
            </div>
            {fetchNow.data && (
              <div className="text-muted-foreground pl-5">
                {fetchNow.data.skipped
                  ? 'IMAP не настроен — заполните логин/пароль и сервер в настройках почты.'
                  : fetchNow.data.fetched > 0
                    ? `Получено новых писем: ${fetchNow.data.fetched}`
                    : 'Новых писем нет.'}
              </div>
            )}
            {fetchNow.error && (
              <div className="text-destructive pl-5">Ошибка: {fetchNow.error.message}</div>
            )}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto">
          {list.isLoading ? (
            <div className="text-muted-foreground p-6 text-center text-sm">Загрузка…</div>
          ) : list.error ? (
            <div className="text-destructive p-4 text-sm">Ошибка: {list.error.message}</div>
          ) : items.length === 0 ? (
            <div className="text-muted-foreground p-6 text-center text-sm">{FOLDER_EMPTY[folder]}</div>
          ) : (
            <ul className="divide-y">
              {items.map((m) => {
                const meta = STATUS_META[m.status] ?? { label: m.status, variant: 'muted' as const };
                const active = m.id === selectedId;
                const inbound = folderQuery.direction === 'in';
                // Жирным — непрочитанные входящие (исходящие «прочитанности» не имеют).
                const unreadRow = inbound && !m.isRead;
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(m.id)}
                      className={cn(
                        'flex w-full flex-col gap-0.5 px-3 py-2.5 text-left transition',
                        active ? 'bg-primary/10' : 'hover:bg-muted/40',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className={cn('truncate text-sm', unreadRow ? 'font-semibold' : 'font-medium')}
                        >
                          {(inbound ? m.from : m.to) ?? <span className="text-muted-foreground">—</span>}
                        </span>
                        <span className="text-muted-foreground shrink-0 text-[11px]">
                          {fmtDate(m.createdAt)}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {m.hasAttachments && (
                          <Paperclip className="text-muted-foreground h-3 w-3 shrink-0" />
                        )}
                        <span
                          className={cn(
                            'truncate text-xs',
                            unreadRow ? 'text-foreground font-medium' : 'text-muted-foreground',
                          )}
                        >
                          {m.subject ?? '(без темы)'}
                        </span>
                      </div>
                      <StatusBadge variant={meta.variant} compact>
                        {meta.label}
                      </StatusBadge>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="border-t p-2">
          <Pagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} />
        </div>
      </div>

      {/* ── Справа: чтение письма ── */}
      <div className={cn('min-h-0 flex-1 flex-col', selectedId ? 'flex' : 'hidden md:flex')}>
        {selectedId ? (
          <MessageReader
            key={selectedId}
            id={selectedId}
            onBack={() => setSelectedId(null)}
            onReply={(init) => openCompose(init)}
          />
        ) : (
          <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm">
            <Mail className="h-8 w-8 opacity-40" />
            Выберите письмо слева, чтобы прочитать
          </div>
        )}
      </div>

      <ComposeEmailModal
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        initialTo={composeInit.to}
        initialSubject={composeInit.subject}
        initialBody={composeInit.body}
        relatedTicketId={composeInit.relatedTicketId}
        relatedClientId={composeInit.relatedClientId}
        inReplyTo={composeInit.inReplyTo}
        references={composeInit.references}
        title={composeInit.title}
        templateVars={{ company: me.data?.tenant.displayName }}
      />
    </div>
  );
}

function RailItem({
  icon: Icon,
  label,
  active,
  onClick,
  badge,
}: {
  icon: typeof Inbox;
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition',
        active
          ? 'bg-primary/15 text-primary font-medium'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
      aria-pressed={active}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="flex-1 text-left">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="bg-primary text-primary-foreground inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums">
          {badge}
        </span>
      )}
    </button>
  );
}

function MiniFolder({
  label,
  active,
  onClick,
  badge,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium transition',
        active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground',
      )}
      aria-pressed={active}
    >
      {label}
      {badge !== undefined && badge > 0 && (
        <span className="bg-primary text-primary-foreground inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums">
          {badge}
        </span>
      )}
    </button>
  );
}

/**
 * Область чтения = вид треда. Тянем всю переписку через `email.thread` и рисуем
 * вертикальный стек карточек (старые → новые). Кнопки «Ответить»/«Переслать» действуют
 * на выбранное (последнее в треде) письмо. При открытии непрочитанного входящего —
 * один раз помечаем прочитанным и обновляем бейдж/список.
 */
function MessageReader({
  id,
  onBack,
  onReply,
}: {
  id: string;
  onBack: () => void;
  onReply: (init: ComposeInit) => void;
}) {
  const thread = trpc.email.thread.useQuery({ messageId: id });
  const utils = trpc.useUtils();
  const markRead = trpc.email.markRead.useMutation({
    onSuccess: async () => {
      await utils.email.unreadCount.invalidate();
      await utils.email.list.invalidate();
    },
  });

  const messages = thread.data ?? [];
  // Выбранное письмо в треде (на нём действуют «Ответить»/«Переслать»); фолбэк — последнее.
  const selected = messages.find((m) => m.id === id) ?? messages[messages.length - 1];

  // Один раз помечаем выбранное непрочитанное входящее прочитанным.
  const markedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selected) return;
    if (selected.direction === 'in' && !selected.isRead && markedRef.current !== selected.id) {
      markedRef.current = selected.id;
      markRead.mutate({ id: selected.id });
    }
  }, [selected, markRead]);

  if (thread.isLoading) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Загрузка переписки…
      </div>
    );
  }
  if (thread.error || !selected) {
    return (
      <div className="text-destructive p-6 text-sm">
        {thread.error?.message ?? 'Письмо не найдено'}
      </div>
    );
  }

  const subject = selected.subject;
  const selInbound = selected.direction === 'in';
  const replyTo = selInbound ? selected.from : selected.to;
  const replyDate = selected.sentAt ?? selected.receivedAt ?? selected.createdAt;

  const onReplyClick = () =>
    onReply({
      title: 'Ответить',
      to: replyTo ?? undefined,
      subject: replySubject(subject),
      body: buildReplyBody({ from: selected.from, date: replyDate, bodyText: selected.bodyText }),
      inReplyTo: selected.messageId ?? undefined,
      references: buildReferences(selected.references, selected.messageId),
      relatedTicketId: selected.relatedTicketId ?? undefined,
      relatedClientId: selected.relatedClientId ?? undefined,
    });

  const onForwardClick = () =>
    onReply({
      title: 'Переслать',
      to: '',
      subject: forwardSubject(subject),
      body: buildForwardBody({
        from: selected.from,
        to: selected.to,
        date: replyDate,
        subject,
        bodyText: selected.bodyText,
      }),
      // Пересылка начинает новый тред — без In-Reply-To/References.
      relatedTicketId: selected.relatedTicketId ?? undefined,
      relatedClientId: selected.relatedClientId ?? undefined,
    });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b p-3">
        <button
          type="button"
          onClick={onBack}
          className="text-muted-foreground hover:bg-muted hover:text-foreground grid h-7 w-7 place-items-center rounded transition md:hidden"
          aria-label="Назад к списку"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <h2 className="flex-1 truncate text-base font-semibold">{subject ?? '(без темы)'}</h2>
        <button
          type="button"
          onClick={onReplyClick}
          className="hover:bg-muted inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition"
        >
          <Reply className="h-3.5 w-3.5" />
          Ответить
        </button>
        <button
          type="button"
          onClick={onForwardClick}
          className="hover:bg-muted inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition"
        >
          <Forward className="h-3.5 w-3.5" />
          Переслать
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4 md:p-6">
        {messages.map((m) => (
          <ThreadCard key={m.id} m={m} highlighted={m.id === id} multi={messages.length > 1} />
        ))}
      </div>
    </div>
  );
}

/** Карточка одного письма в треде. Входящие — слева с акцентом, исходящие — со сдвигом. */
function ThreadCard({
  m,
  highlighted,
  multi,
}: {
  m: ThreadMessage;
  highlighted: boolean;
  multi: boolean;
}) {
  const meta = STATUS_META[m.status] ?? { label: m.status, variant: 'muted' as const };
  const inbound = m.direction === 'in';
  const hasText = Boolean(m.bodyText?.trim());

  return (
    <div
      className={cn(
        'rounded-lg border p-3 md:p-4',
        // Входящие — акцент слева, исходящие — мягкий фон и сдвиг вправо в многосообщенческом треде.
        inbound ? 'border-l-primary/60 border-l-2' : 'bg-muted/20',
        multi && !inbound && 'md:ml-8',
        highlighted && 'ring-primary/40 ring-2',
      )}
    >
      <div className="mb-3 space-y-1 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge variant={meta.variant}>{meta.label}</StatusBadge>
          <span className="text-muted-foreground text-xs">
            {fmtDate(m.sentAt ?? m.receivedAt ?? m.createdAt)}
          </span>
        </div>
        {m.from && (
          <div>
            <span className="text-muted-foreground">От:</span> {m.from}
          </div>
        )}
        <div>
          <span className="text-muted-foreground">Кому:</span> {m.to ?? '—'}
        </div>
        {m.error && <div className="text-destructive text-xs">Ошибка отправки: {m.error}</div>}
      </div>

      <div className="whitespace-pre-wrap text-sm leading-relaxed">
        {hasText ? (
          m.bodyText
        ) : m.bodyHtml ? (
          // SECURITY: входящий HTML НЕ рендерим как разметку (XSS). Показываем только пометку.
          // TODO: sanitized HTML rendering
          <span className="text-muted-foreground italic">(письмо в HTML-формате)</span>
        ) : (
          <span className="text-muted-foreground">(письмо без текста)</span>
        )}
      </div>

      <MailAttachments items={m.attachments} />
    </div>
  );
}

/** Вложения письма — чипы-ссылки на скачивание в стиле PhotoUploader/ThumbCard. */
function MailAttachments({ items }: { items: MailAttachment[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
      {items.map((a) => {
        const isImg = a.mimeType.startsWith('image/');
        const size = fmtSize(a.sizeBytes);
        return (
          <a
            key={a.id}
            href={a.url}
            target="_blank"
            rel="noreferrer noopener"
            title={a.name}
            className="bg-card group relative block overflow-hidden rounded-md border"
          >
            <div className="aspect-square">
              {isImg ? (
                <img src={a.url} alt={a.name} className="h-full w-full object-cover" loading="lazy" />
              ) : (
                <div className="text-muted-foreground flex h-full w-full flex-col items-center justify-center gap-1 p-2 text-center text-xs">
                  <FileIcon className="h-6 w-6" />
                  <div className="line-clamp-2 break-words">{a.name}</div>
                </div>
              )}
            </div>
            <div className="from-background/90 pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t p-1.5 text-[10px]">
              <div className="line-clamp-1 break-all font-medium">{a.name}</div>
              {size && <div className="text-muted-foreground tabular-nums">{size}</div>}
            </div>
          </a>
        );
      })}
    </div>
  );
}
