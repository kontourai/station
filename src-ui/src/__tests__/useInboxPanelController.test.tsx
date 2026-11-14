// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ChatDockInboxPanel } from '../components/chat-dock/ChatDockInboxPanel';
import { MobileInboxPanel } from '../components/chat-dock/MobileInboxPanel';
import type { InboxPanelControllerOptions } from '../components/chat-dock/useInboxPanelController';
import { conversationStateKey } from '../connections/station-state';
import { AuthorityPersistenceContext } from '../contexts/AuthorityPersistenceContext';
import { navigationStore } from '../contexts/navigation-store';
import { toastStore } from '../contexts/ToastContext';
import { deviceSettingsStore } from '../lib/device-settings-store';
import { readSnoozes } from '../utils/activity-snooze-store';
import { readInboxDismissals } from '../utils/inbox-dismissal-store';
import type { HomeWorkItem } from '../views/home/home-view-model';
import { renderWithIsolatedConnections } from './renderWithIsolatedConnections';

const NOW = Date.parse('2026-11-05T00:00:00Z');
const item = (id: string, title: string): HomeWorkItem => ({
  id,
  conversationId: id,
  kind: 'orchestration',
  kindLabel: 'Session',
  title,
  projectLabel: 'Workshop',
  projectSlug: 'workshop',
  agentLabel: 'Reviewer',
  agentSlug: 'reviewer',
  modelLabel: 'Automatic',
  updatedAt: NOW - 60000,
  lifecycleLabel: 'Ready',
  orchestrationThreadId: id,
});
const items = [
  item('first', 'First selection'),
  item('second', 'Second selection'),
];
const clients: QueryClient[] = [];
beforeEach(() => {
  localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
});

type Open = InboxPanelControllerOptions['onOpenConversation'];
function Harness({
  layout,
  loadError,
  openConversation,
  failures,
  acknowledge,
  closeDuringOpen = false,
  bindDuringOpen = false,
}: {
  layout: 'desktop' | 'mobile';
  loadError: boolean;
  openConversation: Open;
  failures: (message: string) => void;
  acknowledge: (item: HomeWorkItem) => void;
  closeDuringOpen?: boolean;
  /** Opening binds a dock chat to the row, as the dock does (#4814). */
  bindDuringOpen?: boolean;
}) {
  const [rows, setRows] = useState(items);
  const [open, setOpen] = useState(true),
    [station, setStation] = useState('station-a'),
    [failed, setFailed] = useState(loadError);
  const authority = {
    apiBase: 'http://' + station,
    authorityKey: station,
    isCurrent: () => true,
  };
  const common = {
    authority,
    activeChatSessionId: null,
    openChatSessionIds: [],
    onFocusChat: (id: string) =>
      navigationStore.navigate('/projects/workshop', { chat: id }),
    onOpenConversation: (...args: Parameters<Open>) => {
      if (bindDuringOpen)
        setRows((current) =>
          current.map((row) =>
            row.id === args[0] ? { ...row, chatSessionId: 'dock-chat' } : row,
          ),
        );
      const outcome = openConversation(...args);
      if (closeDuringOpen) setOpen(false);
      return outcome;
    },
    onOpenSession: (id: string) =>
      navigationStore.navigate('/', { surface: 'activity', session: id }),
    onOpenFailed: failures,
    workFacts: new Map([
      ['first', { station: { id: 'receiver', label: 'Receiver Station' } }],
    ]),
    onAcknowledgeConversation: acknowledge,
    now: NOW,
  };
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
        Inbox
      </button>
      <button
        type="button"
        onClick={() => {
          const toast = toastStore
            .getSnapshot()
            .find((value) =>
              value.actions?.some((action) => action.label === 'Undo'),
            );
          if (toast) toastStore.runAction(toast.id, 0);
        }}
      >
        Undo dismissal
      </button>
      <button type="button" onClick={() => setOpen((value) => !value)}>
        Toggle panel
      </button>
      <button type="button" onClick={() => setStation('station-b')}>
        Switch Station
      </button>
      {layout === 'desktop' ? (
        <ChatDockInboxPanel
          {...common}
          items={rows}
          exiting={!open}
          onCloseChat={() => {}}
          onOpenHistory={() => {}}
          sync={{
            failed,
            refreshing: false,
            onRefresh: () => setFailed(false),
          }}
        />
      ) : (
        <MobileInboxPanel
          {...common}
          tasks={rows}
          open={open}
          triggerRef={triggerRef}
          onClose={() => setOpen(false)}
          loadError={failed}
          onRetryLoad={() => setFailed(false)}
        />
      )}
    </>
  );
}

