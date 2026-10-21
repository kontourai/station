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
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  LayoutChatPlacementContext,
  requestCenterChatPage,
  subscribeCenterChatPageRequests,
} from '../app-shell/chat-placement';
import ImportedConversationPane from '../components/chat-dock/ImportedConversationPane';
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
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import {
  attachedContinuationScope,
  discardAttachedContinuationHandoff,
  handOffAttachedContinuation,
  takeAttachedContinuationHandoff,
} from '../lib/attached-continuation-handoff';
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
const attachedSession: OrchestrationSessionSummary = {
  ...session,
  controlMode: 'read-only-attached',
  lifecycleState: 'completed',
  answerability: {
    answerable: false,
    qualification: 'provider_absent',
    observedBy: 'review-fixture',
    observedAt: '2026-10-20T00:00:00.000Z',
  },
  attachedSource: {
    kind: 'claude-transcript',
    externalSessionId: 'review-source',
    affinity: { kind: 'fixture-home', ref: 'review-source' },
  },
};
const network = vi.hoisted(() => ({
  apiBase: 'http://station.test',
  attached: false,
}));
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
vi.mock('../hooks/useActiveChatSessionMessaging', () => ({
  useSendMessage: () => () => {
    throw new Error(
      'This handoff fixture must not dispatch a provider message',
    );
  },
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
    new Response(
      JSON.stringify({
        success: true,
        data: { session: network.attached ? attachedSession : session },
      }),
    ),
  useOrchestrationSessionQuery: (threadId: string) => {
    if (threadId && threadId !== session.threadId)
      throw new Error(`Unexpected reader Session: ${threadId}`);
    return {
      data: threadId ? { session: attachedSession } : undefined,
      refetch: vi.fn(),
    };
  },
  adoptOrchestrationSession: () => {
    throw new Error('This handoff fixture must not launch a continuation');
  },
  getStarterWork: async () => ({ state: 'bound' }),
  useOrchestrationCommandReceiptsQuery: () => ({ data: [] }),
  useAttentionQuery: () => ({ data: [], refetch: vi.fn() }),
  useAcknowledgeAttentionItemMutation: () => ({ mutate: vi.fn() }),
  useSessionBuilderRunQuery: () => ({ data: undefined }),
  useSessionFlowRunQuery: () => ({ data: undefined }),
  useWorkflowTasksQuery: () => ({ data: [] }),
}));

let model: ReturnType<typeof useRegionModel>;
let relations: ReturnType<typeof usePaneRelations>;
let reviewApi: ReturnType<typeof useActivityReview>;
let paneId = '';
let detach: (() => void) | undefined;

function Owner() {
  model = useRegionModel();
  relations = usePaneRelations();
  const review = useActivityReview();
  reviewApi = review;
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
        items: [network.attached ? attachedSession : session],
        review: async () => ({ ok: false, reason: 'superseded' }),
        restoreFocus: () => {},
      }),
    [review.publish],
  );
  return null;
}

function OtherDirtyWork() {
  const [text, setText] = useState('');
  const { DiscardModal } = useUnsavedGuard(text.length > 0);
  return (
    <>
      <textarea
        aria-label="Other work in this pane"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <DiscardModal />
    </>
  );
}

async function mount(
  phone = false,
  options: {
    center?: boolean;
    attached?: boolean;
    otherDirty?: boolean;
    recipient?: boolean;
  } = {},
) {
  network.attached = options.attached ?? false;
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
                  <LayoutChatPlacementContext.Provider
                    value={options.center ? 'center' : 'none'}
                  >
                    <ToastProvider>
                      <Owner />
                      <UnsavedGuardOwnerContext.Provider value={paneId}>
                        <RegionActivityReviewPane instance={instance} />
                        {options.otherDirty && <OtherDirtyWork />}
                      </UnsavedGuardOwnerContext.Provider>
                      {options.recipient && (
                        <ImportedConversationPane
                          threadId={session.threadId}
                          apiBase={network.apiBase}
                          onContinueInDock={() => {
                            throw new Error(
                              'This fixture stops at recipient confirmation',
                            );
                          }}
                        />
                      )}
                    </ToastProvider>
                  </LayoutChatPlacementContext.Provider>
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
  await within(
    screen.getByRole('region', { name: 'Activity quick review' }),
  ).findByRole('heading', { name: 'Reviewed conversation' });
}

