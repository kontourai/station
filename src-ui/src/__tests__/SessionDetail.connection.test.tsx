// @vitest-environment jsdom
import { agentId } from '@kontourai/station-contracts/agent-identity';
import type {
  ConversationOpenResolution,
  OrchestrationConversationEventWindow,
  OrchestrationSessionSummary,
} from '@kontourai/station-contracts/orchestration';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { conversationConnection } from '../components/conversation/__tests__/fixtures';
import { SessionDetail } from '../components/session-detail/SessionDetail';
import { PreviewProvider } from '../contexts/PreviewContext';

const registry = vi.hoisted(() => ({ resolve: vi.fn(), remoteEnabled: true }));
vi.mock('../connections/StationConnectionsContext', () => ({
  useStationConnectionsOptional: () => registry,
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn(), dismissToast: vi.fn() }),
}));
vi.mock('../components/pull-requests/ConversationPullRequestLinks', () => ({
  ConversationPullRequestLinks: () => null,
}));
vi.mock('../hooks/orchestration/useSessionEventStream', () => ({
  useSessionEventStream: () => ({
    events: [],
    connected: true,
    historyLoaded: true,
    elidedHistory: { total: 0, byteLimit: 0, outputLimit: 0 },
  }),
}));
vi.mock('../hooks/orchestration/ensureOrchestrationEventStream', () => ({
  ensureOrchestrationEventStream: () => () => {},
}));
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  fetchSessionEventWindowCapability: async () => true,
  useAgentsQuery: () => ({ data: [] }),
  useAttentionQuery: () => ({
    data: { items: [] },
    isError: false,
    isLoading: false,
    refetch: vi.fn(),
  }),
  useOrchestrationCommandReceiptsQuery: () => ({ data: [] }),
  useWorkflowTasksQuery: () => ({ data: [] }),
  useSessionFlowRunQuery: () => ({ data: null }),
  useSessionBuilderRunQuery: () => ({ data: null }),
  useAcknowledgeAttentionItemMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

const sourceRecord: OrchestrationSessionSummary = {
  threadId: 'peer-record-on-source',
  conversationId: 'receiver-conversation',
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
  updatedAt: '2026-11-04T00:00:01Z',
  delegation: {
    taskId: 'peer-task',
    environmentKind: 'peer',
    environmentId: 'receiver',
    environmentName: 'Receiver',
  },
};
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

test.each([true, false])(
  'paired Task transcript uses authorized receiver reads: %s',
  async (authorized) => {
    const station = conversationConnection('relay');
    const release = vi.fn();
    registry.resolve.mockResolvedValue({ connection: station, release });
    setClientCredentialResolver(() => ({
      origin: station.requestScope.apiBase,
      credential: 'record-fixture',
      requestAuthority: {
        ...station.requestScope,
        isCurrent: station.isCurrent,
      },
    }));
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        urls.push(url);
        if (
          url ===
          `${station.targetApiBase}/api/conversations/receiver-conversation/open`
        ) {
          if (!authorized)
            return Response.json(
              { success: false, error: 'insufficient_scope' },
              { status: 403 },
            );
          const data: ConversationOpenResolution = {
            status: 'resolved',
            currentSessionId: 'receiver-execution',
            conversation: {
              id: 'receiver-conversation',
              source: 'runtime',
              title: 'Receiver task',
              agentSlug: agentId('reviewer'),
              createdAt: sourceRecord.createdAt,
              updatedAt: sourceRecord.updatedAt,
              messageCount: 2,
              mutable: false,
              answerability: { answerable: true },
            },
            transcript: { available: true, owner: 'runtime', messageCount: 2 },
            canContinue: false,
            callerAccess: { continue: false, startChat: false },
            answerability: { answerable: true },
            recoveryActions: [],
          };
          return Response.json({ success: true, data });
        }
        if (
          url.startsWith(
            `${station.targetApiBase}/api/orchestration/conversations/receiver-conversation/event-window?`,
          )
        ) {
          const data: OrchestrationConversationEventWindow = {
            protocolVersion: 1,
            conversationId: 'receiver-conversation',
            currentSessionId: 'receiver-execution',
            watermark: 2,
            hasMore: false,
            handoffs: [],
            contextBoundaries: [],
            session: {
              ...sourceRecord,
              threadId: 'receiver-execution',
              delegation: undefined,
            },
            events: [
              {
                sequence: 1,
                event: {
                  eventId: 'receiver-start',
                  method: 'turn.started',
                  provider: 'station-agent',
                  threadId: 'receiver-execution',
                  turnId: 'receiver-turn',
                  createdAt: sourceRecord.createdAt,
                  prompt: 'Read the receiver task.',
                },
              },
              {
                sequence: 2,
                event: {
                  eventId: 'receiver-end',
                  method: 'turn.completed',
                  provider: 'station-agent',
                  threadId: 'receiver-execution',
                  turnId: 'receiver-turn',
                  createdAt: sourceRecord.updatedAt,
                  outputText: 'Read through Receiver.',
                },
              },
            ],
          };
          return Response.json({ success: true, data });
        }
        throw new Error(`Unexpected record fixture request: ${url}`);
      }),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    clients.push(client);
    const view = render(
      <QueryClientProvider client={client}>
        <PreviewProvider>
          <SessionDetail
            apiBase="http://source.test"
            session={sourceRecord}
            onTaskChanged={() => {}}
            onAdopted={() => {}}
            getSelectionIntent={() => 0}
          />
        </PreviewProvider>
      </QueryClientProvider>,
    );
    if (authorized) {
      await screen.findByText('Read through Receiver.');
      expect(
        urls.some((url) => url.includes('/peer-record-on-source/event-window')),
      ).toBe(false);
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(screen.queryByTestId('session-peer-transcript-note')).toBeNull();
    } else {
      await screen.findByText('Station unavailable');
      expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
      expect(urls.some((url) => url.includes('/event-window'))).toBe(false);
      expect(screen.queryByText('insufficient_scope')).toBeNull();
    }
    view.unmount();
    expect(release).toHaveBeenCalledOnce();
  },
);
