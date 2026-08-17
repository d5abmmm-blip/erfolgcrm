/**
 * /settings/organization — реквизиты компании, которые печатаются в документах.
 *
 * ЧТО БЫЛО. Наименование, ИНН/КПП, адрес, банк, лицензия и фамилия директора
 * жили зашитой в код константой `lib/pdf/branding.ts`. Колонки в `tenants` под
 * них есть с самого начала, заполнены сидом и не читались никем: сменился банк
 * или директор — правится исходник и пересобирается сайт.
 *
 * Читать реквизиты может вся контора (счета и договоры печатает и менеджер),
 * править — только директор: сервер отдаёт `getOrganization` staffProcedure,
 * а `updateOrganization` — directorProcedure.
 *
 * ПОЧЕМУ ПРОВЕРКИ ДЛИН ЗДЕСЬ, А НЕ ТОЛЬКО НА СЕРВЕРЕ: неверный БИК в счёте — это
 * клиент, который не смог заплатить, и звонок его бухгалтера через неделю.
 * Ошибку надо показать в поле, а не сырым ответом сервера. Границы те же, что в
 * `organizationPatchSchema`.
 */
import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import { Building2, ChevronLeft } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { QueryError } from '../components/QueryError';

type Field =
  | 'displayName'
  | 'legalName'
  | 'slogan'
  | 'inn'
  | 'kpp'
  | 'ogrn'
  | 'legalAddress'
  | 'phone'
  | 'email'
  | 'bankName'
  | 'bankAccount'
  | 'correspondentAccount'
  | 'bik'
  | 'licenseSeries'
  | 'licenseNumber'
  | 'licenseDate'
  | 'licenseAuthority'
  | 'directorName';

type Draft = Partial<Record<Field, string>>;

/** Проверка одного поля. Пусто разрешено везде, кроме короткого названия. */
function validate(field: Field, value: string): string | null {
  const v = value.trim();
  if (field === 'displayName') return v === '' ? 'Название не может быть пустым' : null;
  if (v === '') return null;
  const digitsOnly = /^\d+$/.test(v);
  switch (field) {
    case 'inn':
      return digitsOnly && (v.length === 10 || v.length === 12)
        ? null
        : 'ИНН — 10 цифр у организации или 12 у ИП';
    case 'kpp':
      return digitsOnly && v.length === 9 ? null : 'КПП — 9 цифр';
    case 'ogrn':
      return digitsOnly && (v.length === 13 || v.length === 15)
        ? null
        : 'ОГРН — 13 цифр, ОГРНИП — 15';
    case 'bik':
      return digitsOnly && v.length === 9 ? null : 'БИК — 9 цифр';
    case 'bankAccount':
      return digitsOnly && v.length === 20 ? null : 'Расчётный счёт — 20 цифр';
    case 'correspondentAccount':
      return digitsOnly && v.length === 20 ? null : 'Корреспондентский счёт — 20 цифр';
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : 'Проверьте адрес почты';
    default:
      return null;
  }
}

