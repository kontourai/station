// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatDockInboxPanel } from '../components/chat-dock/ChatDockInboxPanel';
import { deviceSettingsStore } from '../lib/device-settings-store';
import { migrateSnoozeKey } from '../utils/activity-snooze-store';
import type { HomeWorkItem } from '../views/home/home-view-model';

const NOW = Date.parse('2026-07-27T18:00:00Z');

function item(
  id: string,
  lifecycleLabel: HomeWorkItem['lifecycleLabel'],
  updatedAt: number,
): HomeWorkItem {
  return {
    id,
    kind: 'chat',
    kindLabel: 'Direct chat',
    title: `${id} title`,
    projectLabel: `${id} project`,
    agentLabel: `${id} agent`,
    modelLabel: `${id} model`,
    updatedAt,
    lifecycleLabel,
    chatSessionId: id,
  };
}

const items = [
  item('active', 'Running', NOW - 60_000),
  item('attention', 'Needs attention', NOW - 120_000),
  item('done', 'Completed', NOW - 180_000),
  // Terminal and past the shared linger window, so it genuinely belongs to
  // "Earlier". (This row was a 'Recent' chat before archive#3227 A6 unified
  // the grouping with the desktop lanes — an idle-but-open chat is Active
  // now, not history, so a non-terminal fixture can no longer stand in for
  // the Earlier group.)
  item('earlier', 'Failed', NOW - 60 * 60_000),
];

function renderPanel(
  overrides: Partial<React.ComponentProps<typeof ChatDockInboxPanel>> = {},
) {
  const props: React.ComponentProps<typeof ChatDockInboxPanel> = {
    items,
    activeChatSessionId: 'active',
    openChatSessionIds: items.map((entry) => entry.id),
    onFocusChat: vi.fn(),
    onOpenConversation: vi.fn(),
    onOpenSession: vi.fn(),
    onCloseChat: vi.fn(),
    onOpenHistory: vi.fn(),
    now: NOW,
    ...overrides,
  };
  return { ...render(<ChatDockInboxPanel {...props} />), props };
}

