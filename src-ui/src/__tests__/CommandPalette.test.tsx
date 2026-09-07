/**
 * @vitest-environment jsdom
 */

import {
  ConnectionStore,
  ConnectionsProvider,
} from '@kontourai/station-connect';
import {
  WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR,
  WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR,
} from '@kontourai/station-contracts/workspace-coding-panels';
import { paneAdaptationFromLayoutTab } from '@kontourai/station-contracts/workspace-pane-layout-adapter';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { commandFrecencyStorage } from '../components/command-frecency-storage';
import {
  fuzzyScore,
  type PaletteCommand,
  rankCommands,
} from '../components/command-palette-utils';
import { activeChatsStore } from '../contexts/active-chats-store';
import {
  openChatIdentitiesSnapshot,
  openChatsStore,
  resetOpenChatIdentitiesCacheForTests,
} from '../contexts/open-chats-store';
import { REGION_SURFACE_REGISTRY } from '../regions/region-model';

// --- SDK + navigation mocks ------------------------------------------------

let agentsMock: any[] = [];
let projectsMock: any[] = [];
let skillsMock: any[] = [];
let paneCatalogMock: any = {
  descriptors: [],
  instances: [],
  availability: [],
};
let selectedProjectLayoutMock: string | null = null;
let messageSearchMock: any = { matches: [], instances: [] };
const registeredCommand = vi.fn();
let registeredShortcutAvailability: { disabled?: boolean; when?: unknown } = {};
let registeredShortcutIdentity = {
  id: 'app.registered',
  key: 'j',
  modifiers: ['cmd'] as ('cmd' | 'ctrl' | 'shift' | 'alt')[],
  description: 'Run registered command',
};
let additionalRegisteredShortcutIdentities: (typeof registeredShortcutIdentity)[] =
  [];
let shortcutWhenEnabled = true;

// Counts index rebuilds. `rankCommands` runs inside the palette's `useMemo`
// over `commands`, so a call here means the whole command list was rebuilt,
// reranked and regrouped — the work is about.
const indexRebuilds = vi.hoisted(() => ({ count: 0 }));
vi.mock('../components/command-palette-utils', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../components/command-palette-utils')
    >();
  return {
    ...actual,
    rankCommands: (query: string, commands: PaletteCommand[]) => {
      indexRebuilds.count += 1;
      return actual.rankCommands(query, commands);
    },
  };
});

vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  useAgentsQuery: () => ({ data: agentsMock }),
  useProjectsQuery: () => ({ data: projectsMock }),
  useSkillsQuery: () => ({ data: skillsMock }),
  useMessageSearchQuery: () => ({ data: messageSearchMock }),
  // Pane availability consumes deployment facts through the public SDK; this
  // palette test deliberately keeps that independent query inert.
  useServerCapabilitiesQuery: () => ({ data: undefined }),
  // archive#3313: surface visibility flags read the previews query; keep it
  // inert (no previews enabled) rather than letting the real hook fetch.
  useFeaturePreviewsQuery: () => ({
    data: [],
    isLoading: false,
    error: null,
  }),
}));

vi.mock('@kontourai/station-sdk/workspace-pane', () => ({
  useProjectWorkspacePanesQuery: () => ({
    data: paneCatalogMock,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));

const navigateMock = vi.fn();
const showSurfaceMock = vi.fn();
const setProjectMock = vi.fn();
const setDockStateMock = vi.fn();

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    navigate: navigateMock,
    setProject: setProjectMock,
    setDockState: setDockStateMock,
    selectedProject: 'alpha',
    selectedProjectLayout: selectedProjectLayoutMock,
  }),
}));
vi.mock('../contexts/RegionModelContext', () => ({}));
vi.mock('../contexts/useShowSurface', () => ({
  useShowSurface: () => showSurfaceMock,
}));

vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ isMobile: false }),
}));

vi.mock('../contexts/KeyboardShortcutsContext', () => ({
  evaluateShortcutWhen: () => shortcutWhenEnabled,
  useShortcutRegistry: () => ({
    getAllShortcuts: () => [
      {
        ...registeredShortcutIdentity,
        handler: registeredCommand,
        ...registeredShortcutAvailability,
      },
      ...additionalRegisteredShortcutIdentities.map((identity) => ({
        ...identity,
        handler: registeredCommand,
        ...registeredShortcutAvailability,
      })),
      // The real registry always carries these nine, whatever the session
      // count is — that is exactly SHELL-19's defect, so the harness has to
      // reproduce it or the assertion below proves nothing.
      ...Array.from({ length: 9 }, (_, index) => ({
        id: `dock.session${index + 1}`,
        key: String(index + 1),
        modifiers: ['cmd'],
        description: `Switch to session ${index + 1}`,
        handler: vi.fn(),
      })),
      {
        id: 'dock.newChat',
        key: 't',
        modifiers: ['cmd'],
        description: 'New chat',
        handler: vi.fn(),
      },
    ],
  }),
}));

