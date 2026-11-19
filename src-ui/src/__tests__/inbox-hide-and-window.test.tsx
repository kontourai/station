// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatDockInboxPanel } from '../components/chat-dock/ChatDockInboxPanel';
import { InboxDismissUndo } from '../components/chat-dock/inbox-dismissals';
import { ConversationWorkStateProvider } from '../components/chat-dock/useConversationWorkState';
import { NotificationContainer } from '../components/notifications/NotificationContainer';
import { KeyboardShortcutsProvider } from '../contexts/KeyboardShortcutsContext';
import { ToastProvider, toastStore } from '../contexts/ToastContext';
import { deviceSettingsStore } from '../lib/device-settings-store';
import type { HomeWorkItem } from '../views/home/home-view-model';

/**
 * The inbox's Open and Settled preview against a fake host that keeps the
 * per-person state the way the work-state routes do: settled conversations
 * and hidden third-party Sessions, read back on every fetch.
 */
const host = vi.hoisted(() => ({
  preview: true,
  supportsHidden: true,
  settled: {} as Record<string, string>,
  hidden: {} as Record<string, string>,
  hideCalls: [] as { sessionId: string; hidden: boolean }[],
  scope: {
    apiBase: 'http://localhost',
    authorityKey: 'owner',
    isCurrent: () => true,
  },
}));

vi.mock('@kontourai/station-sdk/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk/client')>()),
  getConversationWorkState: vi.fn(async () =>
    host.preview
      ? {
          settled: { ...host.settled },
          ...(host.supportsHidden ? { hidden: { ...host.hidden } } : {}),
        }
      : null,
  ),
  setConversationWorkState: vi.fn(
    async (_api: string, id: string, settled: boolean) => {
      if (settled) host.settled[id] = new Date().toISOString();
      else delete host.settled[id];
    },
  ),
  setConversationInboxHidden: vi.fn(
    async (_api: string, sessionId: string, hidden: boolean) => {
      host.hideCalls.push({ sessionId, hidden });
      if (sessionId === 'gone-thread')
        throw Object.assign(new Error('Session not found'), { status: 404 });
      if (hidden) host.hidden[sessionId] = new Date().toISOString();
      else delete host.hidden[sessionId];
    },
  ),
}));
vi.mock('../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () =>
    new Set(host.preview ? ['conversation-resolution'] : []),
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost' }),
  useHostRequestAuthorityScope: () => host.scope,
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigationActions: () => ({ navigate: vi.fn() }),
}));
vi.mock('../contexts/ProjectsContext', () => ({
  useProjects: () => ({ projects: [] }),
}));

const NOW = Date.parse('2026-11-10T18:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const owned: HomeWorkItem = {
  id: 'owned',
  conversationId: 'owned',
  kind: 'orchestration',
  kindLabel: 'Conversation',
  title: 'Owned chat',
  projectLabel: 'Station',
  agentLabel: 'Codex',
  modelLabel: 'GPT',
  lifecycleLabel: 'Completed',
  updatedAt: NOW - 1000,
};
const external: HomeWorkItem = {
  ...owned,
  id: 'external-thread',
  conversationId: undefined,
  title: 'Outside session',
  controlMode: 'read-only-attached',
  lifecycleLabel: 'Running',
};

function Inbox({ items }: { items: HomeWorkItem[] }) {
  return (
    <ToastProvider>
      <KeyboardShortcutsProvider>
        <ConversationWorkStateProvider>
          <InboxDismissUndo>
            <ChatDockInboxPanel
              items={items}
              now={NOW}
              activeChatSessionId={null}
              openChatSessionIds={[]}
              onFocusChat={vi.fn()}
              onOpenConversation={vi.fn()}
              onOpenSession={vi.fn()}
              onCloseChat={vi.fn()}
              onOpenHistory={vi.fn()}
            />
            <NotificationContainer />
          </InboxDismissUndo>
        </ConversationWorkStateProvider>
      </KeyboardShortcutsProvider>
    </ToastProvider>
  );
}

/** A fresh client per mount: a reload, or another of the person's devices. */
function mount(items: HomeWorkItem[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <Inbox items={items} />
    </QueryClientProvider>,
  );
  return {
    ...view,
    rerenderWith: (next: HomeWorkItem[]) =>
      view.rerender(
        <QueryClientProvider client={client}>
          <Inbox items={next} />
        </QueryClientProvider>,
      ),
  };
}

