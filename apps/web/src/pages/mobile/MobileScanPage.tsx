import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import type { IScannerControls } from '@zxing/browser';
import { Camera, Loader2, ScanLine, Type, X, AlertTriangle } from 'lucide-react';
import { trpc } from '../../lib/trpc';

/**
 * /m/scan — камера → распознавание Code-128 на ticket.barcode → редирект на карточку.
 *
 * Если камера не разрешена / нет — даём fallback ввести код руками.
 * После распознавания ищем заявку через trpc.tickets.search (по barcode).
 *
 * Замечание: zxing работает в browser через MediaDevices API. На iOS Safari
 * нужен HTTPS, иначе getUserMedia вернёт NotAllowedError. В деве с http://localhost
 * камера разрешена.
 */
export function MobileScanPage() {
  const [, navigate] = useLocation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [manual, setManual] = useState('');
  const [searching, setSearching] = useState(false);
  const utils = trpc.useUtils();

  useEffect(() => {
    return () => {
      controlsRef.current?.stop();
      controlsRef.current = null;
    };
  }, []);

  const handleHit = async (text: string) => {
    if (searching) return;
    setSearching(true);
    try {
      const matches = await utils.tickets.search.fetch({ q: text });
      const match = matches[0];
      if (match) {
        navigate(`/m/tickets/${match.id}`);
      } else {
        setError(`Не нашли заявку по коду «${text}»`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка поиска');
    } finally {
      setSearching(false);
    }
  };

  const startCamera = async () => {
    setError(null);
    setScanning(true);
    try {
      const [{ BrowserMultiFormatReader }, { DecodeHintType, BarcodeFormat }] = await Promise.all([
        import('@zxing/browser'),
        import('@zxing/library'),
      ]);
      const hints = new Map();
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [
        BarcodeFormat.CODE_128,
        BarcodeFormat.CODE_39,
        BarcodeFormat.QR_CODE,
        BarcodeFormat.EAN_13,
      ]);
      const reader = new BrowserMultiFormatReader(hints);
      const video = videoRef.current;
      if (!video) return;
      const controls = await reader.decodeFromVideoDevice(
        undefined, // useDefaultCamera
        video,
        (result, _err, ctrl) => {
          if (result) {
            ctrl.stop();
            controlsRef.current = null;
            setScanning(false);
            void handleHit(result.getText());
          }
        },
      );
      controlsRef.current = controls;
    } catch (e) {
      setScanning(false);
      const msg =
        e instanceof Error && e.name === 'NotAllowedError'
          ? 'Доступ к камере не разрешён. Разрешите в настройках браузера.'
          : e instanceof Error
            ? e.message
            : 'Не удалось включить камеру';
      setError(msg);
    }
  };

  const stopCamera = () => {
    controlsRef.current?.stop();
    controlsRef.current = null;
    setScanning(false);
  };

  const onSubmitManual = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = manual.trim();
    if (!trimmed) return;
    void handleHit(trimmed);
  };

  return (
    <div className="space-y-3 p-3">
      <div className="bg-card overflow-hidden rounded-lg border">
        <div className="bg-muted/40 flex items-center justify-between border-b px-3 py-2">
          <div className="inline-flex items-center gap-1.5 text-sm font-semibold">
            <ScanLine className="h-4 w-4" />
            Сканер штрих-кода
          </div>
          {scanning && (
            <button
              type="button"
              onClick={stopCamera}
              className="text-muted-foreground hover:text-foreground text-xs"
            >
              <X className="inline h-3.5 w-3.5" /> остановить
            </button>
          )}
        </div>

        <div className="bg-black relative aspect-[3/4] w-full">
          <video
            ref={videoRef}
            playsInline
            muted
            className="absolute inset-0 h-full w-full object-cover"
          />
          {!scanning && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center text-white">
              <Camera className="h-10 w-10 opacity-70" />
              <button
                type="button"
                onClick={() => void startCamera()}
                className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-12 items-center gap-2 rounded-lg px-5 text-base font-semibold"
              >
                <Camera className="h-5 w-5" />
                Включить камеру
              </button>
            </div>
          )}
          {scanning && (
            <div className="pointer-events-none absolute inset-x-8 top-1/3 bottom-1/3 rounded-lg border-2 border-primary/80 shadow-[0_0_0_2000px_rgba(0,0,0,0.4)]" />
          )}
        </div>

        {searching && (
          <div className="bg-primary/10 text-primary flex items-center gap-2 px-3 py-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            Ищем заявку…
          </div>
        )}
      </div>

      <form onSubmit={onSubmitManual} className="bg-card space-y-2 rounded-lg border p-3">
        <label className="text-muted-foreground text-[11px] font-medium uppercase">
          Или введите код вручную
        </label>
        <div className="flex gap-2">
          <input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="T-2026-000001 или штрих-код"
            className="border-input bg-background flex-1 rounded-md border px-3 py-2 text-sm font-mono"
          />
          <button
            type="submit"
            disabled={!manual.trim() || searching}
            className="bg-secondary text-secondary-foreground inline-flex h-10 items-center gap-1.5 rounded-md px-3 text-sm font-medium disabled:opacity-50"
          >
            <Type className="h-4 w-4" />
            Найти
          </button>
        </div>
      </form>

      {error && (
        <div className="bg-destructive/10 text-destructive border-destructive/30 flex items-start gap-2 rounded-md border p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