// Capture the registered ⌘K handler so tests can "open" the palette without a
// full KeyboardShortcutsProvider.
let openHandler: (() => void) | null = null;
vi.mock('../hooks/useKeyboardShortcut', () => ({
  useKeyboardShortcut: (
    _id: string,
    _key: string,
    _mods: string[],
    _desc: string,
    handler: () => void,
  ) => {
    openHandler = handler;
  },
}));

import { CommandPalette } from '../components/CommandPalette';

afterEach(() => {
  indexRebuilds.count = 0;
  resetOpenChatIdentitiesCacheForTests();
  navigateMock.mockReset();
  showSurfaceMock.mockReset();
  setProjectMock.mockReset();
  setDockStateMock.mockReset();
  registeredCommand.mockReset();
  openHandler = null;
  agentsMock = [];
  projectsMock = [];
  skillsMock = [];
  paneCatalogMock = { descriptors: [], instances: [], availability: [] };
  selectedProjectLayoutMock = null;
  messageSearchMock = { matches: [], instances: [] };
  registeredShortcutAvailability = {};
  registeredShortcutIdentity = {
    id: 'app.registered',
    key: 'j',
    modifiers: ['cmd'],
    description: 'Run registered command',
  };
  additionalRegisteredShortcutIdentities = [];
  shortcutWhenEnabled = true;
  commandFrecencyStorage.reset();
});

/**
 * The shape `handleTextDeltaEvent` writes per streamed token
 * (`streamHandlers.ts`): one `updateChat` carrying the growing assistant
 * message and a `sending` status. Nothing here is part of a chat's identity.
 */
function streamTokens(sessionId: string, count: number) {
  let content = '';
  for (let token = 0; token < count; token += 1) {
    content += `token ${token} `;
    activeChatsStore.updateChat(sessionId, {
      status: 'sending',
      streamingMessage: { role: 'assistant', content },
    } as never);
  }
}

/**
 * The same stream, but each token flushed in its OWN commit — which is what
 * a real stream does, one network event per token. Batching all of them into
 * a single `act` would collapse 25 store notifications into one re-render and
 * hide most of the cost this test exists to measure.
 */
async function streamTokensCommitted(sessionId: string, count: number) {
  let content = '';
  for (let token = 0; token < count; token += 1) {
    content += `token ${token} `;
    const next = content;
    await act(async () => {
      activeChatsStore.updateChat(sessionId, {
        status: 'sending',
        streamingMessage: { role: 'assistant', content: next },
      } as never);
    });
  }
}

function open() {
  // The captured ⌘K handler sets state outside an event; wrap in act so the
  // re-render flushes before assertions.
  act(() => {
    openHandler?.();
  });
}

/**
 * CommandPalette resolves workspace-pane availability, which reads the active
 * connection through the real provider boundary. Keep this harness aligned
 * with the application instead of replacing the hook under test.
 */
async function renderCommandPalette() {
  const values = new Map<string, string>();
  const store = new ConnectionStore({
    storage: {
      get: (key) => values.get(key) ?? null,
      set: (key, value) => values.set(key, value),
      remove: (key) => values.delete(key),
    },
  });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnMount: false,
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
      },
    },
  });
  queryClient.setQueryData(['config'], {});
  await act(async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <ConnectionsProvider store={store}>
          <CommandPalette />
        </ConnectionsProvider>
      </QueryClientProvider>,
    );
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

// --- fuzzy scorer ----------------------------------------------------------

describe('fuzzyScore', () => {
  test('exact match beats prefix beats subsequence', () => {
    const exact = fuzzyScore('agents', 'Agents');
    const prefix = fuzzyScore('age', 'Agents');
    const sub = fuzzyScore('ats', 'Agents');
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(sub);
    expect(sub).toBeGreaterThanOrEqual(0);
  });

  test('returns -1 when not a subsequence', () => {
    expect(fuzzyScore('xyz', 'Agents')).toBe(-1);
  });

  test('empty query scores 0', () => {
    expect(fuzzyScore('', 'Agents')).toBe(0);
  });
});