function mount(
  layout: 'desktop' | 'mobile',
  openConversation: Open,
  namespace = 'principal-a',
  loadError = false,
  closeDuringOpen = false,
  bindDuringOpen = false,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const failures = vi.fn(),
    acknowledge = vi.fn();
  const rendered = renderWithIsolatedConnections(
    <QueryClientProvider client={client}>
      <AuthorityPersistenceContext.Provider
        value={{ status: 'verified', namespace, observation: null }}
      >
        <Harness
          layout={layout}
          loadError={loadError}
          openConversation={openConversation}
          failures={failures}
          acknowledge={acknowledge}
          closeDuringOpen={closeDuringOpen}
          bindDuringOpen={bindDuringOpen}
        />
      </AuthorityPersistenceContext.Provider>
    </QueryClientProvider>,
  );
  return { failures, acknowledge, unmount: rendered.unmount };
}

test('mobile search focuses when mounted and never steals a later keyboard selection', async () => {
  const open = vi.fn<Open>(async () => true);
  mount('mobile', open);
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  fireEvent.click(screen.getByRole('button', { name: 'Search inbox' }));
  const search = screen.getByRole('searchbox');
  expect(document.activeElement).toBe(search);
  const row = screen.getByRole('button', {
    name: 'First selection, Workshop, Station: Receiver Station',
  });
  row.focus();
  act(() =>
    frames.splice(0).forEach((callback) => callback(performance.now())),
  );
  expect(document.activeElement).toBe(row);
  await userEvent.setup().keyboard('{Enter}');
  expect(open).toHaveBeenCalledTimes(1);
  expect(open.mock.calls[0]?.[0]).toBe('first');
});

test('mobile restores focus when the host closes Inbox while opening its reader', async () => {
  mount(
    'mobile',
    vi.fn<Open>(async () => true),
    'principal-a',
    false,
    true,
  );
  const trigger = screen.getByRole('button', { name: 'Inbox' });
  trigger.focus();
  const user = userEvent.setup();
  await user.click(
    screen.getByRole('button', { name: 'Second selection, Workshop' }),
  );
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(screen.queryByRole('region', { name: 'Inbox' })).toBeNull();
});