const row = (title: string, container: HTMLElement = document.body) =>
  within(container).queryByRole('button', {
    name: new RegExp(`^${title}(?:\\s|$)`),
  });
const search = (value: string) =>
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search inbox' }), {
    target: { value },
  });

beforeEach(() => {
  host.preview = true;
  host.supportsHidden = true;
  host.settled = {};
  host.hidden = {};
  host.hideCalls = [];
  toastStore.clear();
  toastStore.clearHistory();
  localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
});

describe('Open and Settled inbox: Settle for owned work, Hide for third-party', () => {
  it('offers Settle and no Dismiss on an owned conversation, and Hide on a third-party Session', async () => {
    mount([owned, external]);
    await screen.findByRole('button', { name: 'Settle Owned chat' });
    expect(
      screen.queryByRole('button', { name: 'Dismiss Owned chat from inbox' }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Hide Outside session from inbox' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', {
        name: 'Dismiss Outside session from inbox',
      }),
    ).toBeNull();
  });

  it('keeps a hidden third-party Session hidden through status changes and on another device, until adopted', async () => {
    const view = mount([external]);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Hide Outside session from inbox',
      }),
    );
    await waitFor(() => expect(row('Outside session')).toBeNull());
    expect(host.hideCalls).toEqual([
      { sessionId: 'external-thread', hidden: true },
    ]);
    // Nothing about it lives in this browser: the host holds it.
    expect(localStorage.getItem('station.inbox.dismissed.v1')).toBeNull();
    view.rerenderWith([
      { ...external, lifecycleLabel: 'Completed', updatedAt: NOW + 5000 },
    ]);
    expect(row('Outside session')).toBeNull();
    view.unmount();

    // A fresh client: once the host's read arrives the row is hidden here too.
    const device = mount([external]);
    await waitFor(() => expect(row('Outside session')).toBeNull());
    device.rerenderWith([{ ...external, controlMode: 'station-owned' }]);
    await waitFor(() => expect(row('Outside session')).toBeTruthy());
    await waitFor(() =>
      expect(host.hideCalls).toContainEqual({
        sessionId: 'external-thread',
        hidden: false,
      }),
    );
    expect(host.hidden).toEqual({});
  });

  it('finds a hidden Session through search and restores it on the host', async () => {
    host.hidden = { 'external-thread': new Date(NOW).toISOString() };
    mount([external]);
    await screen.findByRole('searchbox', { name: 'Search inbox' });
    await waitFor(() => expect(row('Outside session')).toBeNull());
    search('Outside');
    const section = await screen.findByRole('region', { name: /Hidden/ });
    fireEvent.click(
      within(section).getByRole('button', {
        name: 'Restore Outside session to inbox',
      }),
    );
    search('');
    await waitFor(() => expect(row('Outside session')).toBeTruthy());
    expect(host.hideCalls).toEqual([
      { sessionId: 'external-thread', hidden: false },
    ]);
  });

  it('moves local third-party dismissals to the host once and drops them locally', async () => {
    localStorage.setItem(
      'station.inbox.dismissed.v1',
      JSON.stringify({
        'external-thread': {
          lifecycle: 'Running',
          updatedAt: NOW - 1000,
          dismissedAt: NOW - 500,
          thirdParty: true,
        },
        'gone-thread': {
          lifecycle: 'Running',
          updatedAt: NOW - 1000,
          dismissedAt: NOW - 400,
          thirdParty: true,
        },
        '["peer","remote-thread"]': {
          lifecycle: 'Running',
          updatedAt: NOW - 1000,
          dismissedAt: NOW - 300,
          thirdParty: true,
        },
        owned: {
          lifecycle: 'Completed',
          updatedAt: NOW - 1000,
          dismissedAt: NOW - 200,
        },
      }),
    );
    const view = mount([external]);
    await waitFor(() =>
      expect(Object.keys(host.hidden)).toEqual(['external-thread']),
    );
    await waitFor(() =>
      expect(
        Object.keys(
          JSON.parse(localStorage.getItem('station.inbox.dismissed.v1')!),
        ).sort(),
      ).toEqual(['["peer","remote-thread"]', 'owned']),
    );
    expect(row('Outside session')).toBeNull();
    view.unmount();
    mount([external]);
    // Hidden by the host's read now, not by this browser.
    await waitFor(() => expect(row('Outside session')).toBeNull());
    // Once: nothing is left to move on the next mount.
    expect(host.hideCalls.filter((call) => call.hidden)).toHaveLength(2);
  });
});