describe('rankCommands', () => {
  const cmds: PaletteCommand[] = [
    { id: 'a', label: 'Agents', group: 'Navigation', run: vi.fn() },
    { id: 'm', label: 'Monitoring', group: 'Navigation', run: vi.fn() },
    {
      id: 's',
      label: 'Schedule',
      group: 'Navigation',
      keywords: ['cron'],
      run: vi.fn(),
    },
  ];

  test('ranks the closest label first', () => {
    const ranked = rankCommands('ag', cmds);
    expect(ranked[0].id).toBe('a');
  });

  test('matches via keywords', () => {
    const ranked = rankCommands('cron', cmds);
    expect(ranked.map((c) => c.id)).toContain('s');
  });

  test('a typed label outranks another command that claims it as a keyword', () => {
    // 6-OPS-31, measured: typing `monitor` returned ["Activity",
    // "Monitoring"] and Enter navigated to Activity — Activity's `keywords`
    // include monitoring terms and scored an exact 1000, while the surface
    // literally named Monitoring only scored a label prefix.
    const monitorish: PaletteCommand[] = [
      {
        id: 'activity',
        label: 'Activity',
        group: 'Navigation',
        keywords: ['activity', 'sessions', 'monitor', 'events'],
        run: vi.fn(),
      },
      {
        id: 'monitoring',
        label: 'Monitoring',
        group: 'Navigation',
        keywords: ['monitoring', 'observability', 'metrics'],
        run: vi.fn(),
      },
    ];
    expect(rankCommands('monitor', monitorish).map((c) => c.id)).toEqual([
      'monitoring',
      'activity',
    ]);
    // An exact label match still wins outright, and the keyword route still
    // finds a command whose label does not match at all.
    expect(rankCommands('activity', monitorish)[0].id).toBe('activity');
    expect(rankCommands('metrics', monitorish)[0].id).toBe('monitoring');
  });

  test('empty query keeps natural order', () => {
    const ranked = rankCommands('', cmds);
    expect(ranked.map((c) => c.id)).toEqual(['a', 'm', 's']);
  });

  test('drops non-matches', () => {
    const ranked = rankCommands('zzzz', cmds);
    expect(ranked).toHaveLength(0);
  });
});

// --- component behavior ----------------------------------------------------

describe('openChatIdentitiesSnapshot', () => {
  // The reference stability the palette's `useSyncExternalStore` depends on:
  // React bails out of an update when `getSnapshot` returns the same value,
  // so an identity-only projection that reallocated every call would defeat
  // the whole point of narrowing the subscription.
  test('keeps its reference until an identity or label actually changes', () => {
    activeChatsStore.initChat('session-alpha', {
      agentSlug: 'claude',
      agentName: 'Claude',
      title: 'Refactor the parser',
    });
    try {
      const first = openChatIdentitiesSnapshot();
      expect(first).toEqual([
        {
          sessionId: 'session-alpha',
          label: 'Refactor the parser',
          agentSlug: 'claude',
        },
      ]);

      streamTokens('session-alpha', 10);
      expect(openChatIdentitiesSnapshot()).toBe(first);

      activeChatsStore.updateChat('session-alpha', { title: 'Renamed chat' });
      const renamed = openChatIdentitiesSnapshot();
      expect(renamed).not.toBe(first);
      expect(renamed[0].label).toBe('Renamed chat');

      activeChatsStore.initChat('session-beta', {
        agentSlug: 'codex',
        agentName: 'Codex',
        title: 'Second chat',
      });
      expect(openChatIdentitiesSnapshot()).not.toBe(renamed);
      expect(openChatIdentitiesSnapshot()).toHaveLength(2);
    } finally {
      activeChatsStore.removeChat('session-alpha');
      activeChatsStore.removeChat('session-beta');
    }
  });

  test('falls back to the agent slug, then to a bounded placeholder', () => {
    activeChatsStore.initChat('session-untitled', {
      agentSlug: 'claude',
      agentName: 'Claude',
      title: '',
    });
    activeChatsStore.initChat('session-bare');
    try {
      const byId = Object.fromEntries(
        openChatIdentitiesSnapshot().map((chat) => [
          chat.sessionId,
          chat.label,
        ]),
      );
      expect(byId['session-untitled']).toBe('claude');
      expect(byId['session-bare']).toBe('Untitled chat');
    } finally {
      activeChatsStore.removeChat('session-untitled');
      activeChatsStore.removeChat('session-bare');
    }
  });
});