for (const layout of ['desktop', 'mobile'] as const) {
  test(
    layout + ' retires an out-of-order open before focus and route commit',
    async () => {
      const resolves = new Map<string, () => void>();
      const open = vi.fn<Open>(
        (
          id,
          _agent,
          _project,
          _name,
          _model,
          _updated,
          _accepted,
          activation,
        ) =>
          new Promise<Awaited<ReturnType<Open>>>((resolve) => {
            resolves.set(id, () => {
              if (activation?.isCurrent?.() && activation.beforeFocus?.()) {
                navigationStore.navigate('/projects/workshop', { chat: id });
                resolve(true);
              } else resolve('cancelled');
            });
          }),
      );
      const { acknowledge } = mount(layout, open);
      fireEvent.click(
        screen.getByRole('button', {
          name: 'First selection, Workshop, Station: Receiver Station',
        }),
      );
      fireEvent.click(
        screen.getByRole('button', { name: 'Second selection, Workshop' }),
      );
      const firstActivation = open.mock.calls[0]?.[7];
      expect(firstActivation?.isCurrent?.()).toBe(true);
      expect(firstActivation?.beforeFocus?.()).toBe(false);
      await act(async () => resolves.get('second')!());
      expect(new URL(window.location.href).searchParams.get('chat')).toBe(
        'second',
      );
      await act(async () => resolves.get('first')!());
      expect(new URL(window.location.href).searchParams.get('chat')).toBe(
        'second',
      );
      expect(acknowledge).toHaveBeenCalledTimes(1);
      expect(acknowledge).toHaveBeenCalledWith(items[1]);
      fireEvent.click(screen.getByRole('button', { name: 'Switch Station' }));
      expect(firstActivation?.isCurrent?.()).toBe(false);
    },
  );

  test(
    layout +
      ' cancels closed and old-Station activation leases, including fallback navigation',
    async () => {
      const resolves: Array<(value: boolean) => void> = [];
      const open = vi.fn<Open>(
        () => new Promise<boolean>((resolve) => resolves.push(resolve)),
      );
      const { failures, acknowledge } = mount(layout, open);
      fireEvent.click(
        screen.getByRole('button', {
          name: 'First selection, Workshop, Station: Receiver Station',
        }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Toggle panel' }));
      fireEvent.click(screen.getByRole('button', { name: 'Toggle panel' }));
      await act(async () => resolves[0]!(false));
      expect(window.location.search).toBe('');
      fireEvent.click(
        screen.getByRole('button', {
          name: 'First selection, Workshop, Station: Receiver Station',
        }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Switch Station' }));
      await act(async () => resolves[1]!(false));
      expect(window.location.search).toBe('');
      expect(acknowledge).not.toHaveBeenCalled();
      expect(failures).not.toHaveBeenCalled();
    },
  );

  test(
    layout +
      ' searches title, Project, agent and Station through the real shell',
    async () => {
      mount(layout, async () => true);
      const user = userEvent.setup();
      if (layout === 'mobile')
        await user.click(screen.getByRole('button', { name: 'Search inbox' }));
      await user.type(screen.getByRole('searchbox'), 'second');
      expect(
        screen.queryByRole('button', {
          name: 'First selection, Workshop, Station: Receiver Station',
        }),
      ).toBeNull();
      expect(
        screen.getByRole('button', { name: 'Second selection, Workshop' }),
      ).toBeTruthy();
      await user.clear(screen.getByRole('searchbox'));
      await user.type(screen.getByRole('searchbox'), 'reviewer');
      expect(
        screen.getByRole('button', {
          name: 'First selection, Workshop, Station: Receiver Station',
        }),
      ).toBeTruthy();
      await user.clear(screen.getByRole('searchbox'));
      await user.type(screen.getByRole('searchbox'), 'Workshop');
      expect(
        screen.getByRole('button', {
          name: 'First selection, Workshop, Station: Receiver Station',
        }),
      ).toBeTruthy();
      await user.clear(screen.getByRole('searchbox'));
      await user.type(screen.getByRole('searchbox'), 'Receiver Station');
      expect(
        screen.getByRole('button', {
          name: 'First selection, Workshop, Station: Receiver Station',
        }),
      ).toBeTruthy();
      expect(
        screen.queryByRole('button', { name: 'Second selection, Workshop' }),
      ).toBeNull();
      await user.clear(screen.getByRole('searchbox'));
      await user.type(screen.getByRole('searchbox'), 'missing');
      expect(screen.getByRole('button', { name: 'Clear filter' })).toBeTruthy();
      expect(
        screen.queryByRole('button', {
          name: 'First selection, Workshop, Station: Receiver Station',
        }),
      ).toBeNull();
    },
  );

  test(
    layout +
      ' keeps the selection current when the open binds a chat to its row (#4814)',
    async () => {
      // The dock binds its new chat to the row before focusing it; the
      // row's chatSessionId changes under the selection.
      const open = vi.fn<Open>(async (...args) => {
        // Let the bind re-render the panel before the dock focuses.
        await new Promise((settle) => setTimeout(settle, 20));
        return args[7]?.beforeFocus?.() === false ? 'unavailable' : true;
      });
      const { failures, acknowledge } = mount(
        layout,
        open,
        'principal-a',
        false,
        false,
        true,
      );
      fireEvent.click(
        screen.getByRole('button', {
          name: 'First selection, Workshop, Station: Receiver Station',
        }),
      );
      await waitFor(() => expect(acknowledge).toHaveBeenCalledOnce());
      expect(acknowledge.mock.calls[0]?.[0]).toMatchObject({ id: 'first' });
      expect(failures).not.toHaveBeenCalled();
    },
  );

  test(
    layout + ' reports an open that ends unavailable while still current',
    async () => {
      const { failures, acknowledge } = mount(
        layout,
        async () => 'unavailable' as const,
      );
      fireEvent.click(
        screen.getByRole('button', {
          name: 'First selection, Workshop, Station: Receiver Station',
        }),
      );
      await waitFor(() => expect(failures).toHaveBeenCalledOnce());
      expect(failures.mock.calls[0]?.[0]).toEqual(expect.any(String));
      expect(acknowledge).not.toHaveBeenCalled();
    },
  );

  test(
    layout +
      ' translates unknown activation failures without raw transport copy',
    async () => {
      const { failures } = mount(layout, async () => {
        throw new Error('unsafe-secret-machine-diagnostic');
      });
      fireEvent.click(
        screen.getByRole('button', {
          name: 'First selection, Workshop, Station: Receiver Station',
        }),
      );
      await waitFor(() => expect(failures).toHaveBeenCalledOnce());
      expect(failures.mock.calls[0]?.[0]).not.toContain('unsafe-secret');
    },
  );
}

for (const layout of ['desktop', 'mobile'] as const) {
  test(
    layout +
      ' snoozes, wakes, dismisses and undoes without affecting another principal',
    async () => {
      let view = mount(layout, async () => true);
      const user = userEvent.setup();
      if (layout === 'mobile') {
        await user.click(
          screen.getByRole('button', { name: 'Details for First selection' }),
        );
        await user.click(await screen.findByRole('button', { name: '1 hour' }));
      } else {
        await user.click(
          screen.getByRole('button', { name: 'Snooze First selection' }),
        );
        await user.click(screen.getByRole('menuitem', { name: '1 hour' }));
      }
      expect(readSnoozes(NOW, 'principal-a').first).toBe(NOW + 3600000);
      expect(readSnoozes(NOW, 'principal-b')).toEqual({});
      await user.click(screen.getByRole('button', { name: 'Snoozed · 1' }));
      if (layout === 'mobile') {
        await user.click(
          screen.getByRole('button', { name: 'Details for First selection' }),
        );
        await user.click(
          await screen.findByRole('button', { name: 'Unsnooze' }),
        );
      } else
        await user.click(
          screen.getByRole('button', { name: 'Unsnooze First selection' }),
        );
      expect(readSnoozes(NOW, 'principal-a')).toEqual({});
      if (layout === 'mobile') {
        await user.click(
          screen.getByRole('button', { name: 'Details for First selection' }),
        );
        await user.click(
          await screen.findByRole('button', { name: 'Dismiss from inbox' }),
        );
      } else
        await user.click(
          screen.getByRole('button', {
            name: 'Dismiss First selection from inbox',
          }),
        );
      expect(Object.keys(readInboxDismissals('principal-a'))).toHaveLength(1);
      expect(readInboxDismissals('principal-b')).toEqual({});
      await user.click(screen.getByRole('button', { name: 'Undo dismissal' }));
      expect(readInboxDismissals('principal-a')).toEqual({});
      expect(
        screen.getByRole('button', {
          name: 'First selection, Workshop, Station: Receiver Station',
        }),
      ).toBeTruthy();
      view.unmount();
      view = mount(layout, async () => true, 'principal-b');
      expect(
        screen.getByRole('button', {
          name: 'First selection, Workshop, Station: Receiver Station',
        }),
      ).toBeTruthy();
    },
  );
}

for (const layout of ['desktop', 'mobile'] as const) {
  test(
    layout +
      ' keeps the last list visible while Retry recovers a failed refresh',
    async () => {
      mount(layout, async () => true, 'principal-a', true);
      expect(
        screen.getByRole('button', {
          name: 'First selection, Workshop, Station: Receiver Station',
        }),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull(),
      );
      expect(
        screen.getByRole('button', {
          name: 'First selection, Workshop, Station: Receiver Station',
        }),
      ).toBeTruthy();
    },
  );
}

for (const remote of [false, true]) {
  test(
    'principal-scoped preferences survive ' +
      (remote ? 'receiver' : 'host') +
      ' conversation promotion through the mounted parent',
    async () => {
      const binding = remote
        ? {
            version: 1 as const,
            environmentId: 'receiver',
            stationName: 'Receiver',
            affinity: {
              kind: 'device' as const,
              connectionId: 'receiver-device',
              principalNamespace: 'paired-person',
            },
          }
        : undefined;
      const draft: HomeWorkItem = {
        ...item('draft', 'Promoted chat'),
        id: conversationStateKey(binding, 'draft'),
        kind: 'chat',
        kindLabel: 'Direct chat',
        chatSessionId: 'draft',
        conversationId: undefined,
        orchestrationThreadId: undefined,
      };
      const props = {
        activeChatSessionId: null,
        openChatSessionIds: ['draft'],
        onFocusChat: () => {},
        onOpenConversation: async () => true,
        onOpenSession: () => {},
        onCloseChat: () => {},
        onOpenHistory: () => {},
        now: NOW,
      };
      const client = new QueryClient();
      clients.push(client);
      const view = (row: HomeWorkItem) => (
        <QueryClientProvider client={client}>
          <AuthorityPersistenceContext.Provider
            value={{
              status: 'verified',
              namespace: 'principal-a',
              observation: null,
            }}
          >
            <ChatDockInboxPanel
              {...props}
              items={[row]}
              workFacts={
                new Map([
                  [row.id, { chatBinding: binding, hostDetails: !remote }],
                ])
              }
            />
          </AuthorityPersistenceContext.Provider>
        </QueryClientProvider>
      );
      const mounted = renderWithIsolatedConnections(view(draft));
      fireEvent.click(
        screen.getByRole('button', { name: 'Snooze Promoted chat' }),
      );
      fireEvent.click(screen.getByRole('menuitem', { name: '1 hour' }));
      expect(readSnoozes(NOW, 'principal-a')[draft.id]).toBe(NOW + 3600000);
      const durable = {
        ...draft,
        id: conversationStateKey(binding, 'durable'),
        conversationId: 'durable',
      };
      mounted.rerender(view(durable));
      await waitFor(() =>
        expect(readSnoozes(NOW, 'principal-a')[durable.id]).toBe(NOW + 3600000),
      );
      expect(readSnoozes(NOW, 'principal-a')[draft.id]).toBeUndefined();
      expect(readSnoozes(NOW, 'principal-b')).toEqual({});
    },
  );
}
