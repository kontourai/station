// @vitest-environment jsdom
/**
 * One way to start a chat (owner, 2026-10): Home's composer and the dock's
 * draft are the SAME component over the SAME selection model and memory.
 * These mount both at once over the real `useNewChatSelectionModel` (only
 * the server reads are doubles) and pin what the owner decided:
 *
 * - both render the shared `StartComposer` and open on the same selection;
 * - a chip change on one surface is remembered and drives the next start on
 *   the other;
 * - the project chip rebinds the dock, so both surfaces open on it.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { displayableProjectIcon } from '../components/icons/ProjectIcon';
import { projectAccents } from '../components/project-sidebar/projectAccent';
import type { AgentData } from '../contexts/AgentsContext';
import { AuthorityPersistenceContext } from '../contexts/AuthorityPersistenceContext';
import type { ProjectMetadata } from '../contexts/ProjectsContext';
import {
  buildLastChosenModelBindingKey,
  trackLastChosenModel,
} from '../hooks/lastChosenModel';
import { resetStartChoicesForTests } from '../hooks/useStartSelection';
import { deviceSettingsStore } from '../lib/device-settings-store';

const state = vi.hoisted(() => ({
  agents: [] as unknown[],
  projects: [] as unknown[],
  projectsLoading: false,
  projectsError: false,
  agentConnections: [] as unknown[],
}));

vi.mock('../contexts/ApiBaseContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'parity-authority',
    isCurrent: () => true,
  }),
}));
vi.mock('../hooks/useDevicePresentation', () => ({
  useDevicePresentation: () => undefined,
}));
vi.mock('@kontourai/station-sdk', () => ({
  useAgentsQuery: () => ({
    data: state.agents,
    isFetching: false,
    error: null,
    dataUpdatedAt: 0,
    refetch: async () => ({}),
  }),
  // The error shape is the real one: no data, not loading, not success.
  useProjectsQuery: () => ({
    data:
      state.projectsLoading || state.projectsError ? undefined : state.projects,
    isLoading: state.projectsLoading,
    isFetching: false,
    isSuccess: !state.projectsLoading && !state.projectsError,
    isError: state.projectsError,
    error: state.projectsError ? new Error('projects unavailable') : null,
    refetch: async () => ({}),
  }),
  useProjectQuery: () => ({
    data: {},
    isFetching: false,
    isSuccess: true,
    error: null,
    refetch: async () => ({}),
  }),
  useModelPickerCatalogQuery: () => ({
    data: { agentConnections: state.agentConnections, modelConnections: [] },
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: async () => ({}),
  }),
  useACPConnectionsQuery: () => ({
    data: [],
    isFetching: false,
    error: null,
    refetch: async () => ({}),
  }),
  useProjectLayoutQuery: () => ({ data: undefined }),
  useSkillExperienceInventoryQuery: () => ({
    data: { experiences: [], diagnostics: [] },
    isPending: false,
    error: null,
    refetch: vi.fn(),
  }),
  useMaterializeEngineAgentMutation: () => ({ mutateAsync: vi.fn() }),
  telemetry: { track: vi.fn() },
}));
vi.mock('../contexts/ConfigContext', () => ({ useConfig: () => undefined }));
// The Model picker's own UI has its own tests; here it is the choice it makes.
vi.mock('../components/session/SessionModelPicker', () => ({
  SessionModelPicker: ({
    onSelect,
    onReset,
    onRuntimeOptionChange,
    onClose,
  }: {
    onSelect: (model: { id: string; name: string }) => void;
    onReset: () => void;
    onRuntimeOptionChange: (key: string, value: string) => void;
    onClose: () => void;
  }) => (
    <>
      <button
        type="button"
        onClick={() => {
          onSelect({ id: 'sonnet', name: 'Sonnet' });
          onClose();
        }}
      >
        Choose Sonnet
      </button>
      <button
        type="button"
        onClick={() => onRuntimeOptionChange('effort', 'high')}
      >
        Set effort high
      </button>
      <button
        type="button"
        onClick={() => {
          onReset();
          onClose();
        }}
      >
        Use default
      </button>
    </>
  ),
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ selectedProject: null, selectedProjectLayout: null }),
}));
vi.mock('../contexts/ActiveChatsContext', () => ({
  activeChatsStore: { getSnapshot: () => ({}) },
}));

const {
  HomeStartComposer,
  reloadHeldHomeDraftsForTests,
  resetHeldHomeDraftsForTests,
} = await import('../components/home/HomeStartComposer');
const { NewChatModal } = await import('../components/modals/NewChatModal');

const CLAUDE = {
  slug: 'claude',
  name: 'Claude',
  available: true,
  model: 'opus',
  modelOptions: [
    { id: 'opus', name: 'Opus' },
    { id: 'sonnet', name: 'Sonnet' },
  ],
} as unknown as AgentData;
const CODEX = {
  slug: 'codex',
  name: 'Codex',
  available: true,
  model: 'gpt-5.4',
  modelOptions: [{ id: 'gpt-5.4', name: 'GPT-5.4' }],
} as unknown as AgentData;
const STATION = {
  id: 'p1',
  slug: 'station',
  name: 'Station',
  workingDirectory: '/work/station',
} as ProjectMetadata;

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
  Element.prototype.scrollIntoView = vi.fn();
});
beforeEach(() => {
  resetStartChoicesForTests();
  localStorage.clear();
  sessionStorage.clear();
  deviceSettingsStore.set('chatDockProjectSlug', null);
  state.agents = [CLAUDE, CODEX];
  state.projects = [STATION];
  state.projectsLoading = false;
  state.projectsError = false;
  state.agentConnections = [];
  resetHeldHomeDraftsForTests();
});
// Every dock listener a test adds, removed even when the test fails, so a
// later test's "no dock" is real.
const dockListeners: Array<(event: Event) => void> = [];
const realAdd = window.addEventListener.bind(window);
window.addEventListener = ((type: string, listener: never, options?: never) => {
  if (type === 'station:open-new-chat') dockListeners.push(listener);
  return realAdd(type, listener, options);
}) as typeof window.addEventListener;
afterEach(() => {
  cleanup();
  for (const listener of dockListeners.splice(0))
    window.removeEventListener('station:open-new-chat', listener);
});

function renderBoth() {
  const dockSelect = vi.fn();
  const starts: CustomEvent[] = [];
  // A dock that takes the intent, as ChatDock does.
  const listener = (event: Event) => {
    event.preventDefault();
    starts.push(event as CustomEvent);
  };
  window.addEventListener('station:open-new-chat', listener);
  const view = render(
    <AuthorityPersistenceContext.Provider
      value={{ status: 'verified', namespace: 'ns-1', observation: null }}
    >
      <div data-testid="home">
        <HomeStartComposer />
      </div>
      <div data-testid="dock">
        <NewChatModal
          startSurface
          agents={state.agents as AgentData[]}
          projects={state.projects as ProjectMetadata[]}
          activeProjectSlug={deviceSettingsStore.get('chatDockProjectSlug')}
          projectBindable
          // As ChatDock passes it: the sidebar's colours over the whole list.
          projectAccentBySlug={projectAccents(
            (state.projects as ProjectMetadata[]).map(({ slug }) => slug),
          )}
          projectIconBySlug={
            new Map(
              (state.projects as ProjectMetadata[]).flatMap(
                ({ slug, icon }) => {
                  const shown = displayableProjectIcon(icon);
                  return shown ? [[slug, shown] as const] : [];
                },
              ),
            )
          }
          onSelect={dockSelect}
          onClose={vi.fn()}
        />
      </div>
    </AuthorityPersistenceContext.Provider>,
  );
  return {
    view,
    dockSelect,
    starts,
    home: () => within(screen.getByTestId('home')),
    dock: () => screen.getByRole('dialog', { name: 'New chat' }),
    cleanupListener: () =>
      window.removeEventListener('station:open-new-chat', listener),
  };
}

const formOf = (root: HTMLElement) =>
  within(root).getByRole('form', { name: 'Start work' });
const agentChip = (root: HTMLElement) =>
  within(formOf(root)).getByRole('button', { name: /^Agent:/ });
const projectChip = (root: HTMLElement) =>
  within(formOf(root)).getByRole('button', { name: /^Project:/ });

describe('Home and the dock start the same way', () => {
  test('both render the shared composer and open on the same selection', () => {
    const ui = renderBoth();
    const home = screen.getByTestId('home');
    const dock = ui.dock();
    for (const root of [home, dock]) {
      expect(formOf(root).classList.contains('start-composer')).toBe(true);
      expect(
        within(formOf(root)).getByRole('button', { name: 'Start' }),
      ).toBeTruthy();
    }
    expect(agentChip(home).getAttribute('aria-label')).toBe(
      agentChip(dock).getAttribute('aria-label'),
    );
    expect(agentChip(home).getAttribute('aria-label')).toBe(
      'Agent: Claude · Opus',
    );
    expect(projectChip(home).getAttribute('aria-label')).toBe(
      projectChip(dock).getAttribute('aria-label'),
    );
    ui.cleanupListener();
  });

  test('with the dock bound to a project both open on that project', () => {
    deviceSettingsStore.set('chatDockProjectSlug', 'station');
    const ui = renderBoth();
    const home = screen.getByTestId('home');
    const dock = ui.dock();
    expect(projectChip(home).getAttribute('aria-label')).toBe(
      'Project: Station',
    );
    expect(projectChip(dock).getAttribute('aria-label')).toBe(
      'Project: Station',
    );
    expect(agentChip(home).getAttribute('aria-label')).toBe(
      agentChip(dock).getAttribute('aria-label'),
    );
    ui.cleanupListener();
  });

  test('an Agent chosen in the dock is remembered and is what Home starts next', async () => {
    const ui = renderBoth();
    const home = screen.getByTestId('home');
    const dock = ui.dock();
    fireEvent.click(agentChip(dock));
    const menu = await screen.findByRole(
      'dialog',
      { name: 'Choose agent' },
      { timeout: 15_000 },
    );
    fireEvent.click(
      menu.querySelector<HTMLButtonElement>('button[data-agent-slug="codex"]')!,
    );
    // Home re-derives from the remembered choice while it stays mounted.
    await waitFor(() =>
      expect(agentChip(home).getAttribute('aria-label')).toBe(
        'Agent: Codex · gpt-5.4',
      ),
    );
    fireEvent.change(
      within(formOf(home)).getByRole('textbox', {
        name: 'What would you like done?',
      }),
      { target: { value: 'Ship it' } },
    );
    fireEvent.click(
      within(formOf(home)).getByRole('button', { name: 'Start' }),
    );
    const start = ui.starts.at(-1)!;
    expect(start.detail.startWithDefault).toBe(true);
    expect(start.detail.selection).toMatchObject({
      context: '__global__',
      agentSlug: 'codex',
    });
    expect(ui.dockSelect).not.toHaveBeenCalled();
    ui.cleanupListener();
  });

  test('an Agent chosen on Home is remembered and is what the dock starts next', async () => {
    const ui = renderBoth();
    const home = screen.getByTestId('home');
    fireEvent.click(agentChip(home));
    const menu = await screen.findByRole(
      'dialog',
      { name: 'Choose agent' },
      { timeout: 15_000 },
    );
    fireEvent.click(
      menu.querySelector<HTMLButtonElement>('button[data-agent-slug="codex"]')!,
    );
    await waitFor(() =>
      expect(agentChip(ui.dock()).getAttribute('aria-label')).toBe(
        'Agent: Codex · gpt-5.4',
      ),
    );
    const dock = ui.dock();
    fireEvent.change(
      within(formOf(dock)).getByRole('textbox', {
        name: 'What would you like done?',
      }),
      { target: { value: 'Ship it' } },
    );
    fireEvent.click(
      within(formOf(dock)).getByRole('button', { name: 'Start' }),
    );
    expect(ui.dockSelect).toHaveBeenCalledTimes(1);
    expect(ui.dockSelect.mock.calls[0][0].slug).toBe('codex');
    ui.cleanupListener();
  });

  // Review finding: after a pick on Home, a later pick in the dock must
  // still move Home's chip; the remembered choice is the chip.
  test('a pick on Home does not pin Home against a later pick in the dock', async () => {
    const ui = renderBoth();
    const home = screen.getByTestId('home');
    const pick = async (root: HTMLElement, slug: string) => {
      fireEvent.click(agentChip(root));
      const menu = await screen.findByRole(
        'dialog',
        { name: 'Choose agent' },
        { timeout: 15_000 },
      );
      fireEvent.click(
        menu.querySelector<HTMLButtonElement>(
          `button[data-agent-slug="${slug}"]`,
        )!,
      );
      await waitFor(() =>
        expect(
          screen.queryByRole('dialog', { name: 'Choose agent' }),
        ).toBeNull(),
      );
    };
    await pick(home, 'codex');
    await pick(ui.dock(), 'claude');
    await waitFor(() =>
      expect(agentChip(home).getAttribute('aria-label')).toBe(
        'Agent: Claude · Opus',
      ),
    );
    expect(agentChip(ui.dock()).getAttribute('aria-label')).toBe(
      'Agent: Claude · Opus',
    );
    ui.cleanupListener();
  }, 30_000);

  test('a Model chosen in the dock is remembered and is what Home names next', async () => {
    const ui = renderBoth();
    const home = screen.getByTestId('home');
    fireEvent.click(agentChip(ui.dock()));
    const menu = await screen.findByRole(
      'dialog',
      { name: 'Choose agent' },
      { timeout: 15_000 },
    );
    fireEvent.click(within(menu).getByRole('button', { name: /^Model: Opus/ }));
    fireEvent.click(
      await screen.findByRole(
        'button',
        { name: 'Choose Sonnet' },
        { timeout: 15_000 },
      ),
    );
    await waitFor(() =>
      expect(agentChip(home).getAttribute('aria-label')).toMatch(
        /^Agent: Claude · [Ss]onnet$/,
      ),
    );
    expect(agentChip(ui.dock()).getAttribute('aria-label')).toMatch(
      /^Agent: Claude · [Ss]onnet$/,
    );
    ui.cleanupListener();
  }, 30_000);

  async function openModelPicker(root: HTMLElement) {
    fireEvent.click(agentChip(root));
    const menu = await screen.findByRole(
      'dialog',
      { name: 'Choose agent' },
      { timeout: 15_000 },
    );
    // Claude's row's own Model control, whatever Model it names now.
    const row = menu
      .querySelector('button[data-agent-slug="claude"]')!
      .closest<HTMLElement>('.new-chat-modal__agent-row')!;
    fireEvent.click(within(row).getByRole('button', { name: /^Model: / }));
    return screen.findByRole(
      'button',
      { name: 'Choose Sonnet' },
      { timeout: 15_000 },
    );
  }

  // Delta review: a Reset on one surface is a Reset on the other.
  test('a Model Reset in the dock returns both chips to the default', async () => {
    const ui = renderBoth();
    const home = screen.getByTestId('home');
    fireEvent.click(await openModelPicker(home));
    await waitFor(() =>
      expect(agentChip(ui.dock()).getAttribute('aria-label')).toBe(
        'Agent: Claude · Sonnet',
      ),
    );
    await openModelPicker(ui.dock());
    fireEvent.click(screen.getByRole('button', { name: 'Use default' }));
    await waitFor(() =>
      expect(agentChip(home).getAttribute('aria-label')).toBe(
        'Agent: Claude · Opus',
      ),
    );
    expect(agentChip(ui.dock()).getAttribute('aria-label')).toBe(
      'Agent: Claude · Opus',
    );
    ui.cleanupListener();
  }, 30_000);

  // Delta review: a runtime option set on either surface is the option the
  // start sends, from either surface.
  test('a runtime option set in the dock is what Home starts with', async () => {
    const ui = renderBoth();
    const home = screen.getByTestId('home');
    await openModelPicker(ui.dock());
    fireEvent.click(screen.getByRole('button', { name: 'Set effort high' }));
    fireEvent.change(
      within(formOf(home)).getByRole('textbox', {
        name: 'What would you like done?',
      }),
      { target: { value: 'Go' } },
    );
    await waitFor(() =>
      expect(
        within(formOf(home)).getByRole('button', { name: 'Start' }),
      ).not.toHaveProperty('disabled', true),
    );
    fireEvent.click(
      within(formOf(home)).getByRole('button', { name: 'Start' }),
    );
    expect(ui.starts.at(-1)!.detail.selection).toMatchObject({
      agentSlug: 'claude',
      model: { providerOptions: { effort: 'high' } },
    });
    ui.cleanupListener();
  }, 30_000);

  // Delta review: another chat's accepted turn writes the remembered Model;
  // it must not override a Model chosen on a chip in this tab.
  test("another chat's accepted turn does not override a chosen Model", async () => {
    const ui = renderBoth();
    const home = screen.getByTestId('home');
    fireEvent.click(await openModelPicker(ui.dock()));
    await waitFor(() =>
      expect(agentChip(home).getAttribute('aria-label')).toBe(
        'Agent: Claude · Sonnet',
      ),
    );
    act(() =>
      trackLastChosenModel(buildLastChosenModelBindingKey(CLAUDE), 'opus'),
    );
    expect(agentChip(home).getAttribute('aria-label')).toBe(
      'Agent: Claude · Sonnet',
    );
    expect(agentChip(ui.dock()).getAttribute('aria-label')).toBe(
      'Agent: Claude · Sonnet',
    );
    ui.cleanupListener();
  }, 30_000);

  test("Home's project pick yields when the dock is rebound elsewhere", async () => {
    const ui = renderBoth();
    const home = screen.getByTestId('home');
    fireEvent.click(projectChip(home));
    const menu = await screen.findByRole(
      'dialog',
      { name: 'Choose project' },
      { timeout: 15_000 },
    );
    fireEvent.click(
      menu.querySelector<HTMLButtonElement>('[data-context-value="station"]')!,
    );
    await waitFor(() =>
      expect(projectChip(home).getAttribute('aria-label')).toBe(
        'Project: Station',
      ),
    );
    act(() => deviceSettingsStore.set('chatDockProjectSlug', null));
    await waitFor(() =>
      expect(projectChip(home).getAttribute('aria-label')).toBe(
        'Project: No project',
      ),
    );
    ui.cleanupListener();
  }, 30_000);

  test('the project chip rebinds the dock, and No workspace clears the binding', async () => {
    const ui = renderBoth();
    const home = screen.getByTestId('home');
    fireEvent.click(projectChip(home));
    const menu = await screen.findByRole('dialog', { name: 'Choose project' });
    fireEvent.click(
      menu.querySelector<HTMLButtonElement>('[data-context-value="station"]')!,
    );
    expect(deviceSettingsStore.get('chatDockProjectSlug')).toBe('station');
    await waitFor(() =>
      expect(projectChip(home).getAttribute('aria-label')).toBe(
        'Project: Station',
      ),
    );
    fireEvent.click(projectChip(home));
    const again = await screen.findByRole('dialog', { name: 'Choose project' });
    fireEvent.click(
      again.querySelector<HTMLButtonElement>(
        '[data-context-value="__global__"]',
      )!,
    );
    expect(deviceSettingsStore.get('chatDockProjectSlug')).toBeNull();
    ui.cleanupListener();
  });

  // #3350 item 1, on Home: the dock names a project the list has not loaded.
  test('Home holds its chips and Start while the bound project list loads', () => {
    deviceSettingsStore.set('chatDockProjectSlug', 'station');
    state.projectsLoading = true;
    render(
      <AuthorityPersistenceContext.Provider
        value={{ status: 'verified', namespace: 'ns-1', observation: null }}
      >
        <HomeStartComposer />
      </AuthorityPersistenceContext.Provider>,
    );
    const form = screen.getByRole('form', { name: 'Start work' });
    fireEvent.change(
      within(form).getByRole('textbox', { name: 'What would you like done?' }),
      { target: { value: 'Wait' } },
    );
    expect(within(form).queryByRole('button', { name: /^Agent:/ })).toBeNull();
    expect(
      within(form).getByRole('status', {
        name: 'Checking which project the chat starts in',
      }),
    ).toBeTruthy();
    expect(
      (within(form).getByRole('button', { name: 'Start' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test('a setup action on Home hands the draft to the dock with the prompt and choices', async () => {
    state.agents = [
      {
        ...CLAUDE,
        available: false,
        unavailableReason: 'Connect a Model',
        unavailableFix: { kind: 'model-connection' },
      },
    ];
    const starts: CustomEvent[] = [];
    const listener = (event: Event) => {
      event.preventDefault();
      starts.push(event as CustomEvent);
    };
    window.addEventListener('station:open-new-chat', listener);
    localStorage.setItem(
      'station.newChat.lastAgentByContext',
      JSON.stringify({ [JSON.stringify(['ns-1', '__global__'])]: 'claude' }),
    );
    render(
      <AuthorityPersistenceContext.Provider
        value={{ status: 'verified', namespace: 'ns-1', observation: null }}
      >
        <HomeStartComposer />
      </AuthorityPersistenceContext.Provider>,
    );
    const form = screen.getByRole('form', { name: 'Start work' });
    fireEvent.change(
      within(form).getByRole('textbox', { name: 'What would you like done?' }),
      { target: { value: 'Keep this' } },
    );
    // The setup guidance is a lazy chunk; a cold transform can be slow.
    const connect = await screen.findByRole(
      'button',
      { name: /^Connect Claude/ },
      { timeout: 15_000 },
    );
    fireEvent.click(connect);
    const handoff = starts.at(-1)!;
    expect(handoff.detail).toMatchObject({
      initialPrompt: 'Keep this',
      selection: { context: '__global__', agentSlug: 'claude' },
      handoff: { kind: 'repair', agentSlug: 'claude', route: 'models' },
    });
    expect(handoff.detail.startWithDefault).not.toBe(true);
    // Visible: the draft says where it went, and Home no longer holds it.
    expect(screen.getByRole('status').textContent).toContain(
      'moved to the chat dock',
    );
    expect(
      (
        within(form).getByRole('textbox', {
          name: 'What would you like done?',
        }) as HTMLTextAreaElement
      ).value,
    ).toBe('');
    window.removeEventListener('station:open-new-chat', listener);
  }, 30_000);

  // Second review: a project with no folder is a real start context (the
  // server runs it in the home folder; the seeded `default` project is one).
  // Both surfaces offer it, name it the same, say where it runs, and
  // remember it across remounts.
  test('a project with no folder can be chosen, reads the same on both surfaces, and is remembered', async () => {
    state.projects = [
      STATION,
      { id: 'p2', slug: 'notes', name: 'Notes', workingDirectory: '' },
    ];
    const first = renderBoth();
    fireEvent.click(projectChip(screen.getByTestId('home')));
    const menu = await screen.findByRole(
      'dialog',
      { name: 'Choose project' },
      { timeout: 15_000 },
    );
    const notes = menu.querySelector<HTMLButtonElement>(
      '[data-context-value="notes"]',
    )!;
    expect(notes.disabled).toBe(false);
    expect(
      notes
        .querySelector('.new-chat-modal__no-cwd-badge')
        ?.getAttribute('title'),
    ).toBe('Runs in your home folder (~)');
    fireEvent.click(notes);
    expect(deviceSettingsStore.get('chatDockProjectSlug')).toBe('notes');
    await waitFor(() =>
      expect(
        projectChip(screen.getByTestId('home')).getAttribute('aria-label'),
      ).toBe('Project: Notes'),
    );
    expect(projectChip(screen.getByTestId('home')).getAttribute('title')).toBe(
      'Runs in your home folder (~)',
    );
    first.cleanupListener();
    cleanup();
    // Remounted: both read the remembered binding the same way.
    const second = renderBoth();
    for (const root of [screen.getByTestId('home'), second.dock()]) {
      expect(projectChip(root).getAttribute('aria-label')).toBe(
        'Project: Notes',
      );
      expect(projectChip(root).getAttribute('title')).toBe(
        'Runs in your home folder (~)',
      );
    }
    second.cleanupListener();
  }, 30_000);

  // Round-3 FI-1: the folderless hint follows the chosen Agent on BOTH
  // surfaces. An ACP engine with no folder of its own runs a folderless
  // project in a private Station-managed workspace, never home.
  test('with an ACP engine and no folder anywhere, both surfaces say a folderless project runs in a private folder', async () => {
    state.agents = [
      {
        slug: 'gemini',
        name: 'Gemini',
        available: true,
        engineConnectionType: 'acp',
        execution: { agentConnectionId: 'gemini-acp' },
      } as unknown as AgentData,
    ];
    // A ready ACP connection with no Working Directory of its own.
    state.agentConnections = [
      {
        id: 'gemini-acp',
        name: 'Gemini',
        type: 'acp',
        kind: 'agent',
        config: {},
        enabled: true,
        status: 'ready',
        capabilities: ['agent-runtime'],
      },
    ];
    state.projects = [
      STATION,
      { id: 'p2', slug: 'notes', name: 'Notes', workingDirectory: '' },
    ];
    const ui = renderBoth();
    const managed = 'Runs in a private folder Station makes for this chat';
    // Chosen on Home; the choice is shared, so the dock reads it too.
    fireEvent.click(agentChip(screen.getByTestId('home')));
    const agents = await screen.findByRole(
      'dialog',
      { name: 'Choose agent' },
      { timeout: 15_000 },
    );
    fireEvent.click(
      agents.querySelector<HTMLButtonElement>(
        'button[data-agent-slug="gemini"]',
      )!,
    );
    for (const root of [screen.getByTestId('home'), ui.dock()]) {
      await waitFor(() =>
        expect(agentChip(root).getAttribute('aria-label')).toMatch(
          /^Agent: Gemini/,
        ),
      );
      fireEvent.click(projectChip(root));
      const menu = await screen.findByRole(
        'dialog',
        { name: 'Choose project' },
        { timeout: 15_000 },
      );
      const badge = menu
        .querySelector('[data-context-value="notes"]')
        ?.querySelector('.new-chat-modal__no-cwd-badge');
      expect(badge?.textContent).toBe('No folder');
      expect(badge?.getAttribute('title')).toBe(managed);
      fireEvent.keyDown(menu, { key: 'Escape' });
      await waitFor(() =>
        expect(
          screen.queryByRole('dialog', { name: 'Choose project' }),
        ).toBeNull(),
      );
    }
    ui.cleanupListener();
  }, 30_000);

  // Review FI-B: an errored project list is not a loaded one. Home must not
  // resolve the dock's bound project to No project and start there.
  test('an errored project list holds Home rather than starting in No project', async () => {
    deviceSettingsStore.set('chatDockProjectSlug', 'station');
    state.projectsError = true;
    const taken: CustomEvent[] = [];
    window.addEventListener('station:open-new-chat', (event) => {
      event.preventDefault();
      taken.push(event as CustomEvent);
    });
    render(
      <AuthorityPersistenceContext.Provider
        value={{ status: 'verified', namespace: 'ns-1', observation: null }}
      >
        <HomeStartComposer />
      </AuthorityPersistenceContext.Provider>,
    );
    const form = screen.getByRole('form', { name: 'Start work' });
    fireEvent.change(
      within(form).getByRole('textbox', { name: 'What would you like done?' }),
      { target: { value: 'Go' } },
    );
    expect(
      within(form).queryByRole('button', { name: 'Project: No project' }),
    ).toBeNull();
    const startButton = within(form).getByRole('button', {
      name: 'Start',
    }) as HTMLButtonElement;
    expect(startButton.disabled).toBe(true);
    fireEvent.click(startButton);
    expect(
      taken.filter((event) => event.detail.selection?.context === '__global__'),
    ).toEqual([]);
  });

  // Review HIGH-1/HIGH-2: Home's draft is never lost.
  // Review L5: a folderless project is what both surfaces actually send.
  test('a folderless project is the sent target on both surfaces', async () => {
    state.projects = [
      STATION,
      { id: 'p2', slug: 'notes', name: 'Notes', workingDirectory: '' },
    ];
    deviceSettingsStore.set('chatDockProjectSlug', 'notes');
    const ui = renderBoth();
    const home = screen.getByTestId('home');
    await waitFor(() =>
      expect(projectChip(home).getAttribute('aria-label')).toBe(
        'Project: Notes',
      ),
    );
    fireEvent.change(
      within(formOf(home)).getByRole('textbox', {
        name: 'What would you like done?',
      }),
      { target: { value: 'Ship it' } },
    );
    await waitFor(() =>
      expect(
        (
          within(formOf(home)).getByRole('button', {
            name: 'Start',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(
      within(formOf(home)).getByRole('button', { name: 'Start' }),
    );
    expect(ui.starts.at(-1)!.detail.selection.context).toBe('notes');
    const dock = ui.dock();
    fireEvent.change(
      within(formOf(dock)).getByRole('textbox', {
        name: 'What would you like done?',
      }),
      { target: { value: 'Ship it' } },
    );
    fireEvent.click(
      within(formOf(dock)).getByRole('button', { name: 'Start' }),
    );
    await waitFor(() => expect(ui.dockSelect).toHaveBeenCalledTimes(1));
    expect(ui.dockSelect.mock.calls[0][1]).toBe('notes');
    ui.cleanupListener();
  }, 30_000);

  describe("Home's draft survives every way a start or hand-off can end", () => {
    function renderHome() {
      return render(
        <AuthorityPersistenceContext.Provider
          value={{ status: 'verified', namespace: 'ns-1', observation: null }}
        >
          <HomeStartComposer />
        </AuthorityPersistenceContext.Provider>,
      );
    }
    const field = () =>
      screen.getByRole('textbox', {
        name: 'What would you like done?',
      }) as HTMLTextAreaElement;
    const startButton = () =>
      screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement;
    async function handOffSkills() {
      fireEvent.click(
        screen.getByRole('button', { name: 'More start options' }),
      );
      fireEvent.click(
        await screen.findByRole('menuitem', { name: 'Use a visual skill' }),
      );
    }

    test('with no chat dock open, Start keeps the message and says so', async () => {
      renderHome();
      fireEvent.change(field(), { target: { value: 'Keep this' } });
      await waitFor(() => expect(startButton().disabled).toBe(false));
      fireEvent.click(startButton());
      expect(field().value).toBe('Keep this');
      expect(screen.getByRole('alert').textContent).toMatch(
        /No chat dock is open/,
      );
      // Not left "Starting…": nothing took the start.
      expect(startButton().getAttribute('aria-busy')).not.toBe('true');
      expect(startButton().textContent).toBe('Start');
    });

    test('with no chat dock open, a hand-off keeps the message and says so', async () => {
      renderHome();
      fireEvent.change(field(), { target: { value: 'Keep this' } });
      await handOffSkills();
      expect(field().value).toBe('Keep this');
      expect(screen.getByRole('alert').textContent).toMatch(
        /No chat dock is open/,
      );
    });

    test('a hand-off dismissed in the dock brings the message back', async () => {
      const taken: CustomEvent[] = [];
      const dock = (event: Event) => {
        event.preventDefault();
        taken.push(event as CustomEvent);
      };
      window.addEventListener('station:open-new-chat', dock);
      renderHome();
      fireEvent.change(field(), { target: { value: 'Keep this' } });
      await handOffSkills();
      expect(field().value).toBe('');
      expect(screen.getByRole('status').textContent).toMatch(
        /moved to the chat dock/,
      );
      act(() => taken.at(-1)!.detail.onClosed('dismissed'));
      expect(field().value).toBe('Keep this');
      window.removeEventListener('station:open-new-chat', dock);
    });

    test('a hand-off dismissed after Home unmounted (setup left the page) comes back on the next Home', async () => {
      const taken: CustomEvent[] = [];
      const dock = (event: Event) => {
        event.preventDefault();
        taken.push(event as CustomEvent);
      };
      window.addEventListener('station:open-new-chat', dock);
      const first = renderHome();
      fireEvent.change(field(), { target: { value: 'Survive the trip' } });
      await handOffSkills();
      first.unmount();
      act(() => taken.at(-1)!.detail.onClosed('dismissed'));
      renderHome();
      expect(field().value).toBe('Survive the trip');
      window.removeEventListener('station:open-new-chat', dock);
    });

    // Second review F1: text typed after a hand-off is never overwritten by
    // the draft that comes back; that one waits behind an action.
    test('a returning draft never overwrites what was typed meanwhile', async () => {
      const taken: CustomEvent[] = [];
      window.addEventListener('station:open-new-chat', (event) => {
        event.preventDefault();
        taken.push(event as CustomEvent);
      });
      renderHome();
      fireEvent.change(field(), { target: { value: 'Old draft' } });
      await handOffSkills();
      fireEvent.change(field(), { target: { value: 'Brand new work' } });
      act(() => taken.at(-1)!.detail.onClosed('dismissed', 'Old draft'));
      expect(field().value).toBe('Brand new work');
      // The earlier draft is offered, and restoring it swaps the two, so
      // neither text is lost.
      fireEvent.click(
        screen.getByRole('button', { name: 'Restore your earlier draft' }),
      );
      expect(field().value).toBe('Old draft');
      expect(
        screen.getByRole('group', { name: 'Earlier draft' }).textContent,
      ).toContain('Brand new work');
      fireEvent.click(screen.getByRole('button', { name: 'Discard it' }));
      expect(screen.queryByRole('group', { name: 'Earlier draft' })).toBeNull();
      expect(field().value).toBe('Old draft');
    });

    // Second review F2: a second hand-off while the first dock draft is
    // open dismisses the first (synchronously, inside the dispatch). The
    // first comes back; the second leaves the field; neither is lost.
    test('a second hand-off while the first is open loses neither draft', async () => {
      const taken: CustomEvent[] = [];
      window.addEventListener('station:open-new-chat', (event) => {
        event.preventDefault();
        // As the dock does: a new request dismisses the open one first.
        taken
          .at(-1)
          ?.detail.onClosed?.('dismissed', taken.at(-1)?.detail.initialPrompt);
        taken.push(event as CustomEvent);
      });
      renderHome();
      fireEvent.change(field(), { target: { value: 'Draft A' } });
      await handOffSkills();
      expect(field().value).toBe('');
      fireEvent.change(field(), { target: { value: 'Draft B' } });
      await handOffSkills();
      // B went to the dock; A came back to the now-empty field.
      expect(taken.at(-1)!.detail.initialPrompt).toBe('Draft B');
      await waitFor(() => expect(field().value).toBe('Draft A'));
    });

    test('Start while a hand-off draft is open loses neither text', async () => {
      const taken: CustomEvent[] = [];
      window.addEventListener('station:open-new-chat', (event) => {
        event.preventDefault();
        taken
          .at(-1)
          ?.detail.onClosed?.('dismissed', taken.at(-1)?.detail.initialPrompt);
        taken.push(event as CustomEvent);
      });
      renderHome();
      fireEvent.change(field(), { target: { value: 'Draft A' } });
      await handOffSkills();
      fireEvent.change(field(), { target: { value: 'Start this' } });
      await waitFor(() => expect(startButton().disabled).toBe(false));
      fireEvent.click(startButton());
      // A came back while "Start this" was in the field: it waits.
      expect(field().value).toBe('Start this');
      expect(
        screen.getByRole('group', { name: 'Earlier draft' }).textContent,
      ).toContain('Draft A');
      act(() => taken.at(-1)!.detail.onClosed('started'));
      // The started text leaves the field and A takes it back.
      expect(field().value).toBe('Draft A');
      expect(screen.queryByRole('group', { name: 'Earlier draft' })).toBeNull();
    });

    // A dock that, like useChatDockOverlays, dismisses the open request
    // (with its draft) inside the dispatch, before taking the new one.
    function dismissingDock() {
      const taken: CustomEvent[] = [];
      const closed = new Set<CustomEvent>();
      window.addEventListener('station:open-new-chat', (event) => {
        event.preventDefault();
        const prev = taken.at(-1);
        if (prev && !closed.has(prev)) {
          closed.add(prev);
          prev.detail.onClosed?.('dismissed', prev.detail.initialPrompt);
        }
        taken.push(event as CustomEvent);
      });
      return { taken, closed };
    }
    const earlier = () =>
      screen.queryByRole('group', { name: 'Earlier draft' });

    // Review round 3 H1: a hand-off from the EMPTY field dismisses A in the
    // dock; A comes back during the dispatch and the emptying must not
    // overwrite it.
    test('a hand-off from an empty field brings the open draft back, not blank', async () => {
      dismissingDock();
      renderHome();
      fireEvent.change(field(), { target: { value: 'Draft A' } });
      await handOffSkills();
      expect(field().value).toBe('');
      await handOffSkills();
      expect(field().value).toBe('Draft A');
    });

    // Review round 3 M1: a dismissed Start whose field moved on keeps the
    // dock's draft behind Restore.
    test('a dismissed Start while new text was typed holds the dock draft', async () => {
      const { taken, closed } = dismissingDock();
      renderHome();
      fireEvent.change(field(), { target: { value: 'Start A' } });
      await waitFor(() => expect(startButton().disabled).toBe(false));
      fireEvent.click(startButton());
      fireEvent.change(field(), { target: { value: 'Typed B' } });
      const last = taken.at(-1)!;
      closed.add(last);
      act(() => last.detail.onClosed('dismissed', 'Start A, edited in dock'));
      expect(field().value).toBe('Typed B');
      expect(earlier()?.textContent).toContain('Start A, edited in dock');
    });

    test('a Start dismissed after Home unmounted comes back on the next Home', async () => {
      const { taken, closed } = dismissingDock();
      const first = renderHome();
      fireEvent.change(field(), { target: { value: 'Start A' } });
      await waitFor(() => expect(startButton().disabled).toBe(false));
      fireEvent.click(startButton());
      first.unmount();
      const last = taken.at(-1)!;
      closed.add(last);
      act(() => last.detail.onClosed('dismissed', 'Start A, edited in dock'));
      renderHome();
      expect(field().value).toBe('Start A, edited in dock');
    });

    test('a dismissed Start with the field untouched takes the dock edits', async () => {
      const { taken, closed } = dismissingDock();
      renderHome();
      fireEvent.change(field(), { target: { value: 'Start A' } });
      await waitFor(() => expect(startButton().disabled).toBe(false));
      fireEvent.click(startButton());
      const last = taken.at(-1)!;
      closed.add(last);
      act(() => last.detail.onClosed('dismissed', 'Start A, edited in dock'));
      expect(field().value).toBe('Start A, edited in dock');
      expect(earlier()).toBeNull();
    });

    test('Restore swaps back and forth without losing either text', async () => {
      const { taken, closed } = dismissingDock();
      renderHome();
      fireEvent.change(field(), { target: { value: 'A' } });
      await handOffSkills();
      fireEvent.change(field(), { target: { value: 'B' } });
      const last = taken.at(-1)!;
      closed.add(last);
      act(() => last.detail.onClosed('dismissed', 'A2'));
      const restore = () =>
        fireEvent.click(
          screen.getByRole('button', { name: 'Restore your earlier draft' }),
        );
      restore();
      expect(field().value).toBe('A2');
      expect(earlier()?.textContent).toContain('B');
      restore();
      expect(field().value).toBe('B');
      expect(earlier()?.textContent).toContain('A2');
    });

    test('A then B handed off: A returns to the field, B waits when dismissed', async () => {
      const { taken } = dismissingDock();
      renderHome();
      fireEvent.change(field(), { target: { value: 'A' } });
      await handOffSkills();
      fireEvent.change(field(), { target: { value: 'B' } });
      await handOffSkills();
      expect(field().value).toBe('A');
      act(() => taken.at(-1)!.detail.onClosed('dismissed', 'B'));
      expect(field().value).toBe('A');
      expect(earlier()?.textContent).toContain('B');
    });

    // Review round 3 L1: a reload keeps held drafts (this tab's storage).
    test('a held draft survives a reload and comes back on the next Home', async () => {
      const { taken } = dismissingDock();
      const first = renderHome();
      fireEvent.change(field(), { target: { value: 'Before reload' } });
      await handOffSkills();
      first.unmount();
      act(() => taken.at(-1)!.detail.onClosed('dismissed', 'Before reload'));
      expect(window.sessionStorage.getItem('station-home-held-drafts-v1')).toBe(
        JSON.stringify(['Before reload']),
      );
      reloadHeldHomeDraftsForTests();
      renderHome();
      expect(field().value).toBe('Before reload');
      expect(
        window.sessionStorage.getItem('station-home-held-drafts-v1'),
      ).toBeNull();
    });

    // Round-3 L-b: a failed write must not leave the older list behind, or
    // a reload brings back a draft already restored or discarded.
    test('a failed storage write leaves no stale list to restore on reload', () => {
      window.sessionStorage.setItem(
        'station-home-held-drafts-v1',
        JSON.stringify(['Old', 'Older']),
      );
      reloadHeldHomeDraftsForTests();
      const setItem = vi
        .spyOn(Storage.prototype, 'setItem')
        .mockImplementation(() => {
          throw new Error('QuotaExceededError');
        });
      try {
        renderHome();
        // 'Old' went into the field; writing ['Older'] failed.
        expect(field().value).toBe('Old');
        expect(earlier()?.textContent).toContain('Older');
        expect(setItem).toHaveBeenCalled();
        expect(
          window.sessionStorage.getItem('station-home-held-drafts-v1'),
        ).toBeNull();
      } finally {
        setItem.mockRestore();
      }
    });

    test('unreadable stored drafts are ignored, not restored', () => {
      window.sessionStorage.setItem(
        'station-home-held-drafts-v1',
        JSON.stringify([1, { text: 'x' }]),
      );
      reloadHeldHomeDraftsForTests();
      renderHome();
      expect(field().value).toBe('');
      expect(earlier()).toBeNull();
    });

    // Review round 3 L2: focus never falls to the page when the group goes,
    // and a draft arriving while someone types is announced.
    test.each(['Restore your earlier draft', 'Discard it'])(
      '%s on the last earlier draft puts focus in the text box',
      async (action) => {
        const { taken, closed } = dismissingDock();
        renderHome();
        fireEvent.change(field(), { target: { value: 'Old' } });
        await handOffSkills();
        fireEvent.change(field(), { target: { value: 'New' } });
        const last = taken.at(-1)!;
        closed.add(last);
        act(() => last.detail.onClosed('dismissed', 'Old'));
        // Cleared since: Restore has nothing to swap back, so the group goes.
        fireEvent.change(field(), { target: { value: '' } });
        const button = screen.getByRole('button', { name: action });
        button.focus();
        fireEvent.click(button);
        expect(earlier()).toBeNull();
        expect(document.activeElement).toBe(field());
      },
    );

    test('a draft that comes back while typing is announced politely', async () => {
      const { taken, closed } = dismissingDock();
      const { container } = renderHome();
      fireEvent.change(field(), { target: { value: 'Old' } });
      await handOffSkills();
      fireEvent.change(field(), { target: { value: 'Typing now' } });
      const live = container.querySelector('[aria-live="polite"]');
      expect(live?.textContent).toBe('');
      const last = taken.at(-1)!;
      closed.add(last);
      act(() => last.detail.onClosed('dismissed', 'Old'));
      expect(live?.textContent).toMatch(/earlier draft came back/);
      fireEvent.click(screen.getByRole('button', { name: 'Discard it' }));
      expect(live?.textContent).toBe('');
    });

    // Only the text that was sent leaves the field: words typed while the
    // start was pending stay.
    test('text typed while a start is pending survives the start', async () => {
      const taken: CustomEvent[] = [];
      window.addEventListener('station:open-new-chat', (event) => {
        event.preventDefault();
        taken.push(event as CustomEvent);
      });
      renderHome();
      fireEvent.change(field(), { target: { value: 'First' } });
      await waitFor(() => expect(startButton().disabled).toBe(false));
      fireEvent.click(startButton());
      fireEvent.change(field(), { target: { value: 'First, and then more' } });
      act(() => taken.at(-1)!.detail.onClosed('started'));
      expect(field().value).toBe('First, and then more');
    });

    // Second review F3: what comes back is the dock's edited text, not the
    // text Home sent.
    test('a dismissed hand-off brings back the text as edited in the dock', async () => {
      const taken: CustomEvent[] = [];
      window.addEventListener('station:open-new-chat', (event) => {
        event.preventDefault();
        taken.push(event as CustomEvent);
      });
      renderHome();
      fireEvent.change(field(), { target: { value: 'Sent from Home' } });
      await handOffSkills();
      act(() =>
        taken.at(-1)!.detail.onClosed('dismissed', 'Sent from Home, edited'),
      );
      expect(field().value).toBe('Sent from Home, edited');
    });

    test('a started chat clears the field; a dismissed start keeps it', async () => {
      const taken: CustomEvent[] = [];
      const dock = (event: Event) => {
        event.preventDefault();
        taken.push(event as CustomEvent);
      };
      window.addEventListener('station:open-new-chat', dock);
      renderHome();
      fireEvent.change(field(), { target: { value: 'First' } });
      await waitFor(() => expect(startButton().disabled).toBe(false));
      fireEvent.click(startButton());
      act(() => taken.at(-1)!.detail.onClosed('dismissed'));
      expect(field().value).toBe('First');
      fireEvent.click(startButton());
      act(() => taken.at(-1)!.detail.onClosed('started'));
      expect(field().value).toBe('');
      window.removeEventListener('station:open-new-chat', dock);
    });
  });
});

test("the dock's draft reports its text as it changes, so a dismissal can return it", () => {
  const onDraftChange = vi.fn();
  render(
    <AuthorityPersistenceContext.Provider
      value={{ status: 'verified', namespace: 'ns-1', observation: null }}
    >
      <NewChatModal
        projectIconBySlug={new Map()}
        startSurface
        agents={state.agents as AgentData[]}
        projects={state.projects as ProjectMetadata[]}
        activeProjectSlug={deviceSettingsStore.get('chatDockProjectSlug')}
        projectBindable
        initialPrompt="From Home"
        onDraftChange={onDraftChange}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    </AuthorityPersistenceContext.Provider>,
  );
  const dock = screen.getByRole('dialog', { name: 'New chat' });
  fireEvent.change(
    within(dock).getByRole('textbox', { name: 'What would you like done?' }),
    { target: { value: 'From Home, edited in the dock' } },
  );
  expect(onDraftChange).toHaveBeenLastCalledWith(
    'From Home, edited in the dock',
  );
});

// #3366 follow-up: the composer draws a project with `ProjectIcon` — the
// chosen icon, else the sidebar's colour — on the chip and in the menu, and
// never a stored value the contracts rule refuses.
describe('project icons in the start composer', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';
  const iconProjects = [
    {
      id: 'p1',
      slug: 'pic',
      name: 'Pic',
      icon: PNG,
      workingDirectory: '/w/pic',
    },
    {
      id: 'p2',
      slug: 'emo',
      name: 'Emo',
      icon: '🧭',
      workingDirectory: '/w/emo',
    },
    { id: 'p3', slug: 'bare', name: 'Bare', workingDirectory: '/w/bare' },
    // A legacy stored link: neither surface may load it.
    {
      id: 'p4',
      slug: 'legacy',
      name: 'Legacy',
      icon: 'https://example.com/logo.png',
      workingDirectory: '/w/legacy',
    },
  ] as ProjectMetadata[];

  function markOf(root: Element) {
    return {
      img: root.querySelector('img')?.getAttribute('src') ?? null,
      glyph: root.querySelector('.brand-icon__glyph')?.textContent ?? null,
      dot: root.querySelector('[data-project-icon="dot"]') !== null,
    };
  }

  test.each([
    ['pic', { img: PNG, glyph: null, dot: false }],
    ['emo', { img: null, glyph: '🧭', dot: false }],
    ['bare', { img: null, glyph: null, dot: true }],
    ['legacy', { img: null, glyph: null, dot: true }],
  ])('the chip on both surfaces draws %s', async (slug, expected) => {
    state.projects = iconProjects;
    deviceSettingsStore.set('chatDockProjectSlug', slug);
    const ui = renderBoth();
    for (const root of [screen.getByTestId('home'), ui.dock()]) {
      await waitFor(() => expect(markOf(projectChip(root))).toEqual(expected));
    }
    ui.cleanupListener();
  });

  test('the menu rows draw each project the way the chip does', async () => {
    state.projects = iconProjects;
    const ui = renderBoth();
    for (const root of [screen.getByTestId('home'), ui.dock()]) {
      fireEvent.click(projectChip(root));
      const menu = await screen.findByRole(
        'dialog',
        { name: 'Choose project' },
        { timeout: 15_000 },
      );
      const row = (slug: string) =>
        menu.querySelector(`[data-context-value="${slug}"]`)!;
      expect(markOf(row('pic'))).toEqual({ img: PNG, glyph: null, dot: false });
      expect(markOf(row('emo'))).toEqual({
        img: null,
        glyph: '🧭',
        dot: false,
      });
      expect(markOf(row('bare'))).toEqual({
        img: null,
        glyph: null,
        dot: true,
      });
      expect(markOf(row('legacy'))).toEqual({
        img: null,
        glyph: null,
        dot: true,
      });
      expect(menu.innerHTML).not.toContain('example.com');
      fireEvent.keyDown(menu, { key: 'Escape' });
      await waitFor(() =>
        expect(
          screen.queryByRole('dialog', { name: 'Choose project' }),
        ).toBeNull(),
      );
    }
    ui.cleanupListener();
  }, 30_000);
});

// #3370: the hint states where the session start will really run, from the
// server's `runsAt`, on both surfaces.
describe('the run-location hint follows the server resolution (#3370)', () => {
  test('a folderless project bound to an executionRoot says it runs there, not home', async () => {
    state.projects = [
      STATION,
      {
        id: 'p2',
        slug: 'mono',
        name: 'Mono',
        runsAt: { kind: 'execution-root', path: '/work/mono/packages/app' },
      },
    ] as ProjectMetadata[];
    deviceSettingsStore.set('chatDockProjectSlug', 'mono');
    const ui = renderBoth();
    for (const root of [screen.getByTestId('home'), ui.dock()]) {
      await waitFor(() =>
        expect(projectChip(root).getAttribute('title')).toBe(
          'Runs in /work/mono/packages/app',
        ),
      );
      fireEvent.click(projectChip(root));
      const menu = await screen.findByRole(
        'dialog',
        { name: 'Choose project' },
        { timeout: 15_000 },
      );
      const mono = menu.querySelector('[data-context-value="mono"]')!;
      expect(mono.querySelector('.new-chat-modal__no-cwd-badge')).toBeNull();
      expect(
        mono
          .querySelector('.new-chat-modal__cwd-breadcrumb')
          ?.getAttribute('aria-label'),
      ).toBe('Working directory: /work/mono/packages/app');
      fireEvent.keyDown(menu, { key: 'Escape' });
      await waitFor(() =>
        expect(
          screen.queryByRole('dialog', { name: 'Choose project' }),
        ).toBeNull(),
      );
    }
    ui.cleanupListener();
  }, 30_000);

  test('a project whose folder was not checked is not marked as refused', async () => {
    const reason =
      'Station is still waiting on other project folders, so it did not check this one yet. Try again shortly.';
    state.projects = [
      {
        id: 'p2',
        slug: 'slow',
        name: 'Slow',
        workingDirectory: '/work/slow',
        runsAt: { kind: 'unchecked', reason },
      },
    ] as ProjectMetadata[];
    deviceSettingsStore.set('chatDockProjectSlug', 'slow');
    const ui = renderBoth();
    const home = screen.getByTestId('home');
    await waitFor(() =>
      expect(projectChip(home).getAttribute('title')).toBe(
        'Runs in /work/slow (not checked yet)',
      ),
    );
    fireEvent.click(projectChip(home));
    const menu = await screen.findByRole(
      'dialog',
      { name: 'Choose project' },
      { timeout: 15_000 },
    );
    const slow = menu.querySelector('[data-context-value="slow"]')!;
    const badges = [
      ...slow.querySelectorAll('.new-chat-modal__no-cwd-badge'),
    ].map((badge) => badge.textContent);
    expect(badges).toEqual(['Not checked']);
    expect(slow.textContent).not.toContain("Can't start");
    expect(
      slow
        .querySelector('.new-chat-modal__cwd-breadcrumb')
        ?.getAttribute('aria-label'),
    ).toBe('Working directory: /work/slow');
    ui.cleanupListener();
  }, 30_000);

  test('a project the server says cannot start names no folder', async () => {
    const reason =
      "Project 'gone' cannot start here (missing): its folder no longer exists.";
    state.projects = [
      {
        id: 'p2',
        slug: 'gone',
        name: 'Gone',
        workingDirectory: '/work/gone',
        runsAt: { kind: 'unavailable', reason },
      },
    ] as ProjectMetadata[];
    deviceSettingsStore.set('chatDockProjectSlug', 'gone');
    const ui = renderBoth();
    const home = screen.getByTestId('home');
    await waitFor(() =>
      expect(projectChip(home).getAttribute('title')).toBe(reason),
    );
    fireEvent.click(projectChip(home));
    const menu = await screen.findByRole(
      'dialog',
      { name: 'Choose project' },
      { timeout: 15_000 },
    );
    const gone = menu.querySelector('[data-context-value="gone"]')!;
    expect(gone.querySelector('.new-chat-modal__cwd-breadcrumb')).toBeNull();
    expect(
      gone
        .querySelector('.new-chat-modal__no-cwd-badge')
        ?.getAttribute('title'),
    ).toBe(reason);
    expect(menu.querySelector('.start-menu__hint')?.textContent).toBe(reason);
    ui.cleanupListener();
  }, 30_000);
});