describe('CommandPalette', () => {
  test('loads a catalog-backed Settings target on search and keeps its canonical deep link', async () => {
    await renderCommandPalette();
    open();
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'terminal shell' },
    });

    const command = await screen.findByRole('option', {
      name: /Settings: Terminal shell/i,
    });
    fireEvent.click(command);

    expect(navigateMock).toHaveBeenCalledWith('/settings', {
      view: 'station-config',
      highlight: 'terminal-shell',
    });
  });

  test('searches message rows only after two characters and renders hostile excerpts as text', async () => {
    messageSearchMock = {
      matches: [
        {
          conversationId: 'older-session',
          messageId: 'older-message',
          agentSlug: 'claude',
          role: 'assistant',
          excerpt: '<img src=x onerror=alert(1)> cobalt albatross',
          engine: 'claude',
        },
      ],
      instances: [],
    };
    await renderCommandPalette();
    open();
    const input = screen.getByRole('combobox');
    expect(input.getAttribute('aria-label')).toBe(
      'Search commands and indexed conversation messages',
    );
    expect(input.getAttribute('placeholder')).toBe(
      'Search commands, projects, agents, indexed conversation messages…',
    );
    fireEvent.change(input, { target: { value: 'c' } });
    expect(screen.queryByText(/cobalt albatross/)).toBeNull();
    fireEvent.change(input, { target: { value: 'co' } });
    expect(screen.getByText(/cobalt albatross/)).toBeTruthy();
    expect(screen.getByText(/Project: No project/)).toBeTruthy();
    expect(screen.getByText(/Engine: claude/)).toBeTruthy();
    // A React text node, not parsed model HTML: the hostile string is visible
    // verbatim and creates no image element.
    expect(screen.getByText(/<img src=x/)).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });

  test('advertises the chats that exist, not nine static session slots', async () => {
    // SHELL-19, measured: the palette listed "Switch to session 1" …
    // "Switch to session 9" as static commands with ONE session open, and
    // eight of those rows ran a handler that returns without doing anything.
    // "New chat" also appeared twice — once from ⌘T, once as an Action whose
    // `run` was byte-identical to "Open chat dock".
    activeChatsStore.initChat('session-alpha', {
      agentSlug: 'claude',
      agentName: 'Claude',
      title: 'Refactor the parser',
    });
    try {
      await renderCommandPalette();
      open();
      const labels = () =>
        screen
          .getAllByRole('option')
          .map((option) => option.textContent?.trim() ?? '');

      expect(labels().filter((l) => /^Switch to session/.test(l))).toEqual([]);
      expect(labels().filter((l) => l.startsWith('New chat'))).toHaveLength(1);

      const chatRow = screen
        .getAllByRole('option')
        .find((option) =>
          option.textContent?.startsWith('Refactor the parser'),
        );
      expect(chatRow).toBeTruthy();

      const focus = vi.fn();
      const unregister = openChatsStore.registerNavigation({
        focus,
        openCollection: vi.fn(),
      });
      fireEvent.click(chatRow!);
      expect(focus).toHaveBeenCalledWith({ sessionId: 'session-alpha' });
      unregister();
    } finally {
      activeChatsStore.removeChat('session-alpha');
    }
  });

  test('lists no chat rows when no chat is open', async () => {
    // The negative half of the derivation: a row exists iff a chat does.
    await renderCommandPalette();
    open();
    expect(
      screen
        .getAllByRole('option')
        .map((option) => option.textContent?.trim() ?? '')
        .filter((label) => /Switch to session|Refactor the parser/.test(label)),
    ).toEqual([]);
  });

  test('a streaming chat does not rebuild the command index while the palette is closed', async () => {
    // `activeChatsStore` notifies per streamed token, and the palette used
    // to subscribe to that whole snapshot — so every token of every streaming
    // chat rebuilt, reranked and regrouped the entire command index, then the
    // component returned `null` because the palette was shut.
    activeChatsStore.initChat('session-alpha', {
      agentSlug: 'claude',
      agentName: 'Claude',
      title: 'Refactor the parser',
    });
    try {
      await renderCommandPalette();
      // Deliberately NOT opened.
      const baseline = indexRebuilds.count;

      await streamTokensCommitted('session-alpha', 25);

      expect(indexRebuilds.count).toBe(baseline);
    } finally {
      activeChatsStore.removeChat('session-alpha');
    }
  });

  test('while open, only a chat identity change rebuilds the index', async () => {
    activeChatsStore.initChat('session-alpha', {
      agentSlug: 'claude',
      agentName: 'Claude',
      title: 'Refactor the parser',
    });
    try {
      await renderCommandPalette();
      open();
      const afterOpen = indexRebuilds.count;

      // Message-shaped churn: not part of a chat's identity.
      await streamTokensCommitted('session-alpha', 25);
      expect(indexRebuilds.count).toBe(afterOpen);

      // A title change IS an identity change, and must reach the row.
      await act(async () => {
        activeChatsStore.updateChat('session-alpha', {
          title: 'Renamed chat',
        });
      });
      expect(indexRebuilds.count).toBeGreaterThan(afterOpen);
      expect(
        screen
          .getAllByRole('option')
          .some((option) => option.textContent?.startsWith('Renamed chat')),
      ).toBe(true);
    } finally {
      activeChatsStore.removeChat('session-alpha');
    }
  });

  test('renders an unreachable Station distinctly from a searched-and-empty Station', async () => {
    messageSearchMock = {
      matches: [],
      instances: [
        { instanceId: 'empty', instanceName: 'Desk Station', status: 'empty' },
        {
          instanceId: 'down',
          instanceName: 'Remote Station',
          status: 'unreachable',
        },
      ],
    };
    await renderCommandPalette();
    open();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'co' } });

    expect(screen.getByText('Desk Station: no matching messages')).toBeTruthy();
    expect(screen.getByText('Remote Station: unreachable')).toBeTruthy();
  });

  test('keeps remote message identity through selection and never invokes the local chat opener', async () => {
    messageSearchMock = {
      matches: [
        {
          conversationId: 'colliding-thread',
          messageId: 'remote-message',
          agentSlug: 'claude',
          role: 'assistant',
          excerpt: 'cobalt on a second Station',
          sourceInstanceId: 'env-second',
          sourceInstanceName: 'Second Station',
        },
      ],
      instances: [
        {
          instanceId: 'env-second',
          instanceName: 'Second Station',
          status: 'available',
        },
      ],
      deferredInstanceCount: 0,
    };
    const focusLocal = vi.fn();
    const focusRemote = vi.fn();
    const unregister = openChatsStore.registerNavigation({
      focus: focusLocal,
      focusRemote,
      openCollection: vi.fn(),
    });
    await renderCommandPalette();
    open();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'co' } });

    expect(
      screen.getByText(
        /On Second Station .* Remote opening is not available here; review its connection/,
      ),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole('option', { name: /cobalt on a second Station/ }),
    );

    expect(focusRemote).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'colliding-thread',
        sourceInstanceId: 'env-second',
        sourceInstanceName: 'Second Station',
      }),
    );
    expect(focusLocal).not.toHaveBeenCalled();
    expect(
      screen.getByRole('dialog', { name: 'Command palette' }),
    ).toBeTruthy();
    unregister();
  });

  test('summarizes deferred Stations instead of rendering one status span per peer', async () => {
    messageSearchMock = {
      matches: [],
      instances: [
        {
          instanceId: 'searched',
          instanceName: 'Desk Station',
          status: 'empty',
        },
      ],
      deferredInstanceCount: 984,
    };
    await renderCommandPalette();
    open();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'co' } });

    expect(
      screen.getByText('984 more instances deferred by capacity limit'),
    ).toBeTruthy();
    expect(screen.queryByText(/not searched \(capacity limit\)/)).toBeNull();
  });

  test('opens on ⌘K handler and renders navigation commands', async () => {
    await renderCommandPalette();
    expect(screen.queryByRole('dialog')).toBeNull();
    open();
    const dialog = screen.getByRole('dialog', { name: 'Command palette' });
    expect(dialog).toBeTruthy();
    expect(screen.getByRole('option', { name: /Agents/ })).toBeTruthy();
    expect(
      screen.getByRole('option', { name: /Run registered command/ }),
    ).toBeTruthy();
  });

  test('projects both registered region toggles into the command palette', async () => {
    const chat = REGION_SURFACE_REGISTRY.get('chat');
    const activity = REGION_SURFACE_REGISTRY.get('activity');
    expect(chat).toBeTruthy();
    expect(activity).toBeTruthy();
    registeredShortcutIdentity = {
      id: chat!.shortcut!.id,
      key: chat!.shortcut!.key,
      modifiers: [...chat!.shortcut!.modifiers],
      description: `Toggle ${chat!.title} region`,
    };
    additionalRegisteredShortcutIdentities = [
      {
        id: activity!.shortcut!.id,
        key: activity!.shortcut!.key,
        modifiers: [...activity!.shortcut!.modifiers],
        description: `Toggle ${activity!.title} region`,
      },
    ];

    await renderCommandPalette();
    open();

    fireEvent.click(screen.getByRole('option', { name: /Toggle Chat region/ }));
    open();
    fireEvent.click(
      screen.getByRole('option', { name: /Toggle Activity region/ }),
    );
    expect(registeredCommand).toHaveBeenCalledTimes(2);
  });

  // #766 item 4: the Report-a-problem entry point is a palette action that
  // dispatches the host's open event; the dialog itself is lazily hosted by
  // DeferredAppOverlays.
  test('registers Report a problem and dispatches its open event', async () => {
    const { OPEN_REPORT_PROBLEM_EVENT } = await import(
      '../lib/reportProblemEvents'
    );
    const listener = vi.fn();
    window.addEventListener(OPEN_REPORT_PROBLEM_EVENT, listener);
    try {
      await renderCommandPalette();
      open();
      fireEvent.change(screen.getByRole('combobox'), {
        target: { value: 'report a problem' },
      });
      fireEvent.click(screen.getByRole('option', { name: /Report a problem/ }));
      expect(listener).toHaveBeenCalledTimes(1);
      // The palette closes so the dialog is what the user sees next.
      expect(screen.queryByRole('dialog')).toBeNull();
    } finally {
      window.removeEventListener(OPEN_REPORT_PROBLEM_EVENT, listener);
    }
  });

  test('Enter runs the highlighted command then closes', async () => {
    await renderCommandPalette();
    open();
    const input = screen.getByRole('combobox');
    // Filter down to a single nav command so the highlight is deterministic.
    fireEvent.change(input, { target: { value: 'schedule' } });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' });
    expect(navigateMock).toHaveBeenCalledWith('/schedule');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('Activity navigation reveals its registered region surface', async () => {
    await renderCommandPalette();
    open();
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'activity' },
    });
    // #928: `/activity` is not the only wrong destination any more — the
    // registry's `route` field now holds the surface's deep link, so a
    // palette entry that fell through to `navigate(surface.route)` would
    // reach a real URL and look like it worked. Count the calls across the
    // click instead of naming one absent path. (Mocks are not auto-cleared
    // in this suite, so the baseline is read rather than assumed to be 0.)
    const navigationsBefore = navigateMock.mock.calls.length;
    fireEvent.click(screen.getByRole('option', { name: /^Activity/ }));

    expect(showSurfaceMock).toHaveBeenCalledWith('activity');
    expect(navigateMock.mock.calls.length).toBe(navigationsBefore);
  });

  test('IME Enter does not run the highlighted command, then plain Enter does', async () => {
    await renderCommandPalette();
    open();
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'schedule' } });
    fireEvent.keyDown(input, {
      key: 'Enter',
      isComposing: true,
      keyCode: 229,
    });
    expect(navigateMock).not.toHaveBeenCalled();
    expect(
      screen.getByRole('dialog', { name: 'Command palette' }),
    ).toBeTruthy();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(navigateMock).toHaveBeenCalledWith('/schedule');
  });

  test('runs a command from the shared shortcut registry', async () => {
    await renderCommandPalette();
    open();
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'registered command' } });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' });
    expect(registeredCommand).toHaveBeenCalledTimes(1);
    expect(commandFrecencyStorage.read()).toEqual([
      expect.objectContaining({
        commandId: 'command:app.registered',
        count: 1,
      }),
    ]);
  });

  test('records keyboard and pointer selections exactly once each', async () => {
    await renderCommandPalette();
    open();
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'registered command' } });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' });

    open();
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'registered command' },
    });
    fireEvent.click(
      screen.getByRole('option', { name: /Run registered command/ }),
    );

    expect(registeredCommand).toHaveBeenCalledTimes(2);
    expect(commandFrecencyStorage.read()).toEqual([
      expect.objectContaining({
        commandId: 'command:app.registered',
        count: 2,
      }),
    ]);
  });

  test('never invokes or records a disabled shared shortcut', async () => {
    registeredShortcutAvailability = { disabled: true };
    await renderCommandPalette();
    open();
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'registered command' } });
    const option = screen.getByRole('option', {
      name: /Run registered command/,
    });

    expect(option.getAttribute('aria-disabled')).toBe('true');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' });
    fireEvent.click(option);
    expect(registeredCommand).not.toHaveBeenCalled();
    expect(commandFrecencyStorage.read()).toEqual([]);
  });

  test('re-checks a shared shortcut when guard before pointer execution or recording', async () => {
    registeredShortcutAvailability = { when: 'terminalFocused' };
    shortcutWhenEnabled = true;
    await renderCommandPalette();
    open();
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'registered command' } });
    const option = screen.getByRole('option', {
      name: /Run registered command/,
    });
    expect(option.getAttribute('aria-disabled')).toBeNull();

    // Mutation-power proof: availability changes after the row was indexed.
    // A projection-only fix would still call the raw handler here.
    shortcutWhenEnabled = false;
    fireEvent.click(option);
    expect(registeredCommand).not.toHaveBeenCalled();
    expect(commandFrecencyStorage.read()).toEqual([]);
  });

  test('Arrow keys move highlight before Enter', async () => {
    projectsMock = [{ slug: 'alpha', name: 'Alpha' }];
    await renderCommandPalette();
    open();
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'al' } }); // matches "Alpha"
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' });
    expect(setProjectMock).toHaveBeenCalledWith('alpha');
  });

  test('Esc closes the palette', async () => {
    await renderCommandPalette();
    open();
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('keeps an unavailable pane in the listbox and reveals its bounded reason', async () => {
    paneCatalogMock = {
      descriptors: [
        {
          id: 'builtin:preview',
          name: 'Preview',
          description: 'Preview files',
          renderer: { kind: 'builtin-component', name: 'preview' },
          modes: [{ id: 'default' }],
        },
      ],
      instances: [{ descriptorId: 'builtin:preview', instanceId: 'preview-1' }],
      availability: [
        {
          descriptorId: 'builtin:preview',
          instanceId: 'preview-1',
          input: {
            rollout: 'available',
            distribution: 'enabled',
            requirements: { configuration: true },
            configuration: 'missing',
          },
          availability: {
            state: 'not-configured',
            reason: { code: 'configuration-missing', source: 'configuration' },
            action: { type: 'setup', code: 'complete-configuration' },
          },
        },
      ],
    };
    await renderCommandPalette();
    open();
    // Exact-prefix match: the palette now also contains a "Feature Previews"
    // navigation entry (archive#2961), which the loose /Preview/ regex matched too.
    // Anchored to the pane row's own accessible name ("Preview Temporarily
    // unavailable: … Workspace panes"): the palette also contains a "Feature
    // Previews" navigation entry (archive#2961), which the original loose /Preview/
    // regex matched as well.
    const option = screen.getByRole('option', {
      // Anchored to the pane row's accessible name (label + unavailability
      // note; accessible-name computation joins the spans without a space):
      // the palette also contains a "Feature Previews" navigation entry
      // (archive#2961), which the original loose /Preview/ regex matched as well.
      name: /^Preview ?Temporarily unavailable/,
    });
    expect(option.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(option);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain(
      'The pane renderer is currently unavailable.',
    );
    expect(navigateMock).not.toHaveBeenCalled();
    expect(commandFrecencyStorage.read()).toEqual([]);
  });

  test('reset keeps the palette open, reports local feedback, and restores baseline history', async () => {
    await renderCommandPalette();
    open();
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'registered command' },
    });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' });
    expect(commandFrecencyStorage.read()).toHaveLength(1);

    open();
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'reset command history' } });
    fireEvent.click(
      screen.getByRole('option', { name: /Reset command history/ }),
    );

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(
      screen.getByText('Command history reset on this device.'),
    ).toBeTruthy();
    expect(commandFrecencyStorage.read()).toEqual([]);
  });

  test('keeps an unplaced coming-soon descriptor in the command list', async () => {
    paneCatalogMock = {
      descriptors: [
        {
          id: 'builtin:browser-preview',
          name: 'Browser Preview',
          renderer: {
            kind: 'builtin-component',
            name: 'workspace-browser-preview',
          },
          modes: [{ id: 'default' }],
        },
      ],
      instances: [],
      availability: [
        {
          descriptorId: 'builtin:browser-preview',
          input: { rollout: 'coming-soon' },
          availability: {
            state: 'coming-soon',
            reason: { code: 'coming-soon', source: 'product-rollout' },
            action: { type: 'learn-more', code: 'view-rollout' },
          },
        },
      ],
    };
    await renderCommandPalette();
    open();

    const option = screen.getByRole('option', { name: /Browser Preview/ });
    expect(option.textContent).toContain('Coming soon');
    fireEvent.click(option);
    expect(screen.getByRole('status').textContent).toContain(
      'This pane has not rolled out yet.',
    );
    expect(navigateMock).not.toHaveBeenCalled();
  });

  test('opens a layout-bound pane through its exact selected Project layout', async () => {
    selectedProjectLayoutMock = 'coding';
    paneCatalogMock = {
      projectId: 'project-uuid',
      descriptors: [WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR],
      instances: [
        {
          descriptorId: 'pane:builtin:coding:file-browser',
          instanceId: 'workspace-files',
        },
      ],
      availability: [
        {
          descriptorId: 'pane:builtin:coding:file-browser',
          instanceId: 'workspace-files',
          input: {
            rollout: 'available',
            distribution: 'enabled',
            context: { project: 'present', workspace: 'present' },
          },
          availability: {
            state: 'available',
            reason: { code: 'ready', source: 'resolver' },
          },
        },
      ],
    };
    await renderCommandPalette();
    open();

    fireEvent.click(screen.getByRole('option', { name: /Files/ }));

    expect(navigateMock).toHaveBeenCalledWith(
      '/projects/alpha/layouts/coding/panes/pane%3Abuiltin%3Acoding%3Afile-browser/workspace-files',
    );
  });

  test('keeps a layout-bound pane visible and explains why it cannot open without a selected layout', async () => {
    paneCatalogMock = {
      projectId: 'project-uuid',
      descriptors: [WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR],
      instances: [
        {
          descriptorId: 'pane:builtin:coding:terminal',
          instanceId: 'workspace-terminal',
        },
      ],
      availability: [
        {
          descriptorId: 'pane:builtin:coding:terminal',
          instanceId: 'workspace-terminal',
          input: {
            rollout: 'available',
            distribution: 'enabled',
            context: { project: 'present', workspace: 'present' },
          },
          availability: {
            state: 'available',
            reason: { code: 'ready', source: 'resolver' },
          },
        },
      ],
    };
    await renderCommandPalette();
    open();

    const option = screen.getByRole('option', { name: /Terminal/ });
    expect(option.getAttribute('aria-disabled')).toBe('true');
    expect(option.textContent).toContain('Layout needed');
    fireEvent.click(option);

    expect(screen.getByRole('status').textContent).toContain(
      'Open this Project layout before using this pane.',
    );
    expect(navigateMock).not.toHaveBeenCalled();
  });

  test('opens the Coding renderer through its exact selected Project layout', async () => {
    selectedProjectLayoutMock = 'coding';
    const coding = paneAdaptationFromLayoutTab(
      {
        id: 'coding',
        label: 'Coding',
        component: { kind: 'builtin-component', name: 'coding' },
      },
      {
        layoutSlug: 'coding',
        instanceScope: 'project:project-uuid:source:builtin:coding',
        modeContextRequirement: { project: true, source: true },
        boundContext: {
          projectId: 'project-uuid',
          sourceId: 'builtin:coding',
        },
      },
    )!;
    paneCatalogMock = {
      projectId: 'project-uuid',
      descriptors: [coding.descriptor],
      instances: [coding.instance],
      availability: [
        {
          descriptorId: coding.descriptor.id,
          instanceId: coding.instance.instanceId,
          input: {
            rollout: 'available',
            distribution: 'enabled',
            context: { project: 'present' },
          },
          availability: {
            state: 'available',
            reason: { code: 'ready', source: 'resolver' },
          },
        },
      ],
    };
    await renderCommandPalette();
    open();

    fireEvent.click(screen.getByRole('option', { name: /Coding/ }));

    expect(navigateMock).toHaveBeenCalledWith(
      `/projects/alpha/layouts/coding/panes/${encodeURIComponent(coding.descriptor.id)}/${encodeURIComponent(coding.instance.instanceId)}`,
    );
  });
});

