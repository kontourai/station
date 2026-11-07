/**
 * @vitest-environment jsdom
 */

/**
 * #4694: the visible palette entry, the guided empty-query list and the key
 * legend. The pill and the palette are mounted together and connected only
 * by the real `open-command-palette` window event, as in the app shell.
 * Touch emulation (a tapped, unfocused button) is covered in
 * `tests/command-palette.spec.ts`; here the explicit trigger is what proves
 * focus returns to the pill even when the tap did not focus it.
 */

import {
  ConnectionStore,
  ConnectionsProvider,
} from '@kontourai/station-connect';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { commandFrecencyStorage } from '../components/command-frecency-storage';
import {
  emptyQueryGroups,
  type PaletteCommand,
} from '../components/command-palette-utils';

vi.mock('../contexts/ApiBaseContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'palette-entry-test-authority',
    isCurrent: () => true,
  }),
}));

// Stable references, as the real query cache returns: a fresh array per
// render would re-run every effect keyed on these and never settle.
const sdkData = vi.hoisted(() => ({
  none: [] as unknown[],
  projects: [{ slug: 'alpha', name: 'Alpha' }],
  messages: { matches: [], instances: [] },
  paneCatalog: { descriptors: [], instances: [], availability: [] },
}));
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  useAgentsQuery: () => ({ data: sdkData.none }),
  useProjectsQuery: () => ({ data: sdkData.projects }),
  useSkillsQuery: () => ({ data: sdkData.none }),
  useMessageSearchQuery: () => ({ data: sdkData.messages }),
  usePluginsQuery: () => ({ data: sdkData.none }),
  useServerCapabilitiesQuery: () => ({ data: undefined }),
  useFeaturePreviewsQuery: () => ({
    data: sdkData.none,
    isLoading: false,
    error: null,
  }),
}));

vi.mock('@kontourai/station-sdk/workspace-pane', () => ({
  useProjectWorkspacePanesQuery: () => ({
    data: sdkData.paneCatalog,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));

const navigateMock = vi.fn();
const setProjectMock = vi.fn();
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    navigate: navigateMock,
    setProject: setProjectMock,
    setDockState: vi.fn(),
    selectedProject: 'alpha',
    selectedProjectLayout: null,
    activeChat: null,
    activeConversation: null,
    isDockOpen: false,
  }),
}));
vi.mock('../contexts/RegionModelContext', () => ({}));
vi.mock('../contexts/useShowSurface', () => ({
  useShowSurface: () => vi.fn(),
  useShowSurfacePage: () => vi.fn(),
}));

let isMobileMock = false;
vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ isMobile: isMobileMock }),
}));
vi.mock('../hooks/useIsMobile', () => ({
  useIsMobile: () => isMobileMock,
}));

const newChat = vi.fn();
vi.mock('../contexts/KeyboardShortcutsContext', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../contexts/KeyboardShortcutsContext')
    >();
  return {
    formatShortcutChord: actual.formatShortcutChord,
    evaluateShortcutWhen: () => true,
    useShortcutRegistry: () => ({
      getDisplay: (id: string) =>
        id === 'command-palette'
          ? actual.formatShortcutChord(['cmd'], 'k', true)
          : '',
      getAllShortcuts: () => [
        {
          id: 'dock.newChat',
          key: 't',
          modifiers: ['cmd'],
          description: 'New chat',
          handler: newChat,
        },
        {
          id: 'app.shortcuts',
          key: '/',
          modifiers: ['cmd'],
          description: 'Show keyboard shortcuts',
          handler: vi.fn(),
        },
      ],
    }),
  };
});

// The ⌘K handler is the existing keyboard route; this file drives the pill.
vi.mock('../hooks/useKeyboardShortcut', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hooks/useKeyboardShortcut')>()),
  useKeyboardShortcut: () => {},
}));

import { CommandPalette } from '../components/CommandPalette';
import { CommandPaletteEntry } from '../components/header/CommandPaletteEntry';

function stubFrame() {
  const frame: { callback: FrameRequestCallback | null } = { callback: null };
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frame.callback = cb;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  return frame;
}

async function renderShell() {
  const values = new Map<string, string>();
  const store = new ConnectionStore({
    storage: {
      get: (key) => values.get(key) ?? null,
      set: (key, value) => values.set(key, value),
      remove: (key) => values.delete(key),
    },
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(['config'], {});
  await act(async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <ConnectionsProvider store={store}>
          <header>
            <CommandPaletteEntry />
          </header>
          <CommandPalette />
        </ConnectionsProvider>
      </QueryClientProvider>,
    );
  });
}

const sectionLabels = () =>
  Array.from(
    document.querySelectorAll('.command-palette__group-label'),
    (node) => node.textContent,
  );
/** Row labels drawn under one group heading, in order. */
const groupRows = (label: string) => {
  const heading = Array.from(
    document.querySelectorAll('.command-palette__group-label'),
  ).find((node) => node.textContent === label);
  return Array.from(
    heading?.parentElement?.querySelectorAll('[role="option"]') ?? [],
    (option) =>
      option.querySelector('.command-palette__option-label')?.textContent ?? '',
  );
};
const highlighted = () =>
  document.getElementById(
    screen.getByRole('combobox').getAttribute('aria-activedescendant') ?? '',
  )?.textContent;

beforeEach(() => {
  isMobileMock = false;
});

afterEach(() => {
  vi.unstubAllGlobals();
  commandFrecencyStorage.reset();
  navigateMock.mockReset();
  setProjectMock.mockReset();
  newChat.mockReset();
});

