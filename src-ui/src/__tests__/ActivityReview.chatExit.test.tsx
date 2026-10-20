/** @vitest-environment jsdom */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
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
import { useEffect } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  AuthorityHarness,
  authoritySwitch,
  installFakeLocks,
  removeLocks,
  settledStorageSnapshot,
} from '../contexts/__tests__/paneRelationsHarness';
import {
  ActivityReviewProvider,
  useActivityReview,
} from '../contexts/ActivityReviewContext';
import { chatDraftsStore } from '../contexts/chat-drafts-store';
import { KeyboardShortcutsProvider } from '../contexts/KeyboardShortcutsContext';
import { NavigationProvider } from '../contexts/NavigationContext';
import { navigationStore } from '../contexts/navigation-store';
import { openChatsStore } from '../contexts/open-chats-store';
import {
  PaneRelationsProvider,
  usePaneRelations,
} from '../contexts/PaneRelationsContext';
import {
  RegionModelProvider,
  useRegionModel,
} from '../contexts/RegionModelContext';
import { ToastProvider } from '../contexts/ToastContext';
import { UnsavedGuardOwnerContext } from '../contexts/UnsavedGuardOwnerContext';
import { useChatDockActions } from '../hooks/useChatDockActions';
import { MOBILE_MEDIA_QUERY } from '../hooks/useIsMobile';
import { deviceSettingsStore } from '../lib/device-settings-store';
import { writePaneFence } from '../regions/pane-fence';
import {
  PANE_RELATIONS_STORAGE_KEY,
  serializePaneRelations,
} from '../regions/pane-relations';
import {
  activityReviewInstance,
  prepareActivityReviewPane,
} from '../workspace-panes/activityReviewPane';
import { RegionActivityReviewPane } from '../workspace-panes/RegionActivityReviewPane';

const session: OrchestrationSessionSummary = {
  threadId: 'thread-review',
  conversationId: 'conversation-review',
  assignedAgentSlug: agentId('agent'),
  provider: 'claude',
  projectSlug: 'one',
  displayTitle: 'Reviewed conversation',
  controlMode: 'station-owned',
  status: 'ready',
  lifecycleState: 'needs_input',
  isLoaded: false,
  isPersisted: true,
  eventCount: 0,
  answerability: { answerable: true },
  createdAt: '2026-10-20T00:00:00.000Z',
  updatedAt: '2026-10-20T00:00:00.000Z',
};
const network = vi.hoisted(() => ({ apiBase: 'http://station.test' }));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: network.apiBase }),
  useHostRequestAuthorityScope: () => null,
}));
vi.mock('../contexts/AgentsContext', () => ({ useAgents: () => [] }));
vi.mock('../hooks/useActiveChatSessions', () => ({
  useCreateChatSession: () => vi.fn(),
  useOpenConversation: () => () => {
    throw new Error(
      'This fixture must focus its already open canonical conversation',
    );
  },
}));
vi.mock('../contexts/ActiveChatsContext', () => ({
  useActiveChatActions: () => ({ updateChat: vi.fn(), removeChat: vi.fn() }),
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
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  authenticatedFetch: async () =>
    new Response(JSON.stringify({ success: true, data: { session } })),
  useOrchestrationCommandReceiptsQuery: () => ({ data: [] }),
  useAttentionQuery: () => ({ data: [], refetch: vi.fn() }),
  useAcknowledgeAttentionItemMutation: () => ({ mutate: vi.fn() }),
  useSessionBuilderRunQuery: () => ({ data: undefined }),
  useSessionFlowRunQuery: () => ({ data: undefined }),
  useWorkflowTasksQuery: () => ({ data: [] }),
}));

let model: ReturnType<typeof useRegionModel>;
let relations: ReturnType<typeof usePaneRelations>;
let paneId = '';
let detach: (() => void) | undefined;

