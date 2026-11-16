// @vitest-environment jsdom
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { PreviewProvider } from '../contexts/PreviewContext';
import { ToastProvider } from '../contexts/ToastContext';

vi.mock('../components/icons/UserIcon', () => ({ UserIcon: () => null }));
vi.mock('../contexts/ApiBaseContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../contexts/ApiBaseContext')>()),
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));

const sdk = vi.hoisted(() => ({
  capable: true,
  fetchRemoteSessionHistory: vi.fn(),
}));
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  readRemoteSessionHistoryCapability: async () => sdk.capable,
  fetchRemoteSessionHistory: sdk.fetchRemoteSessionHistory,
}));

import { RemoteSessionReaderHost } from '../components/remote-session/RemoteSessionReaderHost';
import { remoteSessionReaderStore } from '../contexts/remote-session-reader-store';

const THREAD = 'external:claude:0123456789abcdef0123456789abcdef';
const ev = (sequence: number, e: Record<string, unknown>) => ({
  sequence,
  event: {
    eventId: `e${sequence}`,
    provider: 'claude',
    threadId: THREAD,
    createdAt: '2026-11-01T00:00:00.000Z',
    ...e,
  } as unknown as CanonicalRuntimeEvent,
});

function renderHost() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <PreviewProvider>
        <ToastProvider>
          <RemoteSessionReaderHost />
        </ToastProvider>
      </PreviewProvider>
    </QueryClientProvider>,
  );
}

function openReader() {
  act(() => {
    remoteSessionReaderStore.open({
      environmentId: 'env-a',
      environmentLabel: 'Home media',
      threadId: THREAD,
      title: 'List the files',
    });
  });
}

afterEach(() => {
  const open = remoteSessionReaderStore.getSnapshot();
  if (open) act(() => remoteSessionReaderStore.close(open));
  sdk.capable = true;
  sdk.fetchRemoteSessionHistory.mockReset();
});

describe('RemoteSessionReaderHost', () => {
  test("shows the remote session's relayed history read-only, with continuation disabled and why", async () => {
    sdk.fetchRemoteSessionHistory.mockResolvedValue({
      environmentId: 'env-a',
      environmentName: 'Home media',
      window: {
        protocolVersion: 1,
        session: {
          threadId: THREAD,
          provider: 'claude',
          controlMode: 'read-only-attached',
          createdAt: '2026-11-01T00:00:00.000Z',
          updatedAt: '2026-11-01T00:00:00.000Z',
          answerability: { answerable: true },
        },
        events: [
          ev(1, { method: 'turn.started', turnId: 'r1', prompt: 'list files' }),
          ev(2, {
            method: 'content.text-delta',
            itemId: 'i1',
            delta: 'Here are the files.',
          }),
          ev(3, {
            method: 'turn.completed',
            turnId: 'r1',
            finishReason: 'stop',
          }),
        ],
        hasMore: false,
        watermark: 3,
      },
    });
    renderHost();
    openReader();

    const reader = await screen.findByTestId('remote-session-reader');
    expect(await within(reader).findByText('Here are the files.')).toBeTruthy();
    expect(sdk.fetchRemoteSessionHistory).toHaveBeenCalledWith(
      'env-a',
      THREAD,
      { turnLimit: 10 },
    );
    expect(screen.getByText('On Home media · Read only')).toBeTruthy();
    const composer = within(reader).getByRole('textbox');
    expect((composer as HTMLTextAreaElement).disabled).toBe(true);
    expect(
      within(reader).getByText(
        'This session runs on Home media. Open Station on Home media to continue it.',
      ),
    ).toBeTruthy();
  });

  test('a Station without the capability says so and reads nothing', async () => {
    sdk.capable = false;
    renderHost();
    openReader();
    expect(
      await screen.findByTestId('remote-session-unsupported'),
    ).toBeTruthy();
    expect(sdk.fetchRemoteSessionHistory).not.toHaveBeenCalled();
  });

  test("a refused read shows the server's reason instead of an empty transcript", async () => {
    sdk.fetchRemoteSessionHistory.mockRejectedValue(
      new Error('That computer is not connected. Connect it, then try again.'),
    );
    renderHost();
    openReader();
    expect(
      (await screen.findByTestId('remote-session-error')).textContent,
    ).toBe('That computer is not connected. Connect it, then try again.');
  });
});