export function OrganizationSettingsPage() {
  const utils = trpc.useUtils();
  const q = trpc.settings.getOrganization.useQuery();
  const [draft, setDraft] = useState<Draft>({});
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const save = trpc.settings.updateOrganization.useMutation({
    onSuccess: async () => {
      setDraft({});
      setServerError(null);
      setSavedAt(Date.now());
      await utils.settings.getOrganization.invalidate();
    },
    onError: (e) => setServerError(e.message),
  });

  const org = q.data;
  const touched = useMemo(() => Object.keys(draft) as Field[], [draft]);

  const value = (f: Field): string => draft[f] ?? (org ? (org[f] ?? '') : '');

  const onChange = (f: Field, v: string) => {
    setDraft((d) => ({ ...d, [f]: v }));
    setErrors((e) => ({ ...e, [f]: undefined }));
    setSavedAt(null);
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);
    // Проверяем ТОЛЬКО то, что человек трогал: остальное уже лежит в базе, и
    // спотыкаться на чужом старом значении при правке одного поля незачем.
    const next: Partial<Record<Field, string>> = {};
    for (const f of touched) {
      const msg = validate(f, draft[f] ?? '');
      if (msg) next[f] = msg;
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    const patch: Record<string, string> = {};
    for (const f of touched) patch[f] = (draft[f] ?? '').trim();
    save.mutate(patch);
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
      <Link
        href="/settings"
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
      >
        <ChevronLeft className="h-4 w-4" />К настройкам
      </Link>

      <div>
        <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
          <Building2 className="h-3.5 w-3.5" />
          Настройки
        </div>
        <h1 className="mt-0.5 text-xl font-semibold md:text-2xl">Организация</h1>
        <p className="text-muted-foreground text-sm">
          Эти данные печатаются в счетах, договорах и актах. Изменения попадут во все документы,
          которые будут напечатаны после сохранения.
        </p>
      </div>

      {q.error ? (
        <QueryError
          error={q.error}
          paused={q.fetchStatus === 'paused'}
          what="реквизиты организации"
          onRetry={() => void q.refetch()}
        />
      ) : !org ? (
        <div className="text-muted-foreground text-sm">Загрузка…</div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <Card title="Компания">
            <Row label="Короткое название" field="displayName" required>
              <Text f="displayName" value={value} onChange={onChange} error={errors} />
            </Row>
            <Row label="Полное наименование" field="legalName">
              <Text f="legalName" value={value} onChange={onChange} error={errors} />
            </Row>
            <Row label="Подпись под названием" field="slogan">
              <Text f="slogan" value={value} onChange={onChange} error={errors} />
            </Row>
            <Row label="Директор" field="directorName">
              <Text f="directorName" value={value} onChange={onChange} error={errors} />
              <Hint>Кто подписывает документы. Печатается в счёте, договоре и актах.</Hint>
            </Row>
          </Card>

          <Card title="Реквизиты">
            <div className="grid gap-3 sm:grid-cols-2">
              <Row label="ИНН" field="inn">
                <Text f="inn" value={value} onChange={onChange} error={errors} />
              </Row>
              <Row label="КПП" field="kpp">
                <Text f="kpp" value={value} onChange={onChange} error={errors} />
              </Row>
            </div>
            <Row label="ОГРН / ОГРНИП" field="ogrn">
              <Text f="ogrn" value={value} onChange={onChange} error={errors} />
            </Row>
            <Row label="Юридический адрес" field="legalAddress">
              <Text f="legalAddress" value={value} onChange={onChange} error={errors} />
            </Row>
            <div className="grid gap-3 sm:grid-cols-2">
              <Row label="Телефон" field="phone">
                <Text f="phone" value={value} onChange={onChange} error={errors} />
              </Row>
              <Row label="Почта" field="email">
                <Text f="email" value={value} onChange={onChange} error={errors} />
              </Row>
            </div>
          </Card>

          <Card title="Банк">
            <Row label="Банк" field="bankName">
              <Text f="bankName" value={value} onChange={onChange} error={errors} />
            </Row>
            <div className="grid gap-3 sm:grid-cols-2">
              <Row label="Расчётный счёт" field="bankAccount">
                <Text f="bankAccount" value={value} onChange={onChange} error={errors} />
              </Row>
              <Row label="Корреспондентский счёт" field="correspondentAccount">
                <Text f="correspondentAccount" value={value} onChange={onChange} error={errors} />
              </Row>
            </div>
            <Row label="БИК" field="bik">
              <Text f="bik" value={value} onChange={onChange} error={errors} />
            </Row>
          </Card>

          <Card title="Лицензия">
            <div className="grid gap-3 sm:grid-cols-2">
              <Row label="Серия" field="licenseSeries">
                <Text f="licenseSeries" value={value} onChange={onChange} error={errors} />
              </Row>
              <Row label="Номер" field="licenseNumber">
                <Text f="licenseNumber" value={value} onChange={onChange} error={errors} />
              </Row>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Row label="Дата выдачи" field="licenseDate">
                <Text
                  f="licenseDate"
                  type="date"
                  value={value}
                  onChange={onChange}
                  error={errors}
                />
              </Row>
              <Row label="Кем выдана" field="licenseAuthority">
                <Text f="licenseAuthority" value={value} onChange={onChange} error={errors} />
              </Row>
            </div>
          </Card>

          {serverError && (
            <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-md border p-3 text-sm">
              {serverError}
            </div>
          )}

          <div className="flex items-center justify-end gap-3">
            {savedAt !== null && <span className="text-success text-sm">Сохранено</span>}
            {touched.length > 0 && savedAt === null && (
              <span className="text-muted-foreground text-sm">
                Изменено полей: {touched.length}
              </span>
            )}
            <button
              type="submit"
              disabled={touched.length === 0 || save.isPending}
              className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-4 py-2 text-sm font-medium transition disabled:opacity-50"
            >
              {save.isPending ? 'Сохраняем…' : 'Сохранить'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-card space-y-3 rounded-lg border p-4 md:p-6">
      <h2 className="text-sm font-semibold uppercase tracking-wide">{title}</h2>
      {children}
    </section>
  );
}

function Row({
  label,
  field,
  required,
  children,
}: {
  label: string;
  field: Field;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={`org-${field}`} className="text-muted-foreground text-xs font-medium">
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground mt-1 text-xs">{children}</p>;
}

function Text({
  f,
  type,
  value,
  onChange,
  error,
}: {
  f: Field;
  type?: string;
  value: (f: Field) => string;
  onChange: (f: Field, v: string) => void;
  error: Partial<Record<Field, string>>;
}) {
  return (
    <>
      <input
        id={`org-${f}`}
        type={type ?? 'text'}
        value={value(f)}
        onChange={(e) => onChange(f, e.target.value)}
        className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
      />
      {error[f] && <div className="text-destructive mt-1 text-xs">{error[f]}</div>}
    </>
  );
}
