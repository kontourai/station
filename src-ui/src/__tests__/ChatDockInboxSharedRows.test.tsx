// @vitest-environment jsdom

/**
 * archive#3312 — one inbox, two chromes. The row/group anatomy in
 * `ChatDockInboxRows.tsx` must render identically rich rows inside BOTH
 * hosts: the desktop dock panel (`ChatDockInboxPanel`) and the mobile
 * portaled sheet (`MobileTaskSwitcher`). This suite renders the same item
 * through each host and asserts the shared anatomy — project chip, meta
 * line, lifecycle chip, snooze + snooze-duration + close actions — instead
 * of trusting that two files that look alike stay alike.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatDockInboxPanel } from '../components/chat-dock/ChatDockInboxPanel';
import { InboxRow } from '../components/chat-dock/ChatDockInboxRows';
import { MobileTaskSwitcher } from '../components/chat-dock/MobileTaskSwitcher';
import { deviceSettingsStore } from '../lib/device-settings-store';
import type { HomeWorkItem } from '../views/home/home-view-model';

const NOW = Date.parse('2026-08-18T12:00:00Z');

function workItem(overrides: Partial<HomeWorkItem> = {}): HomeWorkItem {
  return {
    id: 'chat:shared',
    kind: 'chat',
    kindLabel: 'Direct chat',
    title: 'Shared row title',
    projectLabel: 'Shared project',
    agentLabel: 'Claude Code',
    modelLabel: 'Sonnet',
    updatedAt: NOW - 60_000,
    lifecycleLabel: 'Running',
    chatSessionId: 'shared',
    ...overrides,
  };
}

/** The live agent catalog both hosts pass down for the rows' agent icons. */
const AGENTS = [
  { slug: 'codex', name: 'Codex' },
  { slug: 'station', name: 'Station' },
];

function renderPanelHost(
  item: HomeWorkItem,
  onCloseChat = vi.fn(),
  agents?: typeof AGENTS,
) {
  return render(
    <ChatDockInboxPanel
      items={[item]}
      activeChatSessionId={null}
      openChatSessionIds={[item.chatSessionId ?? item.id]}
      onFocusChat={vi.fn()}
      onOpenConversation={vi.fn()}
      onOpenSession={vi.fn()}
      onCloseChat={onCloseChat}
      onOpenHistory={vi.fn()}
      now={NOW}
      agents={agents}
    />,
  );
}

function renderSheetHost(
  item: HomeWorkItem,
  onCloseChat = vi.fn(),
  agents?: typeof AGENTS,
) {
  return render(
    <MobileTaskSwitcher
      open
      tasks={[item]}
      activeChatSessionId={null}
      visualViewportStyle={{}}
      triggerRef={createRef<HTMLButtonElement>()}
      onClose={vi.fn()}
      onFocusChat={vi.fn()}
      onOpenConversation={vi.fn()}
      onOpenSession={vi.fn()}
      onCloseChat={onCloseChat}
      now={NOW}
      agents={agents}
    />,
  );
}

function expectSharedRowAnatomy(root: ParentNode) {
  // One shared row implementation: the class family is the contract.
  expect(root.querySelector('.chat-dock-inbox__row')).not.toBeNull();
  expect(root.querySelector('.chat-dock-inbox__project')?.textContent).toBe(
    'Shared project',
  );
  expect(root.querySelector('.chat-dock-inbox__meta')?.textContent).toBe(
    'Claude Code · Sonnet',
  );
  // Lifecycle chip, not the raw wire enum — AND the recency beside it: a
  // chip row used to drop its time entirely, leaving "how long has it sat
  // like this?" unanswerable from the inbox (chat-surface honesty pass).
  const state = root.querySelector('.chat-dock-inbox__state');
  expect(state?.querySelector('.lifecycle-chip')?.textContent).toBe('Active');
  expect(state?.querySelector('.chat-dock-inbox__since')?.textContent).toBe(
    '1m',
  );
}

