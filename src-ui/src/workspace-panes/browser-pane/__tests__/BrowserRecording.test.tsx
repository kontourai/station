/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const intake = vi.hoisted(() => vi.fn(async (_files: File[]) => {}));
const resize = vi.hoisted(() =>
  vi.fn(async () => ({
    status: 'resized' as const,
    image: {
      dataUrl: 'data:image/jpeg;base64,/9j/AA==',
      mimeType: 'image/jpeg' as const,
    },
  })),
);
vi.mock('../../../utils/downscaleImage', () => ({
  downscaleImageToFit: resize,
}));
vi.mock('../../../contexts/navigation-store', () => ({
  navigationStore: { getSnapshot: () => ({ activeChat: 'conversation-1' }) },
}));
vi.mock('../useBrowserArtifactIntake', () => ({
  useBrowserArtifactIntake: () => () => intake,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  intake.mockClear();
  resize.mockClear();
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
    recordingFrames: vi.fn(async () => ({
      frames: Array.from({ length: 4 }, (_, i) => ({
        data: 'AQID',
        atMs: i * 100,
        capturedAt: '2026-01-01T00:00:00.000Z',
        url: 'https://example.test/',
        viewport: { width: 640, height: 480 },
      })),
    })),
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
  expect(api.startRecording).toHaveBeenCalledWith(
    'bs_test',
    3,
    'conversation-1',
  );
  expect(api.stopRecording).toHaveBeenCalledWith('bs_test', 'r1');
  expect(api.recordingVideo).toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole('button', { name: 'Attach recording frames to chat' }),
  );
  await waitFor(() => expect(intake).toHaveBeenCalledOnce());
  const files = intake.mock.calls[0]![0];
  expect(files).toHaveLength(5);
  expect(files.slice(0, 4).every((file) => file.type === 'image/jpeg')).toBe(
    true,
  );
  expect(files.reduce((sum, file) => sum + file.size, 0)).toBeLessThan(
    5 * 1024 * 1024,
  );
  const metadata = await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(files[4]!);
  });
  expect(JSON.parse(metadata)).toMatchObject({
    kind: 'browser-recording-frames',
    browserSessionId: 'bs_test',
    tab: 'bs_test',
    generation: 3,
    frames: expect.arrayContaining([
      expect.objectContaining({
        atMs: 0,
        url: 'https://example.test/',
        notice: expect.stringContaining('untrusted'),
        viewport: { width: 640, height: 480 },
      }),
    ]),
  });
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

it('resizes large sampled frames before sending a bounded contact set', async () => {
  const payload = btoa('x'.repeat(1024 * 1024 + 1));
  const api = {
    startRecording: vi.fn(async () => ({ recordingId: 'r1' })),
    recordingStatus: vi.fn(async () => ({ id: 'r1', state: 'ready' as const })),
    recordingVideo: vi.fn(
      async () => new Blob(['webm'], { type: 'video/webm' }),
    ),
    recordingFrames: vi.fn(async () => ({
      frames: Array.from({ length: 4 }, (_, i) => ({
        data: payload,
        atMs: i * 100,
        capturedAt: '2026-01-01T00:00:00.000Z',
        url: 'https://example.test/',
        viewport: { width: 640, height: 480 },
      })),
    })),
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
  fireEvent.click(
    await screen.findByRole('button', {
      name: 'Attach recording frames to chat',
    }),
  );
  await waitFor(() => expect(intake).toHaveBeenCalledOnce());
  const files = intake.mock.calls[0]![0];
  expect(resize).toHaveBeenCalledTimes(4);
  expect(files.reduce((sum, file) => sum + file.size, 0)).toBeLessThan(
    5 * 1024 * 1024,
  );
  expect(files.slice(0, 4).every((file) => file.type === 'image/jpeg')).toBe(
    true,
  );
});

it('offers Task publication only when start established a Task pin', async () => {
  const api = {
    startRecording: vi.fn(async () => ({ recordingId: 'r1' })),
    recordingStatus: vi.fn(async () => ({
      id: 'r1',
      state: 'ready' as const,
      task: { kind: 'ready' as const, taskId: 'task-a' },
    })),
    recordingVideo: vi.fn(
      async () => new Blob(['webm'], { type: 'video/webm' }),
    ),
    publishRecordingToTask: vi.fn(async () => ({ walkthroughId: 'clip-a' })),
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
  fireEvent.click(
    await screen.findByRole('button', { name: 'Add to Task clips' }),
  );
  expect(
    await screen.findByText('Recording added to Task clips.'),
  ).toBeTruthy();
  expect(api.publishRecordingToTask).toHaveBeenCalledWith('bs_test', 'r1');
});

it('shows the Task refusal without offering publication when the pin or authority is unavailable', async () => {
  const reason =
    'Commit or stash changes to add recordings to the Task, and ensure you have Task access.';
  const api = {
    startRecording: vi.fn(async () => ({ recordingId: 'r1' })),
    recordingStatus: vi.fn(async () => ({
      id: 'r1',
      state: 'recording' as const,
      task: { kind: 'unavailable' as const, reason },
    })),
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
  expect(await screen.findByText(reason)).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: 'Add to Task clips' }),
  ).toBeNull();
});
