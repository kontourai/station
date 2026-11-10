// @vitest-environment jsdom
import type { AttentionRequestInspection } from '@kontourai/station-contracts/attention';
import type { ConversationInboxEntry } from '@kontourai/station-contracts/orchestration';
import type {
  ApprovalAttentionItem,
  OrchestrationSessionSummary,
} from '@kontourai/station-sdk';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { type ReactNode, useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ActiveChatsProvider } from '../../../contexts/ActiveChatsContext';
import { PreviewProvider } from '../../../contexts/PreviewContext';
import {
  _resetOutboundQueueStorage,
  _setOutboundQueueStorage,
} from '../../../lib/outboundQueue';
import { ProjectTaskRoomConversation } from '../../../workspace-panes/ProjectTaskRoomConversation';
import { AttentionCard } from '../../attention/AttentionCard';
import { AttentionHistoryItem } from '../../attention/AttentionHistoryItem';
import { ExactRequestInline } from '../../attention/ExactRequestInline';
import { QueuedMessages } from '../../chat/QueuedMessages';
import { UnsentMessages } from '../../chat/UnsentMessages';
import { ConversationBody } from '../ConversationBody';
import { ConversationConnectionProvider } from '../ConversationConnectionContext';
import { conversationConnection } from './fixtures';

const state = vi.hoisted(() => ({ writable: true, current: true }));
const authority = {
  apiBase: 'http://source.test',
  authorityKey: 'host-principal',
  isCurrent: () => state.current,
};
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: authority.apiBase }),
  useHostRequestAuthorityScope: () => authority,
}));
vi.mock('../../../hooks/usePruneActiveChats', () => ({
  usePruneActiveChats: () => {},
}));
vi.mock('../../../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () => new Set<string>(),
}));
vi.mock('../../../workspace-panes/ProjectTaskRoomContext', () => ({
  useProjectTaskRoomContext: () => ({
    stream: 'live',
    live: {
      participants: [
        {
          publication: 'published',
          actor: { actorId: 'worker', kind: 'agent', label: 'Worker' },
          work: {
            sessionId: 'delegated-run',
            workState: 'working',
            workName: 'Task',
          },
        },
      ],
    },
  }),
}));
vi.mock(
  '@kontourai/station-sdk/project-task-rooms',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@kontourai/station-sdk/project-task-rooms')
    >()),
    useProjectTaskRoomDiscoveryQuery: () => ({
      data: {
        kind: 'existing',
        capabilities: { historyRead: true, messageWrite: state.writable },
      },
    }),
    useProjectTaskRoomHistoryQuery: () => ({
      data: { pages: [{ kind: 'available', records: [] }] },
      refetch: vi.fn(),
      hasNextPage: false,
    }),
    useTaskRoomAgentRequestsQuery: () => ({
      data: {
        records: [],
        context: {
          version: 'station.task-room-context/v1',
          digest: 'a'.repeat(64),
          title: 'Brief',
          description: '',
          documentRevision: 'revision',
          text: '',
        },
      },
      refetch: vi.fn(),
    }),
  }),
);
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  useTaskTurnReferencesQuery: () => ({ data: [] }),
  useCreateTaskReferenceMutation: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

const clients: QueryClient[] = [];
beforeEach(() => {
  state.writable = true;
  state.current = true;
  setClientCredentialResolver(() => ({
    origin: authority.apiBase,
    credential: 'scoped-fixture',
    requestAuthority: authority,
  }));
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
});
function mount(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <PreviewProvider>
        <ActiveChatsProvider>{node}</ActiveChatsProvider>
      </PreviewProvider>
    </QueryClientProvider>,
  );
}
function requestWire() {
  const requests: Array<{
    url: string;
    body: unknown;
    authorization: string | null;
  }> = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    requests.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      authorization: new Headers(init?.headers).get('Authorization'),
    });
    return Response.json({
      success: true,
      data: {
        taskId: 'delegated-run',
        sessionId: 'delegated-run',
        interruptRequested: true,
      },
    });
  });
  vi.stubGlobal('fetch', fetcher);
  return requests;
}

test('Task-room Stop cancels without egress and confirms on the Task protocol under its captured authority', async () => {
  const requests = requestWire();
  mount(
    <ProjectTaskRoomConversation
      taskId="task"
      taskCreatedAt="2026-11-05T00:00:00Z"
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  const dialog = screen.getByRole('alertdialog', { name: 'Stop this task?' });
  expect(requests).toHaveLength(0);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(requests).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  fireEvent.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Stop',
    }),
  );
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(requests).toEqual([
    {
      url:
        authority.apiBase +
        '/api/orchestration/delegations/delegated-run/interrupt',
      body: {},
      authorization: 'Bearer scoped-fixture',
    },
  ]);
});

