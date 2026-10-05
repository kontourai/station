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
  useProjectsQuery: () => ({
    data: state.projectsLoading ? undefined : state.projects,
    isLoading: state.projectsLoading,
    isFetching: false,
    isSuccess: !state.projectsLoading,
    error: null,
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
    data: { agentConnections: [], modelConnections: [] },
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

const { HomeStartComposer } = await import(
  '../components/home/HomeStartComposer'
);
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
  deviceSettingsStore.set('chatDockProjectSlug', null);
  state.agents = [CLAUDE, CODEX];
  state.projects = [STATION];
  state.projectsLoading = false;
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

  // Review MED-1: a project with no folder is never a start context, on
  // either surface, so neither offers it; both say why.
  test('a project with no folder cannot be chosen on either surface', async () => {
    state.projects = [
      STATION,
      { id: 'p2', slug: 'notes', name: 'Notes', workingDirectory: '' },
    ];
    const ui = renderBoth();
    for (const root of [screen.getByTestId('home'), ui.dock()]) {
      fireEvent.click(projectChip(root));
      const menu = await screen.findByRole(
        'dialog',
        { name: 'Choose project' },
        { timeout: 15_000 },
      );
      const notes = menu.querySelector<HTMLButtonElement>(
        '[data-context-value="notes"]',
      )!;
      expect(notes.disabled).toBe(true);
      expect(notes.textContent).toMatch(/No folder set/);
      expect(
        menu.querySelector<HTMLButtonElement>('[data-context-value="station"]')!
          .disabled,
      ).toBe(false);
      fireEvent.keyDown(within(menu).getByPlaceholderText('Filter...'), {
        key: 'Escape',
      });
      await waitFor(() =>
        expect(
          screen.queryByRole('dialog', { name: 'Choose project' }),
        ).toBeNull(),
      );
    }
    // A binding to it made elsewhere (the sidebar) reads as No project on
    // both, never as Notes on one.
    act(() => deviceSettingsStore.set('chatDockProjectSlug', 'notes'));
    await waitFor(() =>
      expect(
        projectChip(screen.getByTestId('home')).getAttribute('aria-label'),
      ).toBe('Project: No project'),
    );
    ui.cleanupListener();
  }, 30_000);

  // Review HIGH-1/HIGH-2: Home's draft is never lost.
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
