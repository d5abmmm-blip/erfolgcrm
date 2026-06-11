import { useState, type FormEvent } from 'react';
import { useLocation } from 'wouter';
import { Loader2 } from 'lucide-react';
import { trpc } from '../../lib/trpc';

export function ClientNewTicketPage() {
  const [, navigate] = useLocation();
  const assets = trpc.clientCabinet.listAssets.useQuery();

  const [assetId, setAssetId] = useState('');
  const [summary, setSummary] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = trpc.clientCabinet.createTicket.useMutation({
    onSuccess: (r) => navigate(`/client/tickets/${r.id}`),
    onError: (e) => setError(e.message),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!assetId) {
      setError('Выберите технику');
      return;
    }
    if (summary.trim().length < 5) {
      setError('Опишите проблему хотя бы в 5 символах');
      return;
    }
    create.mutate({
      assetId,
      summary: summary.trim(),
      contactPhone: phone.trim() || undefined,
    });
  }

  return (
    <div className="mx-auto max-w-xl space-y-4 p-4 md:p-6">
      <div>
        <h2 className="text-xl font-semibold">Новая заявка на ремонт</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          После отправки наш диспетчер свяжется с вами для уточнения деталей.
        </p>
      </div>

      <form onSubmit={onSubmit} className="bg-card space-y-4 rounded-md border p-4 md:p-6">
        <Field label="Техника">
          {assets.isLoading ? (
            <div className="text-muted-foreground text-sm">Загрузка списка…</div>
          ) : (
            <select
              value={assetId}
              onChange={(e) => setAssetId(e.target.value)}
              className="border-input bg-background h-10 w-full rounded-md border px-2 text-sm"
              required
            >
              <option value="">— Выберите —</option>
              {(assets.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.model} {a.serialNumber ? `· s/n ${a.serialNumber}` : ''}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field label="Описание проблемы">
          <textarea
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            rows={5}
            placeholder="Опишите, что не работает или какая нужна услуга"
            className="border-input bg-background min-h-[90px] w-full rounded-md border px-3 py-2 text-sm"
            required
          />
        </Field>

        <Field label="Контактный телефон" hint="Если отличается от телефона организации">
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
            placeholder="+7 ..."
          />
        </Field>

        {error && (
          <div className="bg-destructive/10 text-destructive rounded-md border border-destructive/20 px-3 py-2 text-sm">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={create.isPending}
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium transition disabled:opacity-50"
        >
          {create.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          Отправить заявку
        </button>
      </form>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-foreground text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="text-muted-foreground block text-xs">{hint}</span>}
    </label>
  );
}
