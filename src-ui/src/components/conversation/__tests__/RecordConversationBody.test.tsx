// @vitest-environment jsdom
import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PreviewProvider } from '../../../contexts/PreviewContext';
import { deviceSettingsStore } from '../../../lib/device-settings-store';
import {
  _resetOutboundQueueStorage,
  _setOutboundQueueStorage,
  outboundDispatch,
} from '../../../lib/outboundQueue';
import { ConversationBody } from '../ConversationBody';
import { conversationConnection } from './fixtures';

vi.mock('../../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: null }),
}));
vi.mock('../../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn(), dismissToast: vi.fn() }),
}));

const clients: QueryClient[] = [];
beforeEach(() => {
  let stored: unknown;
  _setOutboundQueueStorage({
    getItem: async () => stored,
    setItem: async (_key, value) => {
      stored = value;
    },
    updateItem: async (_key, update) => {
      stored = update(stored);
    },
  });
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  _resetOutboundQueueStorage();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
  deviceSettingsStore.set('chatReturnBehavior', 'auto');
});

const session: OrchestrationSessionSummary = {
  threadId: 'execution',
  conversationId: 'conversation',
  provider: 'station-agent',
  controlMode: 'station-owned',
  status: 'ready',
  lifecycleState: 'idle',
  hasActiveTurn: false,
  answerability: { answerable: true },
  isLoaded: true,
  isPersisted: true,
  eventCount: 0,
  createdAt: '2026-11-04T00:00:00Z',
  updatedAt: '2026-11-04T00:00:00Z',
};

function Harness({
  route,
  running = false,
  readOnly = false,
}: {
  route: 'host' | 'direct' | 'relay';
  running?: boolean;
  readOnly?: boolean;
}) {
  const [input, setInput] = useState('');
  const [station] = useState(() => conversationConnection(route));
  return (
    <ConversationBody
      density="record"
      connection={{
        apiBase: station.targetApiBase,
        station,
        requestScope: { ...station.requestScope, isCurrent: station.isCurrent },
      }}
      session={session}
      readOnly={readOnly}
      reader={{ agentLabel: 'Reviewer', isStreaming: running }}
      source={{ events: [], settled: true }}
      composer={{ input, onInputChange: setInput }}
    />
  );
}

function mount(
  route: 'host' | 'direct' | 'relay',
  options: { running?: boolean; readOnly?: boolean } = {},
) {
  const station = conversationConnection(route);
  setClientCredentialResolver(() => ({
    origin: station.requestScope.apiBase,
    credential: 'record-fixture',
    requestAuthority: { ...station.requestScope, isCurrent: station.isCurrent },
  }));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <PreviewProvider>
        <Harness route={route} {...options} />
      </PreviewProvider>
    </QueryClientProvider>,
  );
}

test.each(['host', 'direct', 'relay'] as const)(
  '%s record sends once through its bound continuation',
  async (route) => {
    const requests: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body)),
        });
        return Response.json({
          success: true,
          data: {
            conversationId: 'conversation',
            sessionId: 'execution',
            providerTurnId: 'turn',
          },
        });
      }),
    );
    mount(route);
    const user = userEvent.setup();
    const editor = await screen.findByRole('textbox', { name: 'Message' });
    await user.type(editor, 'Continue the review.');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe(''));
    expect(requests).toEqual([
      {
        url: `${conversationConnection(route).targetApiBase}/api/orchestration/chat/conversation/continue`,
        body: expect.objectContaining({
          message: 'Continue the review.',
          clientTurnId: expect.any(String),
          environment: { kind: 'current' },
        }),
      },
    ]);
    expect(await outboundDispatch.snapshot()).toEqual([]);
  },
);

test('record interrupt is immediate and a read-only record cannot interrupt', async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ success: true, data: {} }),
  );
  vi.stubGlobal('fetch', fetcher);
  const first = mount('relay', { running: true });
  await screen.findByRole('textbox');
  await userEvent.click(
    screen.getByRole('button', { name: 'Stop the current turn' }),
  );
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
    type: 'interruptTurn',
    threadId: 'execution',
  });
  expect(screen.queryByRole('alertdialog')).toBeNull();
  first.unmount();
  mount('relay', { running: true, readOnly: true });
  await screen.findByRole('textbox');
  expect(
    screen.queryByRole('button', { name: 'Stop the current turn' }),
  ).toBeNull();
  expect(fetcher).toHaveBeenCalledOnce();
});

test('an uncertain record send keeps its key and requires Check before same-key Retry', async () => {
  const keys: string[] = [];
  let loseResponse = true;
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method === 'POST') {
        const body: { clientTurnId: string } = JSON.parse(String(init.body));
        keys.push(body.clientTurnId);
        if (loseResponse) throw new TypeError('Failed to fetch');
        return Response.json({
          success: true,
          data: {
            conversationId: 'conversation',
            sessionId: 'execution',
            providerTurnId: 'turn',
          },
        });
      }
      return Response.json({
        success: true,
        data: {
          outcome: 'not-received',
          conversationId: 'conversation',
          clientTurnId: keys[0],
        },
      });
    }),
  );
  mount('relay');
  const user = userEvent.setup();
  const editor = await screen.findByRole('textbox');
  await user.type(editor, 'Retain this draft.');
  await user.click(screen.getByRole('button', { name: 'Send' }));
  await user.click(await screen.findByRole('button', { name: 'Check' }));
  await screen.findByRole('button', { name: 'Retry' });
  expect(keys).toHaveLength(1);
  expect((editor as HTMLTextAreaElement).value).toBe('Retain this draft.');
  loseResponse = false;
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(keys).toHaveLength(2));
  expect(keys[1]).toBe(keys[0]);
});

test('record editors honor the return-key preference and IME', async () => {
  deviceSettingsStore.set('chatReturnBehavior', 'newline');
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({
      success: true,
      data: {
        conversationId: 'conversation',
        sessionId: 'execution',
        providerTurnId: 'turn',
      },
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  mount('host');
  const editor = await screen.findByRole('textbox');
  fireEvent.change(editor, { target: { value: 'Keep composing' } });
  fireEvent.keyDown(editor, { key: 'Enter' });
  fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true, isComposing: true });
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true });
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
});

test('a saved-delivery read failure retains the draft and offers a working Retry', async () => {
  let unavailable = true;
  _setOutboundQueueStorage({
    getItem: async () => {
      if (unavailable) throw new Error('Fixture storage unavailable');
      return undefined;
    },
    setItem: async () => {},
    updateItem: async (_key, update) => {
      update(undefined);
    },
  });
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetcher);
  mount('relay');
  const editor = await screen.findByRole('textbox', { name: 'Message' });
  fireEvent.change(editor, {
    target: { value: 'Keep this draft while delivery storage recovers.' },
  });
  const retry = await screen.findByRole('button', { name: 'Retry' });
  expect((editor as HTMLTextAreaElement).value).toBe(
    'Keep this draft while delivery storage recovers.',
  );
  unavailable = false;
  await userEvent.click(retry);
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull(),
  );
  expect((editor as HTMLTextAreaElement).value).toBe(
    'Keep this draft while delivery storage recovers.',
  );
  expect(fetcher).not.toHaveBeenCalled();
});