// --- active option is announced --------------------------------------------

/**
 * Focus never leaves the combobox while the arrows move the highlight, so
 * `aria-activedescendant` is the ONLY channel telling a screen reader which
 * option is current. The option ids already existed and nothing pointed at
 * them: arrowing through results announced nothing at all.
 */
describe('CommandPalette active-option announcement', () => {
  test('the combobox points at the highlighted option, and follows the arrows', async () => {
    projectsMock = [
      { slug: 'alpha', name: 'Alpha' },
      { slug: 'alpine', name: 'Alpine' },
    ];
    await renderCommandPalette();
    open();
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'alp' } });

    const first = input.getAttribute('aria-activedescendant');
    expect(first).toBeTruthy();
    // It must name a node that exists — a dangling id announces nothing.
    expect(document.getElementById(first as string)).toBeTruthy();
    expect(
      document.getElementById(first as string)?.getAttribute('aria-selected'),
    ).toBe('true');

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowDown' });

    const second = input.getAttribute('aria-activedescendant');
    expect(second).not.toBe(first);
    expect(
      document.getElementById(second as string)?.getAttribute('aria-selected'),
    ).toBe('true');
  });

  test('with no results it points at nothing rather than a dangling id', async () => {
    await renderCommandPalette();
    open();
    const input = screen.getByRole('combobox');
    fireEvent.change(input, {
      target: { value: 'zzzznotacommandzzzz' },
    });

    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
  });
});