describe('ChatDockInboxPanel', () => {
  beforeEach(() => {
    localStorage.clear();
    // The device-settings singleton keeps in-memory state across tests;
    // localStorage.clear alone no longer resets the section-collapse
    // toggles the way the old per-mount localStorage readers did.
    deviceSettingsStore.reloadFromStorage();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders activity groups in order with lifecycle status chips', () => {
    renderPanel();

    const panel = screen.getByRole('complementary', { name: 'Inbox chats' });
    const labels = Array.from(
      panel.querySelectorAll(
        '.chat-dock-inbox__group-label, .chat-dock-inbox__section-toggle',
      ),
    ).map((node) => node.textContent?.replace(/^[+−]/, ''));

    expect(labels).toEqual([
      'Active now',
      'Just finished',
      'Snoozed (0)',
      'Earlier',
    ]);
    expect(screen.getByText('Active')).not.toBeNull();
    expect(screen.getByText('Attention needed')).not.toBeNull();
    expect(screen.getByText('Done')).not.toBeNull();
  });

  it('marks the active chat and focuses a clicked row', () => {
    const onFocusChat = vi.fn();
    renderPanel({ onFocusChat });

    expect(
      screen
        .getByRole('button', {
          name: 'active title, active project',
          current: true,
        })
        .getAttribute('aria-current'),
    ).toBe('true');

    fireEvent.click(
      screen.getByRole('button', {
        name: 'attention title, attention project',
      }),
    );
    expect(onFocusChat).toHaveBeenCalledWith('attention');
  });

  // archive#3687 seam 4: acknowledgement used to fire BEFORE the open,
  // unconditionally — a click whose open then failed still moved the row out
  // of "Just finished", quietly burying a session the user could not open.
  it('acknowledges the inventory version only after the open succeeded', async () => {
    const onAcknowledgeConversation = vi.fn();
    const completed: HomeWorkItem = {
      ...item('done', 'Completed', NOW - 180_000),
      conversationUpdatedAt: '2026-08-02T20:00:00.000Z',
    };
    renderPanel({ items: [completed], onAcknowledgeConversation });

    fireEvent.click(
      screen.getByRole('button', { name: 'done title, done project' }),
    );
    await waitFor(() =>
      expect(onAcknowledgeConversation).toHaveBeenCalledWith(completed),
    );
  });

  it('does NOT acknowledge, and reports why, when the click opened nothing (station#3687 seams 3+4)', async () => {
    const onAcknowledgeConversation = vi.fn();
    const onOpenFailed = vi.fn();
    const remote: HomeWorkItem = {
      ...item('elsewhere', 'Completed', NOW - 180_000),
      kind: 'remote-session',
      kindLabel: 'Remote session',
      environmentLabel: 'Living Room Mac',
      // A remote-session row deliberately resolves to no open action.
      chatSessionId: undefined,
      orchestrationThreadId: undefined,
    };
    renderPanel({
      items: [remote],
      onAcknowledgeConversation,
      onOpenFailed,
    });

    fireEvent.click(
      screen.getByRole('button', {
        name: 'elsewhere title, elsewhere project',
      }),
    );
    await waitFor(() =>
      expect(onOpenFailed).toHaveBeenCalledWith(
        'This session lives on Living Room Mac. Open it there to continue.',
      ),
    );
    expect(onAcknowledgeConversation).not.toHaveBeenCalled();
  });

  it('a pending agent catalog reports a wait instead of bouncing to /activity (station#3687 seam 1)', async () => {
    const onOpenFailed = vi.fn();
    const onOpenSession = vi.fn();
    const rehydratable: HomeWorkItem = {
      ...item('rehydrate-me', 'Completed', NOW - 180_000),
      chatSessionId: undefined,
      orchestrationThreadId: 'thread-r',
      agentSlug: 'claude',
    };
    renderPanel({
      items: [rehydratable],
      onOpenConversation: vi.fn().mockResolvedValue(false),
      onOpenSession,
      onOpenFailed,
      agentsLoaded: false,
    });

    fireEvent.click(
      screen.getByRole('button', {
        name: 'rehydrate-me title, rehydrate-me project',
      }),
    );
    await waitFor(() =>
      expect(onOpenFailed).toHaveBeenCalledWith(
        expect.stringMatching(/still loading/i),
      ),
    );
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it('moves a snoozed row into the shared Snoozed group', () => {
    renderPanel();

    fireEvent.click(
      screen.getByRole('button', { name: 'Snooze active title' }),
    );

    const snoozedToggle = screen.getByRole('button', {
      name: 'Snoozed (1)',
    });
    fireEvent.click(snoozedToggle);

    expect(
      screen.getByRole('button', {
        name: 'active title, active project',
      }),
    ).not.toBeNull();
    expect(
      screen.getByRole('button', { name: 'Unsnooze active title' }),
    ).not.toBeNull();
  });

  it('plain snooze remains a one-tap 30 minute action', () => {
    renderPanel({ items: [items[0]] });
    fireEvent.click(
      screen.getByRole('button', { name: 'Snooze active title' }),
    );
    expect(
      JSON.parse(localStorage.getItem('station.activity.snoozed') ?? '{}'),
    ).toEqual({ active: NOW + 30 * 60_000 });
  });

  it('chooses a longer duration from the adjacent snooze menu', () => {
    renderPanel({ items: [items[0]] });
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Choose snooze duration for active title',
      }),
    );
    fireEvent.click(screen.getByRole('menuitem', { name: '3 hours' }));
    expect(
      JSON.parse(localStorage.getItem('station.activity.snoozed') ?? '{}'),
    ).toEqual({ active: NOW + 3 * 3_600_000 });
  });

  it('moves focus to the adjacent row before snoozing the focused row (#1054)', () => {
    renderPanel();
    const snooze = screen.getByRole('button', { name: 'Snooze active title' });
    snooze.focus();

    fireEvent.click(snooze);

    expect(document.activeElement).toBe(
      screen.getByRole('button', {
        name: 'attention title, attention project',
      }),
    );
    expect(document.activeElement).not.toBe(document.body);
  });

  it('moves focus to the adjacent row before closing the focused row (#1054)', () => {
    const onCloseChat = vi.fn();
    renderPanel({ onCloseChat });
    const close = screen.getByRole('button', { name: 'Close active title' });
    close.focus();

    fireEvent.click(close);

    expect(onCloseChat).toHaveBeenCalledWith('active');
    expect(document.activeElement).toBe(
      screen.getByRole('button', {
        name: 'attention title, attention project',
      }),
    );
    expect(document.activeElement).not.toBe(document.body);
  });

  it('focuses the inbox panel when the removed row has no neighbor (#1054)', () => {
    renderPanel({ items: [items[0]], openChatSessionIds: ['active'] });
    const panel = screen.getByRole('complementary', { name: 'Inbox chats' });
    const close = screen.getByRole('button', { name: 'Close active title' });
    close.focus();

    fireEvent.click(close);

    expect(document.activeElement).toBe(panel);
    expect(document.activeElement).not.toBe(document.body);
  });

  // archive#1295 / archive#1311: snoozing keys on
  // `item.id` (`conversationId || storeKey`), which changes the moment a
  // brand-new chat's first send assigns a conversationId. The migration
  // that keeps a pre-assignment snooze alive happens where both ids are
  // known together — `ActiveChatsStore.assignConversationId`
  // (`migrateSnoozeKey`) — not by having the inbox panel fall back to a
  // second key on every read (archive#1311 found that fallback
  // itself broke reopening an EXISTING Station-native/bedrock conversation,
  // whose store key churns on every reopen while its conversationId stays
  // put). This exercises the same migration call the store makes at the
  // real promotion point, then confirms the panel reads the migrated entry
  // under the row's new id.
  it('a snooze written before conversationId assignment still applies once the row is promoted to its conversationId', () => {
    const preAssignment = item('store-x', 'Running', NOW - 1000);
    const first = renderPanel({
      items: [preAssignment],
      openChatSessionIds: ['store-x'],
      activeChatSessionId: null,
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'Snooze store-x title' }),
    );
    first.unmount();

    // The real promotion moment: `ActiveChatsStore.assignConversationId`
    // migrates the snooze from the old store-key id to the new
    // conversationId before the panel ever re-renders with it.
    migrateSnoozeKey('store-x', 'conv-x', NOW);

    const postAssignment: HomeWorkItem = {
      ...preAssignment,
      id: 'conv-x',
    };
    renderPanel({
      items: [postAssignment],
      openChatSessionIds: ['store-x'],
      activeChatSessionId: null,
    });

    const snoozedToggle = screen.getByRole('button', { name: 'Snoozed (1)' });
    fireEvent.click(snoozedToggle);
    expect(
      screen.getByRole('button', {
        name: 'Unsnooze store-x title',
      }),
    ).not.toBeNull();
  });

  // archive#1311 (opposite direction): reopening an EXISTING
  // Station-native/bedrock conversation re-synthesizes a fresh
  // `chatSessionId` on every reopen (`useOpenConversation`), while its `id`
  // (the conversationId) stays constant. A snooze must survive that,
  // unaffected by any chatSessionId churn — no migration call needed here,
  // since `id` never changed.
  it('a snooze on an existing conversation survives close+reopen even though chatSessionId is re-synthesized', () => {
    const beforeReopen: HomeWorkItem = {
      ...item('conv-stable', 'Running', NOW - 1000),
      chatSessionId: 'agent-1:1111',
    };
    const first = renderPanel({
      items: [beforeReopen],
      openChatSessionIds: ['agent-1:1111'],
      activeChatSessionId: null,
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Snooze conv-stable title' }),
    );
    first.unmount();

    // Reopened: same `id` (conversationId), brand-new `chatSessionId`.
    const afterReopen: HomeWorkItem = {
      ...item('conv-stable', 'Running', NOW - 1000),
      chatSessionId: 'agent-1:2222',
    };
    renderPanel({
      items: [afterReopen],
      openChatSessionIds: ['agent-1:2222'],
      activeChatSessionId: null,
    });

    const snoozedToggle = screen.getByRole('button', { name: 'Snoozed (1)' });
    fireEvent.click(snoozedToggle);
    expect(
      screen.getByRole('button', {
        name: 'Unsnooze conv-stable title',
      }),
    ).not.toBeNull();
  });

  // archive#1297: "rehydrate vs navigate" must be a row-open policy, not an
  // accident of whether a live in-memory chat tab happens to exist.
  it('rehydrates a rehydratable session with no live tab instead of navigating to /activity', () => {
    const onOpenConversation = vi.fn().mockResolvedValue(true);
    const onOpenSession = vi.fn();
    const orchestrationItem: HomeWorkItem = {
      id: 'thread-1',
      kind: 'orchestration',
      kindLabel: 'Session',
      title: 'Ship the release note',
      projectLabel: 'station',
      agentLabel: 'Claude Code',
      modelLabel: 'Sonnet',
      updatedAt: NOW,
      lifecycleLabel: 'Ready',
      orchestrationThreadId: 'thread-1',
      agentSlug: 'claude-code',
      projectSlug: 'station',
      controlMode: 'station-owned',
      conversationUpdatedAt: '2020-06-15T12:00:00.000Z',
    };
    renderPanel({
      items: [orchestrationItem],
      activeChatSessionId: null,
      openChatSessionIds: [],
      onOpenConversation,
      onOpenSession,
    });

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Ship the release note, station',
      }),
    );

    expect(onOpenConversation).toHaveBeenCalledWith(
      'thread-1',
      'claude-code',
      'station',
      'station',
      undefined,
      '2020-06-15T12:00:00.000Z',
    );
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it('navigates to /activity for a session Station cannot rehydrate (read-only-attached)', () => {
    const onOpenConversation = vi.fn();
    const onOpenSession = vi.fn();
    const readOnlyItem: HomeWorkItem = {
      id: 'thread-2',
      kind: 'orchestration',
      kindLabel: 'Session',
      title: 'Attached session',
      projectLabel: 'station',
      agentLabel: 'Claude Code',
      modelLabel: 'Sonnet',
      updatedAt: NOW,
      lifecycleLabel: 'Ready',
      orchestrationThreadId: 'thread-2',
      agentSlug: 'claude-code',
      projectSlug: 'station',
      controlMode: 'read-only-attached',
    };
    renderPanel({
      items: [readOnlyItem],
      activeChatSessionId: null,
      openChatSessionIds: [],
      onOpenConversation,
      onOpenSession,
    });

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Attached session, station',
      }),
    );

    expect(onOpenSession).toHaveBeenCalledWith('thread-2');
    expect(onOpenConversation).not.toHaveBeenCalled();
  });

  // The row-open policy treats every `onOpenConversation` failure alike —
  // an agent that no longer exists and a conversation whose message fetch
  // 404s/errors (archive#1312: `useOpenConversation` now reports
  // that failure instead of silently opening a permanently empty tab, see
  // `useOpenConversation.test.tsx` for the tab-teardown proof at that
  // deeper layer) both resolve `false` here, so this one component-level
  // test covers the `onOpenSession` fallback for both causes.
  it('falls back to /activity when rehydrating fails (agent no longer exists)', async () => {
    const onOpenConversation = vi.fn().mockResolvedValue(false);
    const onOpenSession = vi.fn();
    const orphanedItem: HomeWorkItem = {
      id: 'thread-3',
      kind: 'orchestration',
      kindLabel: 'Session',
      title: 'Orphaned session',
      projectLabel: 'station',
      agentLabel: 'Deleted agent',
      modelLabel: 'Sonnet',
      updatedAt: NOW,
      lifecycleLabel: 'Ready',
      orchestrationThreadId: 'thread-3',
      agentSlug: 'deleted-agent',
      projectSlug: 'station',
      controlMode: 'station-owned',
    };
    renderPanel({
      items: [orphanedItem],
      activeChatSessionId: null,
      openChatSessionIds: [],
      onOpenConversation,
      onOpenSession,
    });

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Orphaned session, station',
      }),
    );

    await vi.waitFor(() => {
      expect(onOpenSession).toHaveBeenCalledWith('thread-3');
    });
  });

  // archive#1795: an item that somehow still reaches the panel with a
  // non-positive `updatedAt` (the upstream reduce-seed bug's exact
  // signature — a real Date.now-derived timestamp is never <= 0) must not
  // render as an implausible multi-year duration. This is the last-resort
  // display guard, independent of the home-view-model fix that keeps a real
  // item from reaching here with updatedAt <= 0 in the first place.
  it('never renders an implausible day count for a non-positive updatedAt (epoch-0 guard)', () => {
    const epochItem = item('epoch', 'Recent', 0);
    renderPanel({ items: [epochItem] });

    // A 0-updatedAt, non-terminal item sits in "Active now" (archive#3227
    // A6: the shared lane partition classes every not-finished item as
    // active regardless of recency), which is always expanded — the row is
    // reachable directly.
    expect(
      screen.getByRole('button', { name: 'epoch title, epoch project' }),
    ).not.toBeNull();
    expect(screen.queryByText(/\d+d$/)).toBeNull();
    expect(screen.getByText('now')).not.toBeNull();
  });

  it('persists collapsible section state', () => {
    const first = renderPanel();
    const earlier = screen.getByRole('button', { name: 'Earlier' });
    expect(earlier.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(earlier);
    expect(earlier.getAttribute('aria-expanded')).toBe('true');
    first.unmount();

    renderPanel();
    expect(
      screen
        .getByRole('button', { name: 'Earlier' })
        .getAttribute('aria-expanded'),
    ).toBe('true');
    expect(
      screen.getByRole('button', {
        name: 'earlier title, earlier project',
      }),
    ).not.toBeNull();
  });

  // archive#1797: the collapsed rail (a second "Open chat list"/expand
  // control) duplicated the chrome's own header toggle whenever both
  // were on screen at once. Collapsing is now entirely the caller's job —
  // `ChatDock.tsx` simply stops mounting this component — so the component
  // itself no longer has any notion of a collapsed state to render a
  // duplicate control for. A stray `collapsed` prop (the old contract,
  // cast through `as any` since the type no longer declares it) must be
  // silently ignored rather than reintroducing the redundant rail.
  it('ignores a stray legacy "collapsed" prop and always renders the full panel, never the old duplicate rail control', () => {
    renderPanel({ collapsed: true, onExpand: vi.fn() } as any);

    expect(screen.queryByRole('button', { name: 'Open chat list' })).toBeNull();
    expect(document.querySelector('.chat-dock-inbox--collapsed')).toBeNull();
    expect(document.querySelector('.chat-dock-inbox__rail-expand')).toBeNull();
    expect(
      screen.getByRole('button', {
        name: 'active title, active project',
      }),
    ).not.toBeNull();
  });

  // archive#1797: collapsing the inbox is now the caller's responsibility —
  // `ChatDock.tsx` mounts this component only while expanded, so there is no
  // in-component collapsed rail/state to render or test here any more. The
  // sole expand/collapse control lives in the dock header (archive#3309; see
  // `ChatDockHeaderWorkspaceControls.test.tsx`'s `chat-dock__inbox-toggle`
  // coverage).
});

