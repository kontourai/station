/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

import {
  BrowserRecordingButton,
  BrowserRecordingStatus,
  useBrowserRecording,
} from '../BrowserRecording';
import type { BrowserPaneApi } from '../browserPaneApi';

function View({
  api,
  generation = 3,
}: {
  api: BrowserPaneApi;
  generation?: number | null;
}) {
  const value = generation ?? undefined;
  const recording = useBrowserRecording(api, 'bs_test', value, true);
  return (
    <>
      <BrowserRecordingButton
        recording={recording}
        live={value !== undefined}
      />
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
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL() {
        return '';
      }
      static revokeObjectURL() {}
    },
  );
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:clip');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
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
  expect(api.cancelRecording).toHaveBeenCalledWith('bs_test', 'r1');
});

it('shows a failed state when status polling fails and lets the user dismiss it', async () => {
  const api = {
    startRecording: vi.fn(async () => ({ recordingId: 'r1' })),
    recordingStatus: vi.fn(async () => {
      throw new Error('disconnected');
    }),
    cancelRecording: vi.fn(async () => {}),
  } as unknown as BrowserPaneApi;
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <View api={api} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Record' }));
  expect(await screen.findByText('Recording is unavailable.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Stop recording' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(api.cancelRecording).toHaveBeenCalledWith('bs_test', 'r1');
});

it('does not start recording without a session generation', () => {
  const api = { startRecording: vi.fn() } as unknown as BrowserPaneApi;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <View api={api} generation={null} />
    </QueryClientProvider>,
  );
  expect(
    (screen.getByRole('button', { name: 'Record' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(api.startRecording).not.toHaveBeenCalled();
});
