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
    onClose,
  }: {
    onSelect: (model: { id: string; name: string }) => void;
    onClose: () => void;
  }) => (
    <button
      type="button"
      onClick={() => {
        onSelect({ id: 'sonnet', name: 'Sonnet' });
        onClose();
      }}
    >
      Choose Sonnet
    </button>
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
  localStorage.clear();
  deviceSettingsStore.set('chatDockProjectSlug', null);
  state.agents = [CLAUDE, CODEX];
  state.projects = [STATION];
  state.projectsLoading = false;
});
afterEach(() => cleanup());

function renderBoth() {
  const dockSelect = vi.fn();
  const starts: CustomEvent[] = [];
  const listener = (event: Event) => starts.push(event as CustomEvent);
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
    const listener = (event: Event) => starts.push(event as CustomEvent);
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
});