/**
 *`LIFECYCLE_CHIP_LABELS` and `HOME_LIFECYCLE_LABELS` are
 * SHARED, so adding `'Unanswerable'` for the Home row reached this panel —
 * which rendered a bare chip with none of the basis, two components away
 * from the comment insisting a bare label is not a derivation. The item
 * already carries `unanswerableNotice`; it simply was not rendered.
 */
describe('ChatDockInboxPanel answerability basis (station#1783)', () => {
  const NOTICE =
    "Unanswerable by the serving Station (no adapter for provider 'acme') — observed by station-7f3a at 2026-08-03T12:04:03.000Z.";

  function unanswerableItem(): HomeWorkItem {
    return {
      ...item('stranded', 'Unanswerable', NOW - 60_000),
      unanswerableNotice: NOTICE,
    };
  }

  it('renders the observation beside the chip, not the chip alone', () => {
    renderPanel({ items: [unanswerableItem()] });
    const notice = screen.getByTestId('inbox-row-answerability').textContent;
    expect(notice).toContain("no adapter for provider 'acme'");
    expect(notice).toContain('station-7f3a');
    expect(notice).toContain('2026-08-03T12:04:03.000Z');
  });

  it('speaks the user’s language, not the wire enum', () => {
    // Every sibling chip translates (`Running` -> "Active", `Completed` ->
    // "Done"); `Unanswerable` was the only member leaking its enum text.
    renderPanel({ items: [unanswerableItem()] });
    expect(screen.getByText("Can't answer here")).toBeTruthy();
    expect(screen.queryByText('Unanswerable')).toBeNull();
  });

  it('control: an ordinary row renders no answerability line', () => {
    renderPanel();
    expect(screen.queryByTestId('inbox-row-answerability')).toBeNull();
  });
});