function Owner() {
  model = useRegionModel();
  relations = usePaneRelations();
  const review = useActivityReview();
  const actions = useChatDockActions({
    sessions: [
      {
        id: 'chat-review',
        conversationId: 'conversation-review',
        agentSlug: 'agent',
      },
    ],
    agents: [{ slug: agentId('agent'), name: 'Agent' }],
    activeSessionId: null,
    setActiveSessionId: () => {},
  });
  useEffect(
    () =>
      openChatsStore.registerNavigation({
        focus: () => {
          void actions.openConversation('conversation-review', 'agent');
        },
        openConversation: (id, current, options) =>
          actions.openConversation(id, 'agent', {
            isCurrent: current,
            beforeFocus: current,
            ...options,
          }),
        openCollection: () => {},
      }),
    [actions.openConversation],
  );
  useEffect(
    () =>
      review.publish({
        owner: 'activity-owner',
        apiBase: network.apiBase,
        stationId: 'station-a',
        opener: {
          occurrenceId: 'activity',
          label: 'Activity',
          source: { kind: 'activity', selectedThreadId: null },
        },
        items: [session],
        review: async () => ({ ok: false, reason: 'superseded' }),
        restoreFocus: () => {},
      }),
    [review.publish],
  );
  return null;
}

async function mount(phone = false) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: phone ? 390 : 1280,
  });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: phone && query === MOBILE_MEDIA_QUERY,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const prepared = prepareActivityReviewPane({
    version: 1,
    threadId: session.threadId,
    projectSlug: 'one',
    title: 'Review',
  });
  paneId = prepared.instanceId;
  prepared.prepare();
  writePaneFence(localStorage, paneId, 'station-a');
  localStorage.setItem(
    PANE_RELATIONS_STORAGE_KEY,
    serializePaneRelations({
      version: 1,
      entries: [
        {
          instanceId: paneId,
          stateKey: paneId,
          stationId: 'station-a',
          generation: 'builtin',
          kept: true,
          openedAt: 1,
          opener: {
            occurrenceId: 'activity',
            label: 'Activity',
            source: { kind: 'activity', selectedThreadId: null },
          },
          target: {
            kind: 'activity-session',
            threadId: session.threadId,
            projectSlug: 'one',
          },
        },
      ],
    }),
  );
  const instance = activityReviewInstance(paneId);
  if (!instance) throw new Error('Review fixture did not prepare');
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <KeyboardShortcutsProvider>
        <NavigationProvider>
          <AuthorityHarness initial={{ station: 'station-a' }}>
            <RegionModelProvider>
              <PaneRelationsProvider>
                <ActivityReviewProvider>
                  <ToastProvider>
                    <Owner />
                    <UnsavedGuardOwnerContext.Provider value={paneId}>
                      <RegionActivityReviewPane instance={instance} />
                    </UnsavedGuardOwnerContext.Provider>
                  </ToastProvider>
                </ActivityReviewProvider>
              </PaneRelationsProvider>
            </RegionModelProvider>
          </AuthorityHarness>
        </NavigationProvider>
      </KeyboardShortcutsProvider>
    </QueryClientProvider>,
  );
  detach = view.unmount;
  act(() => {
    model.placeSurface('chat', 'bottom');
    model.openSurfaceInRegion('chat');
    model.placeSurface(paneId, 'right');
    if (phone) model.openSurfaceInRegion(paneId);
  });
  await screen.findByRole('heading', { name: 'Reviewed conversation' });
}

function requestOpen() {
  fireEvent.click(screen.getByRole('button', { name: 'More review actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Open conversation' }));
}
beforeEach(() => {
  localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  network.apiBase = 'http://station.test';
  chatDraftsStore.clearActivityDraft(
    JSON.stringify(['activity-review', 'station-a', network.apiBase]),
    session.threadId,
  );
  installFakeLocks();
  window.history.replaceState({}, '', '/');
});
afterEach(() => {
  cleanup();
  removeLocks();
  vi.unstubAllGlobals();
});

test('canonical Chat reveal leaves a desktop sibling visible without asking its guard', async () => {
  await mount();
  const asked = vi.fn();
  const unregister = navigationStore.registerNavigationGuard(
    Symbol('review draft'),
    (_proceed, cancel) => {
      asked();
      cancel?.();
    },
    paneId,
  );
  try {
    requestOpen();
    await waitFor(() =>
      expect(navigationStore.getSnapshot().activeChat).toBe(
        'conversation-review',
      ),
    );
    expect(asked).not.toHaveBeenCalled();
    expect(model.readRegions().right.occupant).toBe(paneId);
  } finally {
    unregister();
  }
});

