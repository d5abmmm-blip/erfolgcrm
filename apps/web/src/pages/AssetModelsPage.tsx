import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { BookMarked, ChevronLeft, Plus, Search } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { useDebounce } from '../lib/hooks/useDebounce';
import { listEmptyText } from '../lib/empty-text';
import { DataTable, type Column } from '../components/ui/DataTable';
import { Pagination } from '../components/ui/Pagination';
import { mergeDeviceTypeSuggestions } from '../lib/device-types';

type RiskClass = '1' | '2a' | '2b' | '3';

interface ModelRow {
  id: string;
  manufacturer: string | null;
  deviceType: string | null;
  model: string;
  riskClass: RiskClass | null;
  requiredAttestationCategory: string | null;
  notes: string | null;
}

const PAGE_SIZE = 25;

const RISK_LABEL: Record<RiskClass, string> = {
  '1': '1',
  '2a': '2а',
  '2b': '2б',
  '3': '3',
};

export function AssetModelsPage() {
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search.trim(), 300);
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<ModelRow | 'new' | null>(null);

  const list = trpc.assetModels.list.useQuery({
    search: debounced || undefined,
    page,
  });

  const items = (list.data?.items ?? []) as ModelRow[];
  const total = list.data?.total ?? 0;

  const columns: Column<ModelRow>[] = [
    {
      key: 'model',
      label: 'Модель',
      render: (m) => (
        <div>
          <div className="text-foreground font-medium">{m.model}</div>
          {m.deviceType && <div className="text-muted-foreground text-xs">{m.deviceType}</div>}
          {m.manufacturer && <div className="text-muted-foreground text-xs">{m.manufacturer}</div>}
        </div>
      ),
    },
    {
      key: 'riskClass',
      label: 'Класс риска',
      className: 'text-center font-mono',
      headerClassName: 'text-center',
      render: (m) => (m.riskClass ? RISK_LABEL[m.riskClass] : '—'),
    },
    {
      key: 'attestation',
      label: 'Аттестация инженеров',
      render: (m) =>
        m.requiredAttestationCategory ?? (
          <span className="text-muted-foreground">не требуется</span>
        ),
    },
  ];

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
      <Link
        href="/assets"
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
      >
        <ChevronLeft className="h-4 w-4" />К парку техники
      </Link>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
            <BookMarked className="h-3.5 w-3.5" />
            Справочник
          </div>
          <h1 className="mt-0.5 text-xl font-semibold md:text-2xl">Каталог моделей техники</h1>
          <p className="text-muted-foreground text-sm">
            Типы аппаратов (производитель + модель), не привязанные к клиенту. Заполняются один раз
            и переиспользуются при заведении техники и создании заявок.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setEditing('new')}
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition"
        >
          <Plus className="h-4 w-4" />
          Добавить модель
        </button>
      </div>

      <div className="relative max-w-md">
        <Search className="text-muted-foreground absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2" />
        <input
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          placeholder="Поиск по модели или производителю"
          className="bg-background focus:ring-primary/40 w-full rounded-md border py-2 pl-8 pr-3 text-sm outline-none focus:ring-2"
        />
      </div>

      <DataTable
        data={items}
        columns={columns}
        loading={list.isLoading}
        error={list.error ? { message: list.error.message } : null}
        emptyText={listEmptyText(!!debounced, 'Моделей пока нет — добавьте первую')}
        rowKey={(m) => m.id}
        onRowClick={(m) => setEditing(m)}
      />

      <Pagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} />

      {editing && (
        <AssetModelModal
          model={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function AssetModelModal({ model, onClose }: { model: ModelRow | null; onClose: () => void }) {
  const utils = trpc.useUtils();
  const rootRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  const isEdit = !!model;

  const [manufacturer, setManufacturer] = useState(model?.manufacturer ?? '');
  const [deviceType, setDeviceType] = useState(model?.deviceType ?? '');
  const [modelName, setModelName] = useState(model?.model ?? '');
  const [riskClass, setRiskClass] = useState<'' | RiskClass>(model?.riskClass ?? '');
  const [attestation, setAttestation] = useState(model?.requiredAttestationCategory ?? '');
  const [notes, setNotes] = useState(model?.notes ?? '');
  const [error, setError] = useState<string | null>(null);

  const cats = trpc.attestations.categories.useQuery();
  const deviceTypes = trpc.assets.deviceTypes.useQuery();
  const deviceTypeOptions = mergeDeviceTypeSuggestions(deviceTypes.data);

  const onDone = async () => {
    await utils.assetModels.list.invalidate();
    await utils.assetModels.search.invalidate();
    if (model) await utils.assetModels.get.invalidate({ id: model.id });
    onClose();
  };

  const create = trpc.assetModels.create.useMutation({
    onSuccess: onDone,
    onError: (e) => setError(e.message),
  });
  const update = trpc.assetModels.update.useMutation({
    onSuccess: onDone,
    onError: (e) => setError(e.message),
  });

  useEffect(() => {
    firstRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pending = create.isPending || update.isPending;

  function submit() {
    setError(null);
    if (!modelName.trim()) {
      setError('Укажите название модели');
      return;
    }
    const payload = {
      manufacturer: manufacturer.trim() || null,
      deviceType: deviceType.trim() || null,
      model: modelName.trim(),
      riskClass: riskClass || null,
      requiredAttestationCategory: attestation.trim() || null,
      notes: notes.trim() || null,
    };
    if (isEdit && model) {
      update.mutate({ id: model.id, patch: payload });
    } else {
      create.mutate(payload);
    }
  }

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="asset-model-title"
      className="fixed inset-0 z-50 flex items-center justify-center"
    >
      <button
        type="button"
        aria-label="Закрыть"
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />
      <div className="bg-card relative z-10 w-full max-w-lg rounded-lg border p-5 shadow-xl">
        <h3 id="asset-model-title" className="text-base font-semibold">
          {isEdit ? 'Редактирование модели' : 'Новая модель техники'}
        </h3>

        <div className="mt-4 space-y-3">
          <div>
            <FieldLabel required>Модель</FieldLabel>
            <input
              ref={firstRef}
              type="text"
              value={modelName}
              onChange={(e) => setModelName(e.target.value)}
              placeholder="Mindray DC-70, Tuttnauer 3870EA…"
              className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
          </div>
          <div>
            <FieldLabel>Производитель</FieldLabel>
            <input
              type="text"
              value={manufacturer}
              onChange={(e) => setManufacturer(e.target.value)}
              placeholder="Philips, Drager, Mindray…"
              className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
          </div>
          <div>
            <FieldLabel>Тип оборудования</FieldLabel>
            <input
              type="text"
              list="model-device-types-list"
              value={deviceType}
              onChange={(e) => setDeviceType(e.target.value)}
              placeholder="УЗИ, рентген, отсасыватель…"
              className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
            <datalist id="model-device-types-list">
              {deviceTypeOptions.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <FieldLabel>Класс риска</FieldLabel>
              <select
                value={riskClass}
                onChange={(e) => setRiskClass(e.target.value as '' | RiskClass)}
                className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
              >
                <option value="">не задан</option>
                <option value="1">1</option>
                <option value="2a">2а</option>
                <option value="2b">2б</option>
                <option value="3">3</option>
              </select>
              <p className="text-muted-foreground mt-1 text-xs">по Росздравнадзору</p>
            </div>
            <div>
              <FieldLabel>Категория аттестации</FieldLabel>
              <select
                value={attestation}
                onChange={(e) => setAttestation(e.target.value)}
                className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
              >
                <option value="">не требуется</option>
                {cats.data?.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
                {attestation &&
                  !((cats.data as readonly string[] | undefined) ?? []).includes(attestation) && (
                    <option value={attestation}>{attestation}</option>
                  )}
              </select>
            </div>
          </div>
          <div>
            <FieldLabel>Заметки</FieldLabel>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
          </div>
        </div>

        {error && (
          <div className="bg-destructive/10 text-destructive border-destructive/30 mt-3 rounded-md border p-2 text-xs">
            {error}
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="hover:bg-muted rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={pending}
            className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          >
            {pending ? 'Сохранение…' : isEdit ? 'Сохранить' : 'Добавить'}
          </button>
        </div>
      </div>
    </div>
  );
}

function FieldLabel({
  children,
  required = false,
}: {
  children: React.ReactNode;
  required?: boolean;
}) {
  return (
    <label className="text-foreground mb-1 flex items-center gap-1 text-xs font-medium">
      {children}
      {required && <span className="text-destructive">*</span>}
    </label>
  );
}