test('Task-room permission denial and authority retirement both prevent a Stop request', async () => {
  const requests = requestWire();
  state.writable = false;
  const view = mount(<ProjectTaskRoomConversation taskId="task" />);
  expect(
    (screen.getByRole('button', { name: 'Stop' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  expect(requests).toHaveLength(0);
  view.unmount();
  state.writable = true;
  mount(<ProjectTaskRoomConversation taskId="task" />);
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  state.current = false;
  fireEvent.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Stop',
    }),
  );
  await screen.findByRole('alert');
  expect(requests).toHaveLength(0);
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
  createdAt: '2026-11-05T00:00:00Z',
  updatedAt: '2026-11-05T00:00:00Z',
};
function Record({ readOnly = false }: { readOnly?: boolean }) {
  const [input, setInput] = useState('');
  const [station] = useState(() => conversationConnection('host'));
  return (
    <ConversationBody
      density="record"
      connection={{
        apiBase: authority.apiBase,
        station,
        requestScope: authority,
      }}
      session={session}
      readOnly={readOnly}
      source={{ events: [], settled: true }}
      reader={{ agentLabel: 'Worker', isStreaming: true }}
      composer={{ input, onInputChange: setInput }}
    />
  );
}
test('a turn interrupt is immediate through the record parent; its read-only form cannot stop', async () => {
  const requests = requestWire();
  const view = mount(<Record />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Stop the current turn' }),
  );
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]).toMatchObject({
    url: authority.apiBase + '/api/orchestration/commands',
    body: { type: 'interruptTurn', threadId: 'execution' },
  });
  expect(screen.queryByRole('alertdialog')).toBeNull();
  view.unmount();
  mount(<Record readOnly />);
  await screen.findByRole('textbox', { name: 'Message' });
  expect(
    screen.queryByRole('button', { name: 'Stop the current turn' }),
  ).toBeNull();
  expect(requests).toHaveLength(1);
});

const reference = {
  threadId: 'request-session',
  requestId: 'request',
  requestEventId: 'request-event',
};
const open: AttentionRequestInspection = {
  state: 'open',
  reference,
  requestType: 'permission',
  provider: 'claude',
  title: 'Run command',
  openedAt: '2026-11-05T00:00:00Z',
  answerability: { answerable: true },
  canRespond: true,
};
const item: ApprovalAttentionItem = {
  id: 'approval:item',
  kind: 'approval',
  title: 'Run command',
  createdAt: open.openedAt,
  updatedAt: open.openedAt,
  source: { notificationId: 'item', notificationSource: 'approval-inbox' },
  actions: [],
  requestReference: reference,
};
function Tray({ denied = false }: { denied?: boolean }) {
  const [station] = useState(() => {
    const connection = conversationConnection('host');
    return denied
      ? {
          ...connection,
          capabilities: {
            ...connection.capabilities,
            approvalAnswer: {
              state: 'denied' as const,
              reason: 'permission-required' as const,
            },
          },
        }
      : connection;
  });
  return (
    <ConversationConnectionProvider
      value={{ apiBase: authority.apiBase, station, requestScope: authority }}
    >
      <AttentionHistoryItem
        item={item}
        isPending={false}
        isDismissPending={false}
        onAction={() => {}}
        onClose={() => {}}
        onDismiss={() => {}}
      />
    </ConversationConnectionProvider>
  );
}
test.each([false, true])(
  'the real Inbox parent binds approval to the inspected event (denied=%s)',
  async (denied) => {
    const posts: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (_input, init) => {
        if (init?.method === 'POST') posts.push(JSON.parse(String(init.body)));
        return Response.json({
          success: true,
          data: init?.method === 'POST' ? null : open,
        });
      }),
    );
    mount(<Tray denied={denied} />);
    const approve = await screen.findByRole('button', { name: 'Approve once' });
    if (denied) {
      await screen.findByText('Run command');
      expect((approve as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(approve);
      expect(posts).toHaveLength(0);
    } else {
      await waitFor(() =>
        expect((approve as HTMLButtonElement).disabled).toBe(false),
      );
      fireEvent.click(approve);
      await screen.findByText(/Decision sent/);
      expect(posts).toEqual([
        {
          type: 'respondToRequest',
          threadId: reference.threadId,
          requestId: reference.requestId,
          expectedRequestEventId: reference.requestEventId,
          decision: 'accept',
        },
      ]);
      fireEvent.click(approve);
      expect(posts).toHaveLength(1);
    }
  },
);

test('a permanent refusal offers recovery of the text without a resend action', () => {
  const requests = requestWire();
  mount(
    <UnsentMessages
      sessionId="refused"
      messages={[
        {
          id: 'refused',
          content: 'Keep my text',
          reason: 'This conversation ended.',
          at: 0,
        },
      ]}
    />,
  );
  expect(screen.getByText('Keep my text')).toBeTruthy();
  expect(screen.getAllByText('Not sent').length).toBeGreaterThan(0);
  expect(
    screen.queryByRole('button', { name: /retry|resend|send/i }),
  ).toBeNull();
  expect(requests).toHaveLength(0);
});