// --- return focus (archive#1245) -------------------------------------------

/**
 * The palette's restore was `previouslyFocused.current.focus?.` with no
 * `isConnected` guard at all — worse than the shape archive#1126 was filed
 * against — and nothing in this file covered it. It now goes through
 * `@kontourai/station-shared/return-focus`.
 *
 * COVERAGE HONESTY. These are jsdom tests, and they cover the *wiring*: that
 * the palette captures a chain from the right element at the right moment and
 * hands it to the shared module. The module's own two halves are proven
 * elsewhere and neither suite covers both — the structural veto in
 * `packages/shared/src/__tests__/return-focus.test.ts` (jsdom), and the
 * "did the focus actually land?" verification in
 * `tests/dialog-return-focus.spec.ts` (Chromium), which jsdom structurally
 * cannot see because it reports `.focus` on a hidden node as successful.
 */
describe('CommandPalette return focus (station#1245)', () => {
  function stubFrame() {
    const frame: { callback: FrameRequestCallback | null } = { callback: null };
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frame.callback = cb;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    return frame;
  }

  function mountTrigger() {
    const list = document.createElement('div');
    const row = document.createElement('div');
    const trigger = document.createElement('button');
    row.append(trigger);
    list.append(row);
    document.body.append(list);
    trigger.focus();
    return { list, row, trigger };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  /**
   * Also the regression test for *when* the chain is captured. The palette's
   * input carries `autoFocus`, which React applies while committing the
   * palette's DOM — before any effect runs — so capturing inside the `open`
   * effect records the palette's own input and this assertion lands on
   * `<body>`.
   */
  test('restores focus to the element that opened it', async () => {
    const frame = stubFrame();
    const { list, trigger } = mountTrigger();

    await renderCommandPalette();
    open();
    expect(document.activeElement).not.toBe(trigger);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    act(() => {
      frame.callback?.(0);
    });

    expect(document.activeElement).toBe(trigger);
    expect(trigger.hasAttribute('tabindex')).toBe(false);
    list.remove();
  });

  /**
   * The palette's characteristic case: every command navigates, so the control
   * that opened it is routinely unmounted by the command it just ran. Pre-fix
   * this left `activeElement` on `<body>` — archive#1126, with no guard at all.
   */
  test('falls back to a surviving ancestor when the command unmounted the trigger', async () => {
    const frame = stubFrame();
    const { list, row, trigger } = mountTrigger();

    await renderCommandPalette();
    open();
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'schedule' } });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' });
    // The destination view replaced the row the trigger lived on.
    row.remove();
    act(() => {
      frame.callback?.(0);
    });

    expect(navigateMock).toHaveBeenCalledWith('/schedule');
    expect(document.activeElement).toBe(list);
    expect(document.activeElement).not.toBe(document.body);
    expect(trigger.isConnected).toBe(false);
    list.remove();
  });

  /** Gap 1: the destination's own initial focus must not be overridden. */
  test('leaves focus alone when the destination already claimed it', async () => {
    const frame = stubFrame();
    const { list, row } = mountTrigger();
    const destination = document.createElement('input');
    document.body.append(destination);

    await renderCommandPalette();
    open();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    row.remove();
    destination.focus();
    act(() => {
      frame.callback?.(0);
    });

    expect(document.activeElement).toBe(destination);
    expect(list.hasAttribute('tabindex')).toBe(false);
    list.remove();
    destination.remove();
  });
});
