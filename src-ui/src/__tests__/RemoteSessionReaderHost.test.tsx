// @vitest-environment jsdom
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { PreviewProvider } from '../contexts/PreviewContext';
import { ToastProvider } from '../contexts/ToastContext';

vi.mock('../components/icons/UserIcon', () => ({ UserIcon: () => null }));
// The shell resolves this Station as the reader's owning connection.
const registry = vi.hoisted(() => ({
  resolve: vi.fn(),
  release: vi.fn(),
}));
vi.mock('../connections/StationConnectionsContext', () => ({
  useStationConnectionsOptional: () => registry,
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

import { StationHttpError } from '@kontourai/station-sdk/client';
import { conversationConnection } from '../components/conversation/__tests__/fixtures';
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

const STATION = conversationConnection('host');

beforeEach(() => {
  registry.resolve.mockResolvedValue({
    connection: STATION,
    release: registry.release,
  });
});

afterEach(() => {
  registry.resolve.mockReset();
  registry.release.mockReset();
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
    // Read through the owning connection's Station and authority, never an
    // ambient host.
    expect(sdk.fetchRemoteSessionHistory).toHaveBeenCalledWith(
      'env-a',
      THREAD,
      { turnLimit: 10 },
      {
        apiBase: STATION.targetApiBase,
        requestScope: STATION.requestScope,
        signal: expect.any(AbortSignal),
      },
    );
    expect(registry.resolve).toHaveBeenCalledWith({});
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

  test('a refusal the relay names by code shows fixed copy, not the server sentence', async () => {
    sdk.fetchRemoteSessionHistory.mockRejectedValue(
      new StationHttpError(409, 'server-chosen sentence that must not show', {
        code: 'environment_unavailable',
      }),
    );
    renderHost();
    openReader();
    expect(
      (await screen.findByTestId('remote-session-error')).textContent,
    ).toBe('That computer is not connected. Connect it, then try again.');
  });

  test('any other failure goes through the Station failure translator', async () => {
    sdk.fetchRemoteSessionHistory.mockRejectedValue(
      new Error('raw diagnostic text that must not show'),
    );
    renderHost();
    openReader();
    const shown = (await screen.findByTestId('remote-session-error'))
      .textContent;
    expect(shown).not.toContain('raw diagnostic');
    expect(shown).toBe('Try again in a moment.');
  });

  test('without a resolvable Station the reader reads nothing and offers a retry', async () => {
    registry.resolve.mockRejectedValue(new Error('no Station'));
    renderHost();
    openReader();
    expect(await screen.findByText('Station unavailable')).toBeTruthy();
    expect(sdk.fetchRemoteSessionHistory).not.toHaveBeenCalled();
  });
});

describe('a budget-shortened remote page says so (security review L3)', () => {
  test('withheld events show the same omitted-details notice the local reader shows', async () => {
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
          {
            ...ev(1, { method: 'turn.started', turnId: 'r1' }),
            elided: 'byte_limit',
          },
          ev(2, {
            method: 'content.text-delta',
            itemId: 'i1',
            delta: 'Reply.',
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
    const notice = await screen.findByTestId('remote-session-history-elided');
    expect(notice.textContent).toContain(
      '1 recorded event has omitted content in this view.',
    );
  });

  test('a detached turn start stays partial until an older page reads it in range', async () => {
    const { remoteHistoryEvents } = await import(
      '../components/remote-session/RemoteSessionReaderHost'
    );
    const detached = {
      window: {
        turnStartDetached: true as const,
        events: [
          ev(5, { method: 'turn.started', turnId: 'r2' }),
          ev(9, { method: 'turn.completed', turnId: 'r2' }),
        ],
      },
    };
    expect([
      ...remoteHistoryEvents([detached]).partialTurnStartEventIds,
    ]).toEqual(['e5']);
    const older = {
      window: {
        events: [
          ev(5, { method: 'turn.started', turnId: 'r2' }),
          ev(6, { method: 'content.text-delta', itemId: 'i', delta: 'x' }),
        ],
      },
    };
    const both = remoteHistoryEvents([detached, older]);
    expect([...both.partialTurnStartEventIds]).toEqual([]);
    expect(both.events.map((event) => event.eventId)).toEqual([
      'e5',
      'e6',
      'e9',
    ]);
  });
});