/**
 * archive#3309. The panel outlives its own collapse by one motion beat so the
 * exit can play. For that beat it is still in the DOM while the user's decision
 * to close it is already complete, and the component documents what it does
 * about that: inert. Nothing exercised either half, so the class the CSS keys
 * off and the property that removes it from the tab order and the a11y tree
 * were both promises with no test behind them.
 */
describe('ChatDockInboxPanel exit presentation (#3309)', () => {
  it('is a plain, interactive panel while it is open', () => {
    renderPanel();

    const panel = document.querySelector('.chat-dock-inbox') as HTMLElement;
    expect(panel).toBeTruthy();
    expect(panel.className).not.toContain('chat-dock-inbox--exiting');
    expect(panel.inert).toBe(false);
    // Still a landmark answering to its name, and still reachable.
    expect(
      screen.getByRole('complementary', { name: 'Inbox chats' }),
    ).toBeTruthy();
  });

  it('is inert and marked exiting while it plays its exit', () => {
    renderPanel({ exiting: true });

    const panel = document.querySelector('.chat-dock-inbox') as HTMLElement;
    expect(panel.className).toContain('chat-dock-inbox--exiting');
    // The documented contract is "out of the tab order and out of the
    // accessibility tree, not merely faded", and `inert` is the single
    // property that delivers both. Asserted as the property rather than as an
    // absent role: jsdom does not model `inert` in its accessibility tree, so
    // a `queryByRole(...).toBeNull` here would be asserting something this
    // environment cannot evaluate — it stays visible to the role query whether
    // or not the mechanism is applied. The browser-side effect is what
    // tests/mobile-chat-composer.spec.ts can see; what this pins is that the
    // component actually applies it.
    expect(panel.inert).toBe(true);
    // Still rendered, deliberately — that is what makes the exit visible.
    expect(document.querySelector('.chat-dock-inbox')).toBeTruthy();
  });

  it('drops both again if the panel is reopened mid-exit', () => {
    const { rerender } = renderPanel({ exiting: true });
    expect(
      (document.querySelector('.chat-dock-inbox') as HTMLElement).inert,
    ).toBe(true);

    rerender(
      <ChatDockInboxPanel
        items={items}
        activeChatSessionId="active"
        openChatSessionIds={items.map((entry) => entry.id)}
        onFocusChat={vi.fn()}
        onOpenConversation={vi.fn()}
        onOpenSession={vi.fn()}
        onCloseChat={vi.fn()}
        onOpenHistory={vi.fn()}
        now={NOW}
        exiting={false}
      />,
    );

    const panel = document.querySelector('.chat-dock-inbox') as HTMLElement;
    expect(panel.className).not.toContain('chat-dock-inbox--exiting');
    expect(panel.inert).toBe(false);
  });
});
