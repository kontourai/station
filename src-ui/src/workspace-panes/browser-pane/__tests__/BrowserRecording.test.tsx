/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import {
  BrowserRecordingButton,
  BrowserRecordingStatus,
  useBrowserRecording,
} from '../BrowserRecording';
import type { BrowserPaneApi } from '../browserPaneApi';

function View({ api }: { api: BrowserPaneApi }) {
  const recording = useBrowserRecording(api, 'bs_test', 3, true);
  return (
    <>
      <BrowserRecordingButton recording={recording} live />
      <BrowserRecordingStatus recording={recording} />
    </>
  );
}

it('starts, shows recording, stops and offers the encoded clip to save', async () => {
  let state: 'recording' | 'ready' = 'recording';
  const api = {
    startRecording: vi.fn(async () => ({ recordingId: 'r1' })),
    recordingStatus: vi.fn(async () => ({ id: 'r1', state })),
    stopRecording: vi.fn(async () => {
      state = 'ready';
    }),
    recordingVideo: vi.fn(
      async () => new Blob(['webm'], { type: 'video/webm' }),
    ),
    cancelRecording: vi.fn(async () => {}),
  } as unknown as BrowserPaneApi;
  Object.assign(URL, {
    createObjectURL: vi.fn(() => 'blob:clip'),
    revokeObjectURL: vi.fn(),
  });
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <View api={api} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Record' }));
  expect(await screen.findByText('Recording…')).toBeTruthy();
  const stop = await screen.findByRole('button', { name: 'Stop recording' });
  await waitFor(() => expect((stop as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(stop);
  expect(await screen.findByRole('link', { name: 'Save clip' })).toHaveProperty(
    'href',
    'blob:clip',
  );
  expect(api.startRecording).toHaveBeenCalledWith('bs_test', 3);
  expect(api.stopRecording).toHaveBeenCalledWith('bs_test', 'r1');
  expect(api.recordingVideo).toHaveBeenCalled();
  view.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:clip');
});
