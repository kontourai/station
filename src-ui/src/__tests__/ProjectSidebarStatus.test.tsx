/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { ProjectSidebarStatus } from '../components/project-sidebar/ProjectSidebarStatus';
import { openChatsStore } from '../contexts/open-chats-store';

const { chats, agents } = vi.hoisted(() => ({
  chats: {} as Record<string, unknown>,
  agents: [] as Array<{ slug: string; name: string }>,
}));

vi.mock('../contexts/ActiveChatsContext', () => ({
  useAllActiveChats: () => chats,
}));
vi.mock('../contexts/open-chats-store', () => ({
  useOpenChats: () =>
    Object.entries(chats).map(([id, chat]: [string, any]) => ({
      id,
      chatSessionId: id,
      kind: 'chat',
      title: chat.title ?? 'Task',
      agentLabel:
        agents.find((agent) => agent.slug === chat.agentSlug)?.name ??
        chat.agentSlug,
      modelLabel: chat.model ?? 'Model not reported',
      updatedAt: 0,
    })),
  openChatsStore: {
    focus: vi.fn(),
    openCollection: vi.fn(),
    registerNavigation: ({ focus }: any) => {
      openChatsStore.focus = focus;
      return vi.fn();
    },
  },
}));

vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => agents,
}));

// Mutable so one test can put the registry in the state it is in for the
// first tick after boot: `CommandPalette` registers `command-palette` from a
// lazily-loaded chunk, and `getDisplay` answers '' until it lands.
let paletteChord = 'Ctrl+K';
vi.mock('../hooks/useKeyboardShortcut', () => ({
  useShortcutDisplay: () => paletteChord,
}));

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      media: '',
      onchange: null,
    })),
  });
});

function resetSessions() {
  for (const key of Object.keys(chats)) delete chats[key];
  agents.length = 0;
}

describe('ProjectSidebarStatus', () => {
  test('labels the count for what it is (open chats), pluralized', () => {
    resetSessions();
    chats['session-a'] = { title: 'Fix login bug', agentSlug: 'a' };
    chats['session-b'] = { title: 'Update docs', agentSlug: 'b' };
    agents.push({ slug: 'a', name: 'Agent A' }, { slug: 'b', name: 'Agent B' });

    render(<ProjectSidebarStatus />);
    expect(
      screen.getByRole('button', { name: '2 open chats' }).textContent,
    ).toBe('2 open chats');
  });

  test('singularizes for exactly one open chat', () => {
    resetSessions();
    chats['session-a'] = { title: 'Fix login bug', agentSlug: 'a' };
    agents.push({ slug: 'a', name: 'Agent A' });

    render(<ProjectSidebarStatus />);
    expect(
      screen.getByRole('button', { name: '1 open chat' }).textContent,
    ).toBe('1 open chat');
  });

  test('reads "0 open chats" when the store is empty', () => {
    resetSessions();
    render(<ProjectSidebarStatus />);
    expect(screen.getByRole('button', { name: '0 open chats' })).toBeTruthy();
  });

  test('opens a popover listing the open chats with an agent · model subtitle', () => {
    resetSessions();
    chats['session-a'] = {
      title: 'Fix login bug',
      agentSlug: 'a',
      model: 'gpt-5',
    };
    agents.push({ slug: 'a', name: 'Agent A' });

    render(<ProjectSidebarStatus />);
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '1 open chat' }));

    const menu = screen.getByRole('menu', { name: 'Open chats' });
    expect(menu).toBeTruthy();
    const item = screen.getByRole('menuitem', { name: /Fix login bug/ });
    expect(item.textContent).toContain('Agent A');
    expect(item.textContent).toContain('gpt-5');
  });

  test('clicking a session requests focus with its session id and closes the popover', () => {
    resetSessions();
    chats['session-a'] = {
      title: 'Fix login bug',
      agentSlug: 'a',
      model: 'gpt-5',
    };
    agents.push({ slug: 'a', name: 'Agent A' });

    render(<ProjectSidebarStatus />);
    fireEvent.click(screen.getByRole('button', { name: '1 open chat' }));

    const listener = vi.fn();
    const unregister = openChatsStore.registerNavigation({
      focus: listener,
      openCollection: vi.fn(),
    });
    fireEvent.click(screen.getByRole('menuitem', { name: /Fix login bug/ }));
    unregister();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ sessionId: 'session-a' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  test('shows an empty state when there are no open chats', () => {
    resetSessions();
    render(<ProjectSidebarStatus />);
    fireEvent.click(screen.getByRole('button', { name: '0 open chats' }));

    expect(screen.getByRole('menu', { name: 'Open chats' })).toBeTruthy();
    expect(screen.getByText('All chats are settled')).toBeTruthy();
  });

  test('renders the build identity with full detail in the tooltip', () => {
    resetSessions();
    render(<ProjectSidebarStatus />);
    const version = screen.getByTestId('sidebar-build-version');
    // Under vitest there is no vite `define`, so build-info falls back.
    expect(version.textContent).toBe('v0.0.0 · dev');
    expect(version.getAttribute('title')).toContain('Station v0.0.0');
    expect(version.getAttribute('title')).toContain('commit dev');
  });

  test('the palette chip shows the chord the registry reports (#1649)', () => {
    // It used to render a literal `⌘K`, which named a chord Windows and Linux
    // users cannot press and which would not have followed a rebinding from
    // Settings either. The stub is deliberately NOT the default chord: an
    // assertion of `Ctrl+K` here would pass on the static fallback too, and
    // prove nothing about which of the two the chip is reading.
    resetSessions();
    paletteChord = 'Ctrl+Shift+P';
    render(<ProjectSidebarStatus />);
    const chip = screen.getByRole('button', { name: 'Command palette' });
    expect(chip.textContent).toBe('Ctrl+Shift+P');
    expect(chip.textContent).not.toContain('⌘');
  });

  test('the palette chip still names a chord before the registry has one', () => {
    // The lazy-chunk window: `CommandPalette` registers `command-palette` from
    // a deferred chunk, so `getDisplay` answers '' for the first tick. An
    // empty chip would collapse the button to its padding. The fallback is
    // platform-derived, so it is never the Mac keycap on a non-Mac platform —
    // jsdom reports no Mac here, which is exactly the platform the bug was on.
    resetSessions();
    paletteChord = '';
    render(<ProjectSidebarStatus />);
    const chip = screen.getByRole('button', { name: 'Command palette' });
    expect(chip.textContent).toBe('Ctrl+K');
    expect(chip.textContent).not.toContain('⌘');
  });

  test('an unbound shortcut falls back rather than reading "Not set"', () => {
    resetSessions();
    paletteChord = 'Not set';
    render(<ProjectSidebarStatus />);
    expect(
      screen.getByRole('button', { name: 'Command palette' }).textContent,
    ).toBe('Ctrl+K');
  });

  test('the palette chip dispatches open-command-palette', () => {
    resetSessions();
    paletteChord = 'Ctrl+K';
    render(<ProjectSidebarStatus />);
    const listener = vi.fn();
    window.addEventListener('open-command-palette', listener);
    fireEvent.click(screen.getByRole('button', { name: 'Command palette' }));
    window.removeEventListener('open-command-palette', listener);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