describe('shared inbox rows render in both hosts (station#3312)', () => {
  beforeEach(() => {
    localStorage.clear();
    deviceSettingsStore.reloadFromStorage();
  });

  it('desktop panel host renders the shared anatomy', () => {
    const { container } = renderPanelHost(workItem());
    expectSharedRowAnatomy(container);
    expect(
      screen.getByRole('button', {
        name: 'Shared row title, Shared project',
      }),
    ).not.toBeNull();
  });

  it('sheet host renders the same shared anatomy with touch chrome', () => {
    renderSheetHost(workItem());
    const dialog = screen.getByRole('dialog', { name: 'Switch task' });
    expectSharedRowAnatomy(dialog);
    expect(
      screen.getByRole('button', {
        name: 'Shared row title, Shared project',
      }),
    ).not.toBeNull();
    // The sheet's list opts into the ≥44px always-visible action chrome.
    expect(dialog.querySelector('.chat-dock-inbox--touch')).not.toBeNull();
    // Chrome stays host-owned: the pinned accessible names survive.
    expect(
      screen.getByRole('button', { name: 'Close task switcher' }),
    ).not.toBeNull();
  });

  // Rendered through the shared row directly: a 3h-old terminal row lives in
  // the collapsed "Earlier" section in the panel host, and what these two pin
  // is the ROW anatomy, not the section chrome.
  it('a terminal row keeps its recency beside the lifecycle chip', () => {
    const { container } = render(
      <InboxRow
        item={workItem({
          lifecycleLabel: 'Failed',
          updatedAt: NOW - 3 * 3_600_000,
        })}
        isCurrent={false}
        isSnoozed={false}
        isOpenChat={false}
        now={NOW}
        onActivate={vi.fn()}
      />,
    );
    const state = container.querySelector('.chat-dock-inbox__state');
    expect(state?.querySelector('.lifecycle-chip')?.textContent).toBe('Failed');
    expect(state?.querySelector('.chat-dock-inbox__since')?.textContent).toBe(
      '3h',
    );
  });

  it('a chip row with no real timestamp renders the chip alone, never a fabricated duration', () => {
    const { container } = render(
      <InboxRow
        item={workItem({ lifecycleLabel: 'Failed', updatedAt: 0 })}
        isCurrent={false}
        isSnoozed={false}
        isOpenChat={false}
        now={NOW}
        onActivate={vi.fn()}
      />,
    );
    const state = container.querySelector('.chat-dock-inbox__state');
    expect(state?.querySelector('.lifecycle-chip')?.textContent).toBe('Failed');
    expect(state?.querySelector('.chat-dock-inbox__since')).toBeNull();
  });

  it('sheet host rows gained the desktop row actions: snooze menu and close', () => {
    const onCloseChat = vi.fn();
    renderSheetHost(workItem(), onCloseChat);

    expect(
      screen.getByRole('button', { name: 'Snooze Shared row title' }),
    ).not.toBeNull();

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Choose snooze duration for Shared row title',
      }),
    );
    expect(screen.getByRole('menuitem', { name: '3 hours' })).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close snooze menu' }));

    fireEvent.click(
      screen.getByRole('button', { name: 'Close Shared row title' }),
    );
    expect(onCloseChat).toHaveBeenCalledWith('shared');
  });

  it('sheet host renders the answerability observation through the shared row', () => {
    renderSheetHost(
      workItem({
        lifecycleLabel: 'Unanswerable',
        unanswerableNotice:
          'Unanswerable by the serving Station — observed by station-1 at 2026-08-18T00:00:00.000Z.',
      }),
    );
    expect(screen.getByTestId('inbox-row-answerability').textContent).toContain(
      'observed by station-1',
    );
  });

  it('a snooze written in one host is read by the other (same store, same key)', () => {
    const item = workItem();
    const sheet = renderSheetHost(item);
    fireEvent.click(
      screen.getByRole('button', { name: 'Snooze Shared row title' }),
    );
    sheet.unmount();

    renderPanelHost(item);
    const snoozedToggle = screen.getByRole('button', { name: 'Snoozed (1)' });
    fireEvent.click(snoozedToggle);
    expect(
      screen.getByRole('button', { name: 'Unsnooze Shared row title' }),
    ).not.toBeNull();
  });
});

/**
 * archive#2802 — the agent icon on an inbox row.
 *
 * The rule these pin is not "an icon appears" but WHICH rows get one: only a
 * row whose own committed `agentSlug` resolves in the live catalog. A row
 * that names no agent, and a row naming an agent this build cannot resolve,
 * both render NO icon — never a generic mark that would imply an engine
 * executed the work (the misattribution `home-view-model.ts`'s
 * `safeAgentLabel` docblock records).
 */