test.each(['Allow', 'Deny'])(
  'the paired Task %s action keeps its author authority when the transcript is read only',
  async (label) => {
    const requests = requestWire();
    mount(
      <ConversationConnectionProvider
        value={{ apiBase: 'http://receiver.test', record: { readOnly: true } }}
      >
        <AttentionCard
          item={{
            id: 'task-approval',
            kind: 'review_pending',
            title: 'Review this Task action',
            createdAt: '2026-11-05T00:00:00Z',
            updatedAt: '2026-11-05T00:00:00Z',
            source: { threadId: 'task-record' },
            openHref: '/?surface=activity',
            environmentKind: 'peer',
            environmentName: 'Receiver',
            viewerCanRespond: true,
            requestType: 'approval',
            peerRequestReference: {
              environmentId: 'receiver',
              taskId: 'delegated-run',
              requestId: 'task-request',
              requestType: 'approval',
              callerCanRespond: true,
            },
          }}
        />
      </ConversationConnectionProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toEqual({
      url:
        authority.apiBase +
        '/api/orchestration/delegations/delegated-run/respond',
      body: {
        requestId: 'task-request',
        environmentId: 'receiver',
        decision: label === 'Allow' ? 'accept' : 'decline',
      },
      authorization: 'Bearer scoped-fixture',
    });
  },
);

test('two Station approval parents with colliding request ids inspect and answer independently', async () => {
  const requests: Array<{ url: string; method: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? 'GET' });
      return Response.json({
        success: true,
        data:
          init?.method === 'POST'
            ? null
            : {
                ...open,
                body: url.includes('/A/')
                  ? 'Station A request'
                  : 'Station B request',
              },
      });
    }),
  );
  const station = (name: string) => ({
    ...conversationConnection('relay'),
    environmentId: name,
    targetApiBase: `${authority.apiBase}/api/environments/peers/${name}/chat-api`,
    requestScope: authority,
    runtimeKey: `runtime-${name}`,
  });
  const a = station('A'),
    b = station('B');
  mount(
    <>
      <ConversationConnectionProvider
        value={{
          apiBase: a.targetApiBase,
          station: a,
          requestScope: authority,
        }}
      >
        <ExactRequestInline reference={reference} />
      </ConversationConnectionProvider>
      <ConversationConnectionProvider
        value={{
          apiBase: b.targetApiBase,
          station: b,
          requestScope: authority,
        }}
      >
        <ExactRequestInline reference={reference} />
      </ConversationConnectionProvider>
    </>,
  );
  const rows = screen.getAllByTestId('exact-request-inline');
  for (const row of rows)
    fireEvent.click(within(row).getByRole('button', { name: 'Details' }));
  await screen.findByText('Station A request');
  await screen.findByText('Station B request');
  for (const row of rows) {
    const approve = within(row).getByRole('button', { name: 'Approve once' });
    await waitFor(() =>
      expect((approve as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(approve);
    await within(row).findByText(/Decision sent/);
  }
  expect(
    requests
      .filter((request) => request.method === 'POST')
      .map((request) => request.url),
  ).toEqual([
    `${a.targetApiBase}/api/orchestration/commands`,
    `${b.targetApiBase}/api/orchestration/commands`,
  ]);
  expect(requests.filter((request) => request.method === 'GET')).toHaveLength(
    2,
  );
});

test.each(['queued', 'unconfirmed', 'refused'] as const)(
  'the held-message parent preserves the %s observation and Check never resends',
  async (status) => {
    const entry: ConversationInboxEntry = {
      conversationId: 'conversation',
      clientTurnId: 'original-key',
      kind: 'follow-up',
      state: status,
      message: 'An ordered follow-up',
      updatedAt: '2026-11-05T00:00:00Z',
      createdAt: '2026-11-05T00:00:00Z',
      position: 1,
    };
    const refresh = vi.fn();
    const resend = vi.fn();
    const remove = vi.fn();
    mount(
      <QueuedMessages
        sessionId="held"
        messages={[]}
        held={{
          entries: [entry],
          unavailable: false,
          removing: false,
          removalError: false,
          onRemove: remove,
          onRetry: refresh,
          onResend: resend,
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /pending message/ }));
    expect(screen.getByText('An ordered follow-up')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    if (status === 'queued')
      expect(screen.getByRole('img', { name: 'Received' })).toBeTruthy();
    if (status === 'refused')
      expect(screen.getAllByText('Not sent').length).toBeGreaterThan(0);
    if (status === 'unconfirmed') {
      fireEvent.click(screen.getByRole('button', { name: 'Check' }));
      await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
      expect(resend).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Discard…' }));
      expect(remove).not.toHaveBeenCalled();
      fireEvent.click(
        screen.getByRole('button', { name: 'I checked, discard it' }),
      );
      await waitFor(() => expect(remove).toHaveBeenCalledWith('original-key'));
    }
  },
);