function requestOpen() {
  fireEvent.click(screen.getByRole('button', { name: 'More review actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Open conversation' }));
}
beforeEach(() => {
  localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  network.apiBase = 'http://station.test';
  network.attached = false;
  discardAttachedContinuationHandoff(
    session.threadId,
    attachedContinuationScope('station-a', network.apiBase),
  );
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

test('a centre receiver removed while a phone guard waits refuses before restoration', async () => {
  await mount(true, { center: true });
  const requested = vi.fn();
  const removeReceiver = subscribeCenterChatPageRequests(requested);
  let proceed: (() => void) | undefined;
  const unregister = navigationStore.registerNavigationGuard(
    Symbol('pending centre exit'),
    (accept) => {
      proceed = accept;
    },
    paneId,
  );
  try {
    requestOpen();
    await waitFor(() => expect(proceed).toBeDefined());
    removeReceiver();
    const before = await settledStorageSnapshot();
    const layer = model.readPhoneLayer();
    const regions = structuredClone(model.readRegions());
    const url = window.location.href;
    await act(async () => {
      proceed?.();
    });
    expect(model.readPhoneLayer()).toEqual(layer);
    expect(model.readRegions()).toEqual(regions);
    expect(window.location.href).toBe(url);
    expect(await settledStorageSnapshot()).toEqual(before);
    expect(requested).not.toHaveBeenCalled();
    expect(navigationStore.getSnapshot().activeChat).not.toBe(
      'conversation-review',
    );
  } finally {
    removeReceiver();
    unregister();
  }
});

test('a centre Chat request keeps the review selected in the shared dock region', async () => {
  await mount(false, { center: true });
  act(() => {
    model.placeSurface(paneId, 'bottom');
    model.openSurfaceInRegion(paneId);
  });
  const requested = vi.fn();
  const removeReceiver = subscribeCenterChatPageRequests(requested);
  try {
    requestOpen();
    await waitFor(() =>
      expect(navigationStore.getSnapshot().activeChat).toBe(
        'conversation-review',
      ),
    );
    expect(requested).toHaveBeenCalledTimes(1);
    expect(model.readRegions().bottom.occupant).toBe(paneId);
  } finally {
    removeReceiver();
  }
});

test('phone attached Send carries its reply but still asks other dirty work owned by the same pane', async () => {
  await mount(true, { attached: true, otherDirty: true, recipient: true });
  const review = within(
    screen.getByRole('region', { name: 'Activity quick review' }),
  );
  const message = await review.findByRole('textbox', { name: 'Message' });
  fireEvent.change(message, {
    target: { value: 'Only the submitted reply moves' },
  });
  fireEvent.change(
    screen.getByRole('textbox', { name: 'Other work in this pane' }),
    {
      target: { value: 'A separate unsaved edit' },
    },
  );
  fireEvent.click(review.getByRole('button', { name: 'Send message' }));
  const layer = model.readPhoneLayer();
  const discard = await screen.findByRole('dialog', {
    name: 'Unsaved Changes',
  });
  fireEvent.click(within(discard).getByRole('button', { name: 'Cancel' }));
  await waitFor(() =>
    expect(
      (
        review.getByRole('button', {
          name: 'Send message',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  expect(model.readPhoneLayer()).toEqual(layer);
  expect((message as HTMLTextAreaElement).value).toBe(
    'Only the submitted reply moves',
  );
  expect(screen.queryByRole('dialog', { name: 'Continue here?' })).toBeNull();
  fireEvent.click(review.getByRole('button', { name: 'Send message' }));
  const secondDecision = await screen.findByRole('dialog', {
    name: 'Unsaved Changes',
  });
  fireEvent.click(
    within(secondDecision).getByRole('button', { name: 'Discard' }),
  );
  await screen.findByRole('dialog', { name: 'Continue here?' });
  expect(screen.queryByRole('dialog', { name: 'Unsaved Changes' })).toBeNull();
  expect(model.readPhoneLayer()).toBeNull();
  const recipient = within(
    screen.getByRole('region', { name: 'Conversation' }),
  );
  expect(
    (
      recipient.getByRole('textbox', {
        name: 'Message',
        hidden: true,
      }) as HTMLTextAreaElement
    ).value,
  ).toBe('Only the submitted reply moves');
  expect(
    chatDraftsStore.getActivityDraft(
      JSON.stringify(['activity-review', 'station-a', network.apiBase]),
      session.threadId,
    ),
  ).toBe('');
});

test('a new closing-owner guard registered by the centre request prevents restoration', async () => {
  await mount(true, { center: true });
  const requested = vi.fn();
  const asked = vi.fn();
  let unregisterNew = () => {};
  const removeReceiver = subscribeCenterChatPageRequests(() => {
    requested();
    unregisterNew = navigationStore.registerNavigationGuard(
      Symbol('new centre work'),
      (_accept, cancel) => {
        asked();
        cancel?.();
      },
      paneId,
    );
  });
  try {
    const before = await settledStorageSnapshot();
    const layer = model.readPhoneLayer();
    const regions = structuredClone(model.readRegions());
    const url = window.location.href;
    requestOpen();
    await waitFor(() => expect(requested).toHaveBeenCalledTimes(1));
    expect(await settledStorageSnapshot()).toEqual(before);
    expect(model.readPhoneLayer()).toEqual(layer);
    expect(model.readRegions()).toEqual(regions);
    expect(window.location.href).toBe(url);
    expect(asked).not.toHaveBeenCalled();
    expect(navigationStore.getSnapshot().activeChat).not.toBe(
      'conversation-review',
    );
  } finally {
    removeReceiver();
    unregisterNew();
  }
});

test('an admitted transfer resolves true after its commit clears the submitted draft', async () => {
  await mount(true, { center: true });
  const scope = JSON.stringify([
    'carrier-result',
    'station-a',
    network.apiBase,
  ]);
  chatDraftsStore.setActivityDraft(
    scope,
    session.threadId,
    'Carried exactly once',
  );
  const identity = Symbol('carried reply guard');
  const asked = vi.fn();
  const unregister = navigationStore.registerNavigationGuard(
    identity,
    (_accept, cancel) => {
      asked();
      cancel?.();
    },
    paneId,
  );
  const requested = vi.fn();
  const removeReceiver = subscribeCenterChatPageRequests(requested);
  try {
    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await reviewApi.reveal(
        paneId,
        'chat',
        (current) => {
          if (!current()) throw new Error('Transfer was not admitted');
          handOffAttachedContinuation({
            threadId: session.threadId,
            draft: 'Carried exactly once',
            scope: attachedContinuationScope('station-a', network.apiBase),
          });
          chatDraftsStore.clearActivityDraft(scope, session.threadId);
        },
        () => true,
        {
          transfer: {
            guard: { identity, owner: paneId },
            current: () =>
              chatDraftsStore.getActivityDraft(scope, session.threadId) ===
              'Carried exactly once',
          },
          destination: { kind: 'center-chat', reveal: requestCenterChatPage },
        },
      );
    });
    expect(accepted).toBe(true);
    expect(asked).not.toHaveBeenCalled();
    expect(requested).toHaveBeenCalledTimes(1);
    expect(model.readPhoneLayer()).toBeNull();
    expect(chatDraftsStore.getActivityDraft(scope, session.threadId)).toBe('');
    expect(
      takeAttachedContinuationHandoff(
        session.threadId,
        attachedContinuationScope('station-a', network.apiBase),
      ),
    ).toBe('Carried exactly once');
  } finally {
    unregister();
    removeReceiver();
    chatDraftsStore.clearActivityDraft(scope, session.threadId);
  }
});