describe('CommandPaletteEntry (#4694)', () => {
  test('the pill opens the palette and Escape returns focus to it', async () => {
    const frame = stubFrame();
    await renderShell();
    const pill = screen.getByRole('button', { name: 'Search or jump to…' });
    expect(pill.textContent).toContain('⌘K');
    expect(screen.queryByRole('dialog')).toBeNull();

    // A tap need not focus the button; nothing here focuses it.
    expect(document.activeElement).not.toBe(pill);
    fireEvent.click(pill);
    const dialog = screen.getByRole('dialog', { name: 'Command palette' });

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => {
      frame.callback?.(0);
    });
    expect(document.activeElement).toBe(pill);
  });

  test('on a phone it is a glyph-only control with the same name', async () => {
    isMobileMock = true;
    await renderShell();
    const pill = screen.getByRole('button', { name: 'Search or jump to…' });
    expect(pill.textContent).toBe('');
    fireEvent.click(pill);
    expect(
      screen.getByRole('dialog', { name: 'Command palette' }),
    ).toBeTruthy();
    // No keyboard to learn shortcuts for: the shortcut list is not suggested.
    const suggestions = groupRows('Suggestions');
    expect(suggestions).toContain('New chat');
    expect(suggestions).not.toContain('Show keyboard shortcuts');
  });
});

describe('CommandPalette empty query (#4694)', () => {
  test('shows Suggestions, Recent and Places, navigable in drawn order', async () => {
    commandFrecencyStorage.record('project:alpha');
    await renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Search or jump to…' }));

    const labels = sectionLabels();
    expect(labels.slice(0, 3)).toEqual(['Suggestions', 'Recent', 'Places']);
    // The rest of the index stays browsable after the guided sections, and
    // a row shown above is not repeated below.
    expect(labels).toContain('Actions');
    expect(
      screen
        .getAllByRole('option')
        .filter((option) => option.textContent?.startsWith('Alpha')),
    ).toHaveLength(1);

    expect(groupRows('Suggestions')).toEqual([
      'New chat',
      'New Board',
      'Show keyboard shortcuts',
    ]);
    const listbox = screen.getByRole('listbox');
    const suggestion = within(listbox).getByRole('option', {
      name: /New chat/,
    });
    expect(suggestion.querySelector('kbd')?.textContent).toMatch(
      /^(⌘T|Ctrl\+T)$/,
    );

    // The first row is the first suggestion; one step down is the Recent
    // project, and Enter runs exactly the highlighted row.
    expect(highlighted()).toContain('New chat');
    const dialog = screen.getByRole('dialog');
    let guard = 0;
    while (!highlighted()?.startsWith('Alpha') && guard++ < 10) {
      fireEvent.keyDown(dialog, { key: 'ArrowDown' });
    }
    expect(highlighted()).toMatch(/^Alpha/);
    fireEvent.keyDown(dialog, { key: 'Enter' });
    expect(setProjectMock).toHaveBeenCalledWith('alpha');
    expect(newChat).not.toHaveBeenCalled();
  });

  test('a typed query replaces the guided sections', async () => {
    await renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Search or jump to…' }));
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'alpha' },
    });
    expect(sectionLabels()).not.toContain('Suggestions');
    expect(sectionLabels()).not.toContain('Places');
  });

  test('shows the palette key legend', async () => {
    await renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Search or jump to…' }));
    const legend = screen.getByRole('list', { name: 'Palette keys' });
    expect(legend.textContent).toContain('Move');
    expect(legend.textContent).toContain('Open');
    expect(legend.textContent).toContain('Esc');
  });
});

describe('emptyQueryGroups', () => {
  const command = (id: string, group: string, extra = {}): PaletteCommand => ({
    id,
    label: id,
    group,
    run: () => {},
    ...extra,
  });
  const commands = [
    command('command:dock.newChat', 'Commands'),
    command('command:off', 'Commands', { disabled: true }),
    command('action:new-board', 'Actions'),
    command('nav:home', 'Navigation'),
    command('nav:agents', 'Navigation'),
    command('project:a', 'Projects'),
    command('project:b', 'Projects'),
    command('message:x', 'Messages'),
  ];

  test('orders sections, skips unavailable suggestions and lists each row once', () => {
    const groups = emptyQueryGroups(
      commands,
      [
        { commandId: 'project:a', count: 1, lastUsedAt: 1 },
        { commandId: 'project:b', count: 1, lastUsedAt: 2 },
        { commandId: 'nav:agents', count: 4, lastUsedAt: 3 },
        { commandId: 'message:x', count: 1, lastUsedAt: 4 },
        { commandId: 'gone', count: 1, lastUsedAt: 5 },
      ],
      ['command:off', 'command:dock.newChat', 'missing'],
    );
    expect(
      groups.map((group) => [group.label, group.commands.map((row) => row.id)]),
    ).toEqual([
      ['Suggestions', ['command:dock.newChat']],
      ['Recent', ['nav:agents', 'project:b', 'project:a']],
      ['Places', ['nav:home']],
      ['Commands', ['command:off']],
      ['Actions', ['action:new-board']],
      ['Messages', ['message:x']],
    ]);
  });

  test('omits Recent without history and caps it at five', () => {
    expect(
      emptyQueryGroups(commands, []).map((group) => group.label),
    ).not.toContain('Recent');
    const many = Array.from({ length: 7 }, (_, index) =>
      command(`project:${index}`, 'Projects'),
    );
    const recent = emptyQueryGroups(
      many,
      many.map((row, index) => ({
        commandId: row.id,
        count: 1,
        lastUsedAt: index,
      })),
      [],
    ).find((group) => group.label === 'Recent');
    expect(recent?.commands.map((row) => row.id)).toEqual([
      'project:6',
      'project:5',
      'project:4',
      'project:3',
      'project:2',
    ]);
  });
});