describe('inbox rows show the agent they belong to (station#2802)', () => {
  it('renders the restored handoff current child identity', () => {
    renderPanelHost(
      workItem({
        agentSlug: 'claude',
        agentLabel: 'Claude Code',
        model: 'claude-opus-5',
        modelLabel: 'Opus 5',
        lifecycleLabel: 'Completed',
      }),
      vi.fn(),
      [{ slug: 'claude', name: 'Claude Code' }] as any,
    );
    const row = screen.getByTestId('inbox-row');
    expect(row.textContent).toContain('Claude Code');
    expect(row.textContent).toContain('Opus 5');
    expect(row.textContent).not.toContain('Codex');
  });
  beforeEach(() => {
    localStorage.clear();
    deviceSettingsStore.reloadFromStorage();
  });

  const sessionItem = (overrides: Partial<HomeWorkItem> = {}) =>
    workItem({
      id: 'thread-1',
      kind: 'orchestration',
      kindLabel: 'Session',
      chatSessionId: undefined,
      orchestrationThreadId: 'thread-1',
      agentLabel: 'Codex',
      ...overrides,
    });

  function avatarOf(root: ParentNode) {
    return root.querySelector('.chat-dock-inbox__avatar');
  }

  it('renders the row agent’s own icon when its slug resolves in the catalog', () => {
    const { container } = renderPanelHost(
      sessionItem({ agentSlug: 'codex' }),
      vi.fn(),
      AGENTS,
    );
    const avatar = avatarOf(container);
    expect(avatar).not.toBeNull();
    // Not merely "some icon": the mark resolved for THIS row's agent.
    expect(avatar?.getAttribute('data-brand-key')).toBe('codex');
  });

  it('renders no icon for a row that names no agent', () => {
    const { container } = renderPanelHost(
      sessionItem({ agentSlug: undefined }),
      vi.fn(),
      AGENTS,
    );
    expect(avatarOf(container)).toBeNull();
    // The row is otherwise whole — this is an absent icon, not a broken row.
    expect(
      container.querySelector('.chat-dock-inbox__title')?.textContent,
    ).toBe('Shared row title');
  });

  it('renders no icon for a row whose agent does not resolve, rather than a stand-in', () => {
    const { container } = renderPanelHost(
      // A slug the catalog has never heard of — a deleted agent, or one from
      // a plugin this build does not carry.
      sessionItem({ agentSlug: 'agent-that-is-gone' }),
      vi.fn(),
      AGENTS,
    );
    expect(avatarOf(container)).toBeNull();
    expect(container.querySelector('.brand-icon')).toBeNull();
  });

  it('adds the avatar-column modifier for an unresolved row with a catalog', () => {
    // jsdom cannot derive grid geometry; this test only proves the modifier
    // that the CSS uses to reserve the column is present.
    const { container } = renderPanelHost(
      sessionItem({ agentSlug: 'agent-that-is-gone' }),
      vi.fn(),
      AGENTS,
    );
    expect(
      container.querySelector('.chat-dock-inbox__item--avatars'),
    ).not.toBeNull();
  });

  it('adds no icon column at all for a host that supplies no catalog', () => {
    // `SidebarOpenChats` (archive#3314) renders these rows with no catalog;
    // its layout must be untouched by this feature.
    const { container } = renderPanelHost(sessionItem({ agentSlug: 'codex' }));
    expect(avatarOf(container)).toBeNull();
    expect(
      container.querySelector('.chat-dock-inbox__item--avatars'),
    ).toBeNull();
    expect(container.querySelector('.chat-dock-inbox__item')).not.toBeNull();
  });

  it('draws the icon decoratively: no new name, no new tab stop', () => {
    const withIcon = renderPanelHost(
      sessionItem({ agentSlug: 'codex' }),
      vi.fn(),
      AGENTS,
    );
    const avatar = avatarOf(withIcon.container);
    // Decorative by construction: `BrandIcon` only takes `role="img"` when a
    // caller passes an accessible label, and this call site deliberately does
    // not — the agent is already stated in words on the meta line.
    expect(avatar?.getAttribute('aria-hidden')).toBe('true');
    expect(avatar?.getAttribute('role')).toBeNull();
    expect(avatar?.hasAttribute('tabindex')).toBe(false);
    // The row's accessible name is unchanged by the icon.
    expect(
      screen.getByRole('button', { name: 'Shared row title, Shared project' }),
    ).not.toBeNull();
    const focusableWithIcon = withIcon.container.querySelectorAll(
      '.chat-dock-inbox__row button',
    ).length;
    withIcon.unmount();

    const withoutIcon = renderPanelHost(sessionItem({ agentSlug: 'codex' }));
    expect(
      withoutIcon.container.querySelectorAll('.chat-dock-inbox__row button')
        .length,
    ).toBe(focusableWithIcon);
  });

  it('renders the same icon through the mobile sheet chrome', () => {
    renderSheetHost(sessionItem({ agentSlug: 'codex' }), vi.fn(), AGENTS);
    const dialog = screen.getByRole('dialog', { name: 'Switch task' });
    expect(avatarOf(dialog)?.getAttribute('data-brand-key')).toBe('codex');
  });
});