test('real SessionDetail dirty Close cannot consume a newly registered review owner', async () => {
  await mount();
  const draft = screen.getByRole('textbox', { name: 'Send input to session' });
  fireEvent.change(draft, { target: { value: 'Keep this real review reply' } });
  await waitFor(() => expect(relations.relationOf(paneId)?.kept).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: 'Close review' }));
  const dialog = await screen.findByRole('dialog', { name: 'Unsaved Changes' });
  const asked = vi.fn();
  const unregister = navigationStore.registerNavigationGuard(
    Symbol('new review owner'),
    (_proceed, cancel) => {
      asked();
      cancel?.();
    },
    paneId,
  );
  try {
    const before = await settledStorageSnapshot();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Unsaved Changes' }),
      ).toBeNull(),
    );
    expect(await settledStorageSnapshot()).toEqual(before);
    expect(model.readRegions().right.panes).toContain(paneId);
    expect((draft as HTMLTextAreaElement).value).toBe(
      'Keep this real review reply',
    );
    expect(asked).not.toHaveBeenCalled();
  } finally {
    unregister();
  }
});

test('a phone exit asks once before canonical Chat focus', async () => {
  await mount(true);
  const asked = vi.fn();
  const unregister = navigationStore.registerNavigationGuard(
    Symbol('review draft'),
    (proceed) => {
      asked();
      proceed();
    },
    paneId,
  );
  try {
    requestOpen();
    await waitFor(() =>
      expect(navigationStore.getSnapshot().activeChat).toBe(
        'conversation-review',
      ),
    );
    expect(asked).toHaveBeenCalledTimes(1);
    expect(model.readPhoneLayer()).toBeNull();
  } finally {
    unregister();
  }
});

test.each([
  'new guard',
  'hidden owner',
  'Station',
  'relation',
  'selection',
  'unmount',
])(
  'pending Chat exit refuses %s without navigation or storage changes',
  async (change) => {
    await mount(true);
    let proceed: (() => void) | undefined;
    const unregister = navigationStore.registerNavigationGuard(
      Symbol('draft'),
      (accept) => {
        proceed = accept;
      },
      paneId,
    );
    let unregisterNew = () => {};
    try {
      requestOpen();
      await waitFor(() => expect(proceed).toBeDefined());
      await act(async () => {
        if (change === 'new guard')
          unregisterNew = navigationStore.registerNavigationGuard(
            Symbol('new draft'),
            (accept) => accept(),
            paneId,
          );
        if (change === 'hidden owner')
          model.placeSurface('workspace-agents', 'bottom');
        if (change === 'Station') authoritySwitch.set?.('unverified');
        if (change === 'selection')
          relations.publishOpenerSelection(
            'activity',
            'activity:new-selection',
          );
        if (change === 'relation')
          await relations.transact((tx) => ({
            ok: true,
            value: tx.write({
              ...tx.record,
              entries: tx.record.entries.map((entry) => ({
                ...entry,
                opener: { ...entry.opener, label: 'Changed' },
              })),
            }),
          }));
        if (change === 'unmount') detach?.();
      });
      const before = await settledStorageSnapshot();
      const url = window.location.href;
      await act(async () => {
        proceed?.();
      });
      expect(window.location.href).toBe(url);
      expect(await settledStorageSnapshot()).toEqual(before);
    } finally {
      unregister();
      unregisterNew();
    }
  },
);

test('a covered owner changed in the guard callback is read from the committed model', async () => {
  await mount(true);
  const unregister = navigationStore.registerNavigationGuard(
    Symbol('same event'),
    (proceed) => {
      model.placeSurface('workspace-agents', 'bottom');
      proceed();
    },
    paneId,
  );
  try {
    requestOpen();
    await settledStorageSnapshot();
    expect(navigationStore.getSnapshot().activeChat).not.toBe(
      'conversation-review',
    );
    expect(model.readRegions().bottom.occupant).toBe('workspace-agents');
  } finally {
    unregister();
  }
});
