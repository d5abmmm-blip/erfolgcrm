/**
 * Фото не пропадает, когда нет связи.
 *
 * Раньше непринятый снимок жил в состоянии React: ушёл с экрана — и нет его.
 * Здесь стережём главное: неудачная отправка кладёт файл в память телефона,
 * плитка подписана «ждёт отправки», и всё это ПЕРЕЖИВАЕТ уход с экрана.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import { trpc } from '../lib/trpc';
import { PhotoUploader } from '../components/PhotoUploader';
import { clearAllPhotos, countPendingPhotos, listPendingPhotos } from '../lib/offline/photo-queue';

const TICKET = 'ffffffff-0000-4000-8000-000000000009';

function renderUploader() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = trpc.createClient({
    links: [
      httpBatchLink({
        url: 'http://test.invalid/api/v1/trpc',
        transformer: superjson,
        fetch: () => Promise.reject(new TypeError('Failed to fetch')),
      }),
    ],
  });
  return render(
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <PhotoUploader
          kind="ticket_photo"
          referenceType="ticket"
          referenceId={TICKET}
          canUpload
          showCamera
        />
      </QueryClientProvider>
    </trpc.Provider>,
  );
}

function pickFile(container: HTMLElement, name = 'повреждение.jpg') {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([new Uint8Array(4096)], name, { type: 'image/jpeg' });
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(async () => {
  await clearAllPhotos();
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: false });
});

afterEach(async () => {
  cleanup();
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: true });
  await clearAllPhotos();
});

describe('снимок без связи', () => {
  it('уходит в очередь, а не пропадает', async () => {
    const { container } = renderUploader();
    pickFile(container);

    await waitFor(async () => expect(await countPendingPhotos()).toBe(1));

    const [saved] = await listPendingPhotos();
    expect(saved!.fileName).toBe('повреждение.jpg');
    expect(saved!.bytes.byteLength).toBe(4096);
    expect(await screen.findByText(/ждёт отправки/)).toBeTruthy();
  });

  it('плитка переживает уход с экрана — файл лежит в телефоне, а не в React', async () => {
    const first = renderUploader();
    pickFile(first.container);
    await waitFor(async () => expect(await countPendingPhotos()).toBe(1));

    // Инженер ушёл с карточки заявки и вернулся.
    cleanup();
    renderUploader();

    expect(await screen.findByText('повреждение.jpg')).toBeTruthy();
    expect(await screen.findByText(/ждёт отправки/)).toBeTruthy();
  });
});