describe('Settled and Third-party shelves reach back seven days', () => {
  const settledItem = (id: string, title: string): HomeWorkItem => ({
    ...owned,
    id,
    conversationId: id,
    title,
    updatedAt: NOW - 20 * DAY,
  });
  const items = [
    settledItem('recent-settle', 'Settled this week'),
    settledItem('old-settle', 'Settled last month'),
    {
      ...external,
      id: 'fresh-ext',
      title: 'Fresh outside',
      updatedAt: NOW - DAY,
    },
    {
      ...external,
      id: 'stale-ext',
      title: 'Stale outside',
      updatedAt: NOW - 9 * DAY,
    },
  ];
  beforeEach(() => {
    // Settlement time, not when the work ended, sets the window.
    host.settled = {
      'recent-settle': new Date(NOW - 2 * DAY).toISOString(),
      'old-settle': new Date(NOW - 10 * DAY).toISOString(),
    };
  });

  it('shows the last seven days and puts older rows behind Show older', async () => {
    mount(items);
    // The windowed shelf appears once the host's read arrives.
    const older = await screen.findByRole('button', {
      name: 'Show 1 older Settled item',
    });
    const settled = older.closest('section')!;
    expect(row('Settled this week', settled)).toBeTruthy();
    expect(row('Settled last month', settled)).toBeNull();
    fireEvent.click(
      within(settled).getByRole('button', {
        name: 'Show 1 older Settled item',
      }),
    );
    expect(row('Settled last month', settled)).toBeTruthy();
    expect(
      within(settled).queryByRole('button', { name: /older Settled/ }),
    ).toBeNull();

    const thirdParty = screen.getByRole('region', { name: /Third-party/ });
    expect(row('Fresh outside', thirdParty)).toBeTruthy();
    expect(row('Stale outside', thirdParty)).toBeNull();
    fireEvent.click(
      within(thirdParty).getByRole('button', {
        name: 'Show 1 older Third-party item',
      }),
    );
    expect(row('Stale outside', thirdParty)).toBeTruthy();
  });

  it('search still finds rows past the window', async () => {
    mount(items);
    await screen.findByRole('button', { name: 'Show 1 older Settled item' });
    search('last month');
    await waitFor(() => expect(row('Settled last month')).toBeTruthy());
    search('Stale');
    await waitFor(() => expect(row('Stale outside')).toBeTruthy());
    expect(
      screen.queryByRole('button', { name: /^Show \d+ older/ }),
    ).toBeNull();
  });
});

describe('with the preview off, the inbox keeps today’s behaviour', () => {
  it('dismisses owned and third-party rows locally, with no window and no host writes', async () => {
    host.preview = false;
    host.settled = {};
    mount([
      owned,
      external,
      {
        ...external,
        id: 'stale-ext',
        title: 'Stale outside',
        updatedAt: NOW - 30 * DAY,
      },
    ]);
    expect(
      screen.getByRole('button', { name: 'Dismiss Owned chat from inbox' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Settle / })).toBeNull();
    expect(row('Stale outside')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /^Show \d+ older/ }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Dismiss Outside session from inbox',
      }),
    );
    expect(row('Outside session')).toBeNull();
    expect(
      JSON.parse(localStorage.getItem('station.inbox.dismissed.v1')!),
    ).toHaveProperty('external-thread.thirdParty', true);
    expect(host.hideCalls).toEqual([]);
  });

  it('keeps Dismiss on a third-party row when the host cannot hide Sessions', async () => {
    host.supportsHidden = false;
    mount([owned, external]);
    await screen.findByRole('button', { name: 'Settle Owned chat' });
    expect(
      screen.getByRole('button', {
        name: 'Dismiss Outside session from inbox',
      }),
    ).toBeTruthy();
  });
});
