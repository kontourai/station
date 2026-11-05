// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, useState } from 'react';
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
}: {
  layout: 'desktop' | 'mobile';
  loadError: boolean;
  openConversation: Open;
  failures: (message: string) => void;
  acknowledge: (item: HomeWorkItem) => void;
}) {
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
    onOpenConversation: openConversation,
    onOpenSession: (id: string) =>
      navigationStore.navigate('/', { surface: 'activity', session: id }),
    onOpenFailed: failures,
    workFacts: new Map([
      ['first', { station: { id: 'receiver', label: 'Receiver Station' } }],
    ]),
    onAcknowledgeConversation: acknowledge,
    now: NOW,
  };
  const triggerRef = createRef<HTMLButtonElement>();
  return (
    <>
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
          items={items}
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
          tasks={items}
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
        />
      </AuthorityPersistenceContext.Provider>
    </QueryClientProvider>,
  );
  return { failures, acknowledge, unmount: rendered.unmount };
}

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
        screen.getByRole('button', { name: 'First selection, Workshop' }),
      );
      fireEvent.click(
        screen.getByRole('button', { name: 'Second selection, Workshop' }),
      );
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
        screen.getByRole('button', { name: 'First selection, Workshop' }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Toggle panel' }));
      fireEvent.click(screen.getByRole('button', { name: 'Toggle panel' }));
      await act(async () => resolves[0]!(false));
      expect(window.location.search).toBe('');
      fireEvent.click(
        screen.getByRole('button', { name: 'First selection, Workshop' }),
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
        screen.queryByRole('button', { name: 'First selection, Workshop' }),
      ).toBeNull();
      expect(
        screen.getByRole('button', { name: 'Second selection, Workshop' }),
      ).toBeTruthy();
      await user.clear(screen.getByRole('searchbox'));
      await user.type(screen.getByRole('searchbox'), 'reviewer');
      expect(
        screen.getByRole('button', { name: 'First selection, Workshop' }),
      ).toBeTruthy();
      await user.clear(screen.getByRole('searchbox'));
      await user.type(screen.getByRole('searchbox'), 'Workshop');
      expect(
        screen.getByRole('button', { name: 'First selection, Workshop' }),
      ).toBeTruthy();
      await user.clear(screen.getByRole('searchbox'));
      await user.type(screen.getByRole('searchbox'), 'Receiver Station');
      expect(
        screen.getByRole('button', { name: 'First selection, Workshop' }),
      ).toBeTruthy();
      expect(
        screen.queryByRole('button', { name: 'Second selection, Workshop' }),
      ).toBeNull();
      await user.clear(screen.getByRole('searchbox'));
      await user.type(screen.getByRole('searchbox'), 'missing');
      expect(screen.getByRole('button', { name: 'Clear filter' })).toBeTruthy();
      expect(
        screen.queryByRole('button', { name: 'First selection, Workshop' }),
      ).toBeNull();
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
        screen.getByRole('button', { name: 'First selection, Workshop' }),
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
        screen.getByRole('button', { name: 'First selection, Workshop' }),
      ).toBeTruthy();
      view.unmount();
      view = mount(layout, async () => true, 'principal-b');
      expect(
        screen.getByRole('button', { name: 'First selection, Workshop' }),
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
        screen.getByRole('button', { name: 'First selection, Workshop' }),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull(),
      );
      expect(
        screen.getByRole('button', { name: 'First selection, Workshop' }),
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
