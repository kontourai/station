/** @vitest-environment jsdom */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import type {
  AdoptedSessionResult,
  OrchestrationSessionSummary,
} from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import ImportedConversationPane from '../components/chat-dock/ImportedConversationPane';
import {
  AuthorityHarness,
  authoritySwitch,
} from '../contexts/__tests__/paneRelationsHarness';
import { activeChatsStore } from '../contexts/active-chats-store';
import { ToastProvider } from '../contexts/ToastContext';
import {
  attachedContinuationScope,
  handOffAttachedContinuation,
  takeAttachedContinuationHandoff,
} from '../lib/attached-continuation-handoff';

const boundary = vi.hoisted(() => ({
  adopt: vi.fn(),
  open: vi.fn(),
  send: vi.fn(),
}));

const source: OrchestrationSessionSummary = {
  threadId: 'external:claude:review-source',
  provider: 'claude',
  controlMode: 'read-only-attached',
  projectSlug: 'one',
  displayTitle: 'Review source',
  status: 'ready',
  lifecycleState: 'completed',
  isLoaded: false,
  isPersisted: true,
  eventCount: 0,
  answerability: {
    answerable: false,
    qualification: 'provider_absent',
    observedBy: 'review-fixture',
    observedAt: '2026-10-20T00:00:00.000Z',
  },
  createdAt: '2026-10-20T00:00:00.000Z',
  updatedAt: '2026-10-20T00:00:00.000Z',
  attachedSource: {
    kind: 'claude-transcript',
    externalSessionId: 'review-source',
    affinity: { kind: 'fixture-home', ref: 'review-source' },
  },
};
const child = {
  ...source,
  threadId: 'child',
  conversationId: 'child-conversation',
  assignedAgentSlug: agentId('agent'),
  controlMode: 'station-owned',
} satisfies OrchestrationSessionSummary & AdoptedSessionResult;

vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  useOrchestrationSessionQuery: (id: string) => ({
    data: id
      ? { session: id === 'child' ? child : { ...source, threadId: id } }
      : undefined,
    refetch: vi.fn(),
  }),
  adoptOrchestrationSession: (...args: unknown[]) => boundary.adopt(...args),
  getStarterWork: async () => ({ state: 'bound' }),
}));
vi.mock('../hooks/orchestration/useSessionEventStream', async () => {
  const { NO_ELIDED_HISTORY } = await import('../utils/elidedHistory');
  return {
    useSessionEventStream: () => ({
      events: [],
      connected: true,
      historyLoaded: true,
      elidedHistory: NO_ELIDED_HISTORY,
    }),
  };
});
vi.mock('../hooks/useActiveChatSessionMessaging', () => ({
  useSendMessage: () => boundary.send,
}));
vi.mock('../contexts/ActiveChatsContext', async () => {
  const { activeChatsStore } = await import('../contexts/active-chats-store');
  return {
    useActiveChatActions: () => ({
      updateChat: activeChatsStore.updateChat.bind(activeChatsStore),
    }),
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function mount(station = 'station-a') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = (
    threadId = source.threadId,
    apiBase = 'http://station.test',
  ) => (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <AuthorityHarness initial={{ station }}>
          <ImportedConversationPane
            threadId={threadId}
            apiBase={apiBase}
            onContinueInDock={boundary.open}
          />
        </AuthorityHarness>
      </ToastProvider>
    </QueryClientProvider>
  );
  const view = render(tree());
  return {
    ...view,
    changeSource: () => view.rerender(tree('external:claude:other')),
    changeApi: () => view.rerender(tree(source.threadId, 'http://other.test')),
  };
}

async function start() {
  fireEvent.change(await screen.findByRole('textbox', { name: 'Message' }), {
    target: { value: 'Exact review reply' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  const dialog = await screen.findByRole('dialog', { name: 'Continue here?' });
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Continue and send' }),
  );
  await waitFor(() => expect(boundary.adopt).toHaveBeenCalledTimes(1));
}

beforeEach(() => {
  localStorage.clear();
  activeChatsStore.initChat('child-tab', {
    conversationId: 'child-conversation',
    agentSlug: 'agent',
    agentName: 'Agent',
    title: 'Child',
  });
  boundary.adopt.mockReset();
  boundary.open.mockReset().mockResolvedValue(true);
  boundary.send.mockReset();
});
afterEach(() => {
  cleanup();
  activeChatsStore.removeChat('child-tab');
  vi.restoreAllMocks();
});

test.each(['unverified', 'Station B', 'unmount', 'source', 'api'])(
  'real recipient adoption after %s cannot open or send the old child',
  async (change) => {
    const adoption = deferred<AdoptedSessionResult>();
    boundary.adopt.mockReturnValue(adoption.promise);
    const view = mount();
    await start();
    act(() => {
      if (change === 'unverified') authoritySwitch.set?.('unverified');
      if (change === 'Station B')
        authoritySwitch.set?.({ station: 'station-b' });
      if (change === 'unmount') view.unmount();
      if (change === 'source') view.changeSource();
      if (change === 'api') view.changeApi();
    });
    await act(async () => {
      adoption.resolve(child);
      await adoption.promise;
    });
    expect(boundary.open).not.toHaveBeenCalled();
    expect(boundary.send).not.toHaveBeenCalled();
    expect(activeChatsStore.getSnapshot()['child-tab'].input ?? '').toBe('');
  },
);

test('a scope lost while canonical opening awaits cannot write the confirmed draft or send', async () => {
  boundary.adopt.mockResolvedValue(child);
  const opening = deferred<boolean>();
  boundary.open.mockReturnValue(opening.promise);
  mount();
  await start();
  await waitFor(() => expect(boundary.open).toHaveBeenCalledTimes(1));
  act(() => authoritySwitch.set?.('unverified'));
  await act(async () => {
    opening.resolve(true);
    await opening.promise;
  });
  expect(boundary.send).not.toHaveBeenCalled();
  expect(activeChatsStore.getSnapshot()['child-tab'].input ?? '').toBe('');
});

test('the real recipient takes a review handoff and continues only after confirmation', async () => {
  boundary.adopt.mockResolvedValue(child);
  handOffAttachedContinuation({
    threadId: source.threadId,
    draft: 'Exact review reply',
  });
  mount();
  const dialog = await screen.findByRole('dialog', { name: 'Continue here?' });
  expect(boundary.adopt).not.toHaveBeenCalled();
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Continue and send' }),
  );
  await waitFor(() => expect(boundary.send).toHaveBeenCalledTimes(1));
  expect(boundary.send).toHaveBeenCalledWith(
    'child-tab',
    'agent',
    'child-conversation',
    'Exact review reply',
  );
});

test('a handoff waits for its exact Station reader and never fills the other Station draft', async () => {
  const scope = attachedContinuationScope('station-a', 'http://station.test');
  handOffAttachedContinuation({
    threadId: source.threadId,
    draft: 'Only Station A',
    scope,
  });
  mount('station-b');
  expect(
    (
      (await screen.findByRole('textbox', {
        name: 'Message',
      })) as HTMLTextAreaElement
    ).value,
  ).toBe('');
  expect(screen.queryByRole('dialog', { name: 'Continue here?' })).toBeNull();
  act(() => authoritySwitch.set?.({ station: 'station-a' }));
  await screen.findByRole('dialog', { name: 'Continue here?' });
  expect(
    (
      screen.getByRole('textbox', {
        name: 'Message',
        hidden: true,
      }) as HTMLTextAreaElement
    ).value,
  ).toBe('Only Station A');
  expect(takeAttachedContinuationHandoff(source.threadId, scope)).toBeNull();
});
