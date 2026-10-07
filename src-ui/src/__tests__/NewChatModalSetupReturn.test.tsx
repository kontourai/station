// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import type {
  InstalledSkillExperienceV1,
  SkillExperienceDefinitionV1,
  SkillExperienceInventoryV1,
} from '@kontourai/station-contracts/skill-experience';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { useState } from 'react';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { NewChatModal } from '../components/modals/NewChatModal';
import { buildNewChatModalViewModel } from '../components/modals/new-chat-modal-utils';
import type { AgentData } from '../contexts/AgentsContext';
import { bannerStore, useBanners } from '../contexts/banner-store';
import { navigationStore } from '../contexts/navigation-store';
import type { ProjectMetadata } from '../contexts/ProjectsContext';
import { resetStartChoicesForTests } from '../hooks/useStartSelection';

const experienceRead = vi.hoisted(() => ({
  inventory: { experiences: [], diagnostics: [] } as SkillExperienceInventoryV1,
  refetch: vi.fn(),
}));
vi.mock('../contexts/ApiBaseContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useHostRequestAuthorityScope: () => undefined,
}));

vi.mock('../contexts/AuthorityPersistenceContext', () => ({
  useAuthorityPersistence: () => ({
    namespace: 'authority-1',
    status: 'verified',
  }),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useSkillExperienceInventoryQuery: () => ({
    data: experienceRead.inventory,
    refetch: experienceRead.refetch,
  }),
  useMaterializeEngineAgentMutation: () => ({ mutateAsync: vi.fn() }),
}));
const screenSize = vi.hoisted(() => ({ mobile: false }));
vi.mock('../hooks/useIsMobile', () => ({
  useIsMobile: () => screenSize.mobile,
}));
vi.mock('../hooks/useDevicePresentation', () => ({
  useDevicePresentation: () => undefined,
}));
vi.mock('../components/session/SessionModelPicker', () => ({
  SessionModelPicker: ({
    onSelect,
    onClose,
  }: {
    onSelect: (model: unknown) => void;
    onClose: () => void;
  }) => (
    <button
      type="button"
      onClick={() => {
        onSelect({ id: 'chosen', name: 'Chosen', providerOptions: {} });
        onClose();
      }}
    >
      Choose Chosen model
    </button>
  ),
}));
const refetch = vi.fn();
let readError: unknown;
let fetching = false;
let models = [
  { id: 'default', name: 'Default' },
  { id: 'chosen', name: 'Chosen' },
];
vi.mock('../hooks/useNewChatSelectionModel', () => ({
  useNewChatSelectionModel: (
    input: Parameters<typeof buildNewChatModalViewModel>[0],
  ) => {
    const [modelChoices, setModelChoices] = useState<
      Record<
        string,
        { modelId?: string; providerOptions: Record<string, unknown> }
      >
    >({});
    const [modelPickerAgent, setModelPickerAgent] = useState<AgentData | null>(
      null,
    );
    return {
      viewModel: buildNewChatModalViewModel({
        ...input,
        agentConnections: [],
        layoutAvailableAgents: [],
        recentSlugs: [],
      }),
      defaultSelection: {
        agent: input.agents.find((agent) => agent.available !== false),
      },
      runtimeLoading: false,
      modelsLoading: false,
      runtimeFetching: fetching,
      modelsFetching: false,
      runtimeError: readError,
      modelConnections: [],
      refetchAgentConnections: refetch,
      refetchModelConnections: refetch,
      modelChoices,
      setModelChoices,
      modelPickerAgent,
      setModelPickerAgent,
      modelsForAgent: () => models,
      modelChoiceKey: (agent: AgentData) =>
        `${input.selectedContext}:${agent.slug}`,
      defaultEffectiveModelForAgent: () => ({
        id: 'default',
        label: 'Default',
        source: 'agent default',
      }),
    };
  },
}));

const PROJECTS = [
  { slug: 'alpha', name: 'Alpha', workingDirectory: '/work/alpha' },
  { slug: 'beta', name: 'Beta', workingDirectory: '/work/beta' },
] as ProjectMetadata[];
const NEEDS_SETUP = {
  slug: 'assistant',
  name: 'Assistant',
  available: false,
  unavailableReason: 'Connect a Model',
  unavailableFix: { kind: 'model-connection' },
} as AgentData;
const READY = {
  ...NEEDS_SETUP,
  available: true,
  unavailableReason: undefined,
  unavailableFix: undefined,
};
let authorityCurrent = true;
const authority = {
  apiBase: 'http://station.test/api',
  authorityKey: 'station-a:operator-1',
  isCurrent: () => authorityCurrent,
};
function BannerControls() {
  return (
    <>
      {useBanners()
        .filter((banner) => banner.phase === 'live')
        .flatMap(
          (banner) =>
            banner.actions?.map((action) => (
              <button type="button" key={action.label} onClick={action.onClick}>
                {action.label}
              </button>
            )) || [],
        )}
    </>
  );
}
function ModalHarness(props: Parameters<typeof NewChatModal>[0]) {
  const [open, setOpen] = useState(true);
  return (
    <>
      {open ? (
        <NewChatModal
          {...props}
          onClose={() => {
            setOpen(false);
            props.onClose();
          }}
        />
      ) : null}
      <BannerControls />
    </>
  );
}
function harness(props: Partial<Parameters<typeof NewChatModal>[0]> = {}) {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const defaults = {
    agents: [NEEDS_SETUP],
    projects: PROJECTS,
    activeProjectSlug: 'alpha',
    onSelect,
    onClose,
    requestAuthority: authority,
    projectIconBySlug: new Map<string, string>(),
  };
  const view = render(<ModalHarness {...defaults} {...props} />);
  return {
    ...view,
    onSelect,
    onClose,
    update: (next: Partial<Parameters<typeof NewChatModal>[0]>) =>
      view.rerender(<ModalHarness {...defaults} {...props} {...next} />),
  };
}
async function openSetup() {
  fireEvent.click(screen.getByRole('button', { name: 'Connect Assistant' }));
  await screen.findByRole('button', { name: 'Return to New Chat' });
  await waitFor(() =>
    expect(navigationStore.getSnapshot().pathname).toMatch(/^\/connections/),
  );
  expect(screen.queryByRole('dialog', { name: 'New Chat' })).toBeNull();
}
async function returnToChat() {
  fireEvent.click(screen.getByRole('button', { name: 'Return to New Chat' }));
  await screen.findByRole('dialog', { name: 'New Chat' });
}
beforeAll(() => {
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  Element.prototype.scrollIntoView = vi.fn();
});
beforeEach(() => {
  resetStartChoicesForTests();
  experienceRead.inventory = { experiences: [], diagnostics: [] };
  experienceRead.refetch.mockReset().mockResolvedValue(undefined);
  screenSize.mobile = false;
  authorityCurrent = true;
  readError = undefined;
  fetching = false;
  models = [
    { id: 'default', name: 'Default' },
    { id: 'chosen', name: 'Chosen' },
  ];
  refetch.mockReset().mockResolvedValue(undefined);
  act(() => navigationStore.navigate('/'));
});
afterEach(() => {
  cleanup();
  bannerStore.clear();
});

describe('New Chat repair and return', () => {
  test('retains source inputs, workspace and model across marketplace setup without installing or starting', async () => {
    const definition: SkillExperienceDefinitionV1 = JSON.parse(
      readFileSync(
        new NodeURL(
          '../../../examples/visual-skill-experience/io.kontourai.station/experiences/stress-test-idea.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const entry: InstalledSkillExperienceV1 = {
      definition,
      identity: {
        pluginId: 'example',
        pluginVersion: '1.0.0',
        experienceId: definition.id,
        incarnation: 'installed-1',
        materialization: 'materialization-1',
        contentDigest: 'digest-1',
        definitionDigest: 'definition-1',
      },
    };
    experienceRead.inventory = {
      executionContract: '1.0',
      experiences: [entry],
      diagnostics: [],
    };
    const view = harness({ agents: [READY] });
    fireEvent.click(
      screen.getByRole('button', { name: new RegExp(definition.title) }),
    );
    fireEvent.change(
      screen.getByRole('textbox', { name: /What would you like to build/ }),
      { target: { value: 'Keep my visual skill input' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Project: Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: /Beta/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Model:/ }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Choose Chosen model' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Browse marketplaces' }),
    );
    await screen.findByRole('button', { name: 'Return to New Chat' });
    await waitFor(() =>
      expect(navigationStore.getSnapshot().pathname).toBe('/registry'),
    );
    experienceRead.inventory = {
      executionContract: '1.0',
      experiences: [],
      diagnostics: [],
    };
    await returnToChat();
    expect(experienceRead.refetch).toHaveBeenCalledOnce();
    expect(
      screen.getByRole('textbox', { name: /What would you like to build/ }),
    ).toHaveProperty('value', 'Keep my visual skill input');
    expect(screen.getByRole('button', { name: 'Project: Beta' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Model: Chosen' })).toBeTruthy();
    expect(screen.getByText(/selected source changed/)).toBeTruthy();
    expect(view.onSelect).not.toHaveBeenCalled();
    expect(view.onClose).not.toHaveBeenCalled();
  });

  test('phone setup reveals its page and restores the original full chat on return', async () => {
    screenSize.mobile = true;
    act(() =>
      navigationStore.navigate('/', { dock: 'open', maximize: 'true' }),
    );
    harness();
    await openSetup();
    expect(navigationStore.getSnapshot().isDockOpen).toBe(false);
    expect(navigationStore.getSnapshot().isDockMaximized).toBe(false);
    await returnToChat();
    expect(navigationStore.getSnapshot().isDockOpen).toBe(true);
    expect(navigationStore.getSnapshot().isDockMaximized).toBe(true);
  });
  test('retains intentional Project and Model through repair without selecting or sending', async () => {
    const view = harness();
    fireEvent.click(screen.getByRole('button', { name: 'Project: Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: /Beta/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Model:/ }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Choose Chosen model' }),
    );
    await openSetup();
    expect(navigationStore.getSnapshot().pathname).toMatch(/^\/connections/);
    expect(view.onClose).not.toHaveBeenCalled();
    view.update({ agents: [READY] });
    await returnToChat();
    expect(navigationStore.getSnapshot().pathname).toBe('/');
    expect(screen.getByRole('button', { name: 'Project: Beta' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Model: Chosen' })).toBeTruthy();
    expect(view.onSelect).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByPlaceholderText('Search agents...'), {
      key: 'Enter',
    });
    expect(view.onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'assistant' }),
      'beta',
      'Beta',
      undefined,
      'chosen',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      undefined,
      undefined,
    );
  });
  // station#1613: the origin carries `?maximize=true` with no `dock=open` —
  // the one route into the closed-and-maximized pair that no param write
  // normalizes. If the detour opens the dock, `restoreLocation` clears it on
  // the way home, that write goes through `closedDockNeverMaximized`, and the
  // param is dropped with it. The origin and the restored URL must still
  // compare equal or the journey cancels and the user's retained draft goes
  // with it. `canonicalSearch` is what makes them equal.
  function stageMaximizedOrigin() {
    act(() => {
      window.history.replaceState({}, '', '/?maximize=true');
      navigationStore.navigate('/', {});
    });
    expect(navigationStore.getSnapshot().isDockOpen).toBe(false);
    expect(navigationStore.getSnapshot().isDockMaximized).toBe(true);
  }

  test('the real restore from a maximize-carrying origin lands somewhere the journey still recognises', async () => {
    stageMaximizedOrigin();
    const view = harness();
    await openSetup();

    // The detour opens the dock, so the restore's clear set names it and the
    // normalization fires on the way home — the case the rule exists for.
    act(() => navigationStore.setDockState(true));
    await returnToChat();

    await waitFor(() =>
      expect(navigationStore.getSnapshot().pathname).toBe('/'),
    );
    expect(new URLSearchParams(window.location.search).has('maximize')).toBe(
      false,
    );
    expect(
      navigationStore.isCurrentLocation({
        pathname: '/',
        search: '?maximize=true',
      }),
    ).toBe(true);
    expect(view.onClose).not.toHaveBeenCalled();
  });

  test('a passive route Back to a maximize-carrying origin resumes rather than cancelling', async () => {
    stageMaximizedOrigin();
    const view = harness();
    await openSetup();

    // No restore: the user walks back themselves, through a write that closes
    // the dock. The comparison is all that decides between resume and cancel.
    act(() => navigationStore.navigate('/', { dock: null }));
    await screen.findByRole('dialog', { name: 'New Chat' });
    expect(view.onClose).not.toHaveBeenCalled();
  });

  test('browser route Back resumes and unrelated navigation cancels', async () => {
    const view = harness();
    await openSetup();
    act(() => navigationStore.navigate('/'));
    await screen.findByRole('dialog', { name: 'New Chat' });
    await openSetup();
    act(() => navigationStore.navigate('/settings'));
    expect(view.onClose).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole('button', { name: 'Return to New Chat' }),
    ).toBeNull();
  });
  test('cancel and unmount clear the exact banner', async () => {
    const view = harness();
    await openSetup();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel return' }));
    expect(view.onClose).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole('button', { name: 'Return to New Chat' }),
    ).toBeNull();
    view.unmount();
    expect(bannerStore.getSnapshot()).toHaveLength(0);
  });
  test('authority revocation fences a late return action', async () => {
    const view = harness();
    await openSetup();
    authorityCurrent = false;
    fireEvent.click(screen.getByRole('button', { name: 'Return to New Chat' }));
    expect(view.onClose).toHaveBeenCalledTimes(1);
    expect(view.onSelect).not.toHaveBeenCalled();
    expect(navigationStore.getSnapshot().pathname).toMatch(/^\/connections/);
  });
  test('a changed Station authority cancels the pending return', async () => {
    const view = harness();
    await openSetup();
    view.update({
      requestAuthority: { ...authority, authorityKey: 'station-b:operator-2' },
    });
    await waitFor(() => expect(view.onClose).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByRole('button', { name: 'Return to New Chat' }),
    ).toBeNull();
  });
  test('deleted Project and Agent are disclosed without choosing substitutes', async () => {
    const view = harness();
    await openSetup();
    view.update({
      agents: [{ ...READY, slug: 'replacement' } as AgentData],
      projects: [PROJECTS[1]],
    });
    await returnToChat();
    expect(screen.getByRole('alert').textContent).toMatch(
      /workspace.*no longer available/,
    );
    expect(
      screen.getByRole('button', { name: 'Project: Select project' }),
    ).toBeTruthy();
    fireEvent.keyDown(screen.getByPlaceholderText('Search agents...'), {
      key: 'Enter',
    });
    expect(view.onSelect).not.toHaveBeenCalled();
  });
  test('failed and pending connection rechecks cannot dispatch retained ready rows', async () => {
    const view = harness();
    await openSetup();
    readError = new Error('connection read refused');
    view.update({ agents: [READY] });
    await returnToChat();
    fireEvent.click(screen.getByRole('button', { name: /^Assistant/ }));
    expect(view.onSelect).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'Retry connections' }),
    ).toBeTruthy();
    readError = undefined;
    fetching = true;
    view.update({ agents: [READY] });
    expect(
      (screen.getByRole('button', { name: /^Assistant/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe('New Chat retained context safeguards', () => {
  test('removed explicit Model requires a new explicit choice', async () => {
    const view = harness();
    fireEvent.click(screen.getByRole('button', { name: /^Model:/ }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Choose Chosen model' }),
    );
    await openSetup();
    models = [{ id: 'default', name: 'Default' }];
    view.update({ agents: [READY] });
    await returnToChat();
    fireEvent.keyDown(screen.getByPlaceholderText('Search agents...'), {
      key: 'Enter',
    });
    expect(view.onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(
      /Model.*no longer available/,
    );
  });
  test('omitted draft context stays omitted when props refresh during setup', async () => {
    const draftContext = {
      title: 'Context',
      description: 'Pick context',
      items: [
        { id: 'keep', label: 'Keep', detail: 'kept', messageLine: 'Keep this' },
        {
          id: 'omit',
          label: 'Omit',
          detail: 'omitted',
          messageLine: 'Do not carry this',
        },
      ],
    };
    const view = harness({ draftContext });
    fireEvent.click(screen.getByRole('button', { name: /Omit/ }));
    await openSetup();
    view.update({
      agents: [READY],
      draftContext: { ...draftContext, items: [...draftContext.items] },
    });
    await returnToChat();
    fireEvent.keyDown(screen.getByPlaceholderText('Search agents...'), {
      key: 'Enter',
    });
    expect(view.onSelect).toHaveBeenCalledTimes(1);
    expect(view.onSelect.mock.calls[0][3]).toContain('Keep this');
    expect(view.onSelect.mock.calls[0][3]).not.toContain('Do not carry this');
  });
  test('a fresh modal owner removes the suspended banner and discards its choices', async () => {
    const view = harness();
    fireEvent.click(screen.getByRole('button', { name: 'Project: Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: /Beta/ }));
    await openSetup();
    view.unmount();
    harness();
    expect(
      screen.queryByRole('button', { name: 'Return to New Chat' }),
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'Project: Alpha' })).toBeTruthy();
  });
});

test('return waits for the owning setup form navigation guard', async () => {
  harness();
  await openSetup();
  let continueNavigation: (() => void) | undefined;
  const unregister = navigationStore.registerNavigationGuard(
    Symbol('setup form'),
    (proceed) => {
      continueNavigation = proceed;
    },
  );
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Return to New Chat' }));
    expect(screen.queryByRole('dialog', { name: 'New Chat' })).toBeNull();
    expect(navigationStore.getSnapshot().pathname).toMatch(/^\/connections/);
    await waitFor(() => expect(continueNavigation).toBeTypeOf('function'));
    act(() => continueNavigation?.());
    await screen.findByRole('dialog', { name: 'New Chat' });
  } finally {
    unregister();
  }
});

test('refetch promises fence immediate interaction before fetching notifications', async () => {
  const view = harness();
  await openSetup();
  view.update({ agents: [READY] });
  const settle: Array<() => void> = [];
  refetch.mockImplementation(
    () => new Promise<void>((resolve) => settle.push(resolve)),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Return to New Chat' }));
  expect(screen.queryByRole('dialog', { name: 'New Chat' })).toBeNull();
  expect(view.onSelect).not.toHaveBeenCalled();
  await waitFor(() => expect(settle).toHaveLength(2));
  await act(async () => {
    settle[0]();
  });
  expect(screen.queryByRole('dialog', { name: 'New Chat' })).toBeNull();
  await act(async () => {
    settle[1]();
  });
  await screen.findByRole('dialog', { name: 'New Chat' });
  expect(view.onSelect).not.toHaveBeenCalled();
});

test('cancel during revalidation retires the pending continuation', async () => {
  const view = harness();
  await openSetup();
  const settle: Array<() => void> = [];
  refetch.mockImplementation(
    () => new Promise<void>((resolve) => settle.push(resolve)),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Return to New Chat' }));
  await waitFor(() => expect(settle).toHaveLength(2));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel return' }));
  await act(async () => {
    settle.forEach((resolve) => resolve());
  });
  expect(screen.queryByRole('dialog', { name: 'New Chat' })).toBeNull();
  expect(view.onClose).toHaveBeenCalledTimes(1);
  expect(view.onSelect).not.toHaveBeenCalled();
});

test('restores an exact non-default Pane path, tab and query selection', async () => {
  act(() =>
    navigationStore.navigate(
      '/projects/alpha/layouts/coding/panes/pane%3Abuiltin%3Acoding%3Afile-browser/files-1?tab=diff&agent=assistant&pane=review-pane&paneScope=alpha&custom=selected',
    ),
  );
  const origin = navigationStore.captureLocation();
  harness();
  await openSetup();
  act(() =>
    navigationStore.updateParams({
      view: 'provider-settings',
      custom: 'changed',
    }),
  );
  await returnToChat();
  expect(navigationStore.isCurrentLocation(origin)).toBe(true);
  expect(new URLSearchParams(window.location.search).get('view')).toBeNull();
  expect(new URLSearchParams(window.location.search).get('tab')).toBe('diff');
});

test('opening repair from the same Connections route stays in setup', async () => {
  act(() => navigationStore.navigate('/connections/models'));
  harness();
  await openSetup();
  await act(async () => {});
  expect(screen.queryByRole('dialog', { name: 'New Chat' })).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Return to New Chat' }),
  ).toBeTruthy();
  await returnToChat();
  expect(navigationStore.getSnapshot().pathname).toBe('/connections/models');
});

test('same-path query restoration honors a rejecting dirty-form guard', async () => {
  act(() => navigationStore.navigate('/connections/models?selected=original'));
  harness();
  await openSetup();
  act(() => navigationStore.updateParams({ selected: 'editing' }));
  const unregister = navigationStore.registerNavigationGuard(
    Symbol('dirty model form'),
    (_proceed, reject) => reject?.(),
  );
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Return to New Chat' }));
    await act(async () => {});
    expect(screen.queryByRole('dialog', { name: 'New Chat' })).toBeNull();
    expect(new URLSearchParams(window.location.search).get('selected')).toBe(
      'editing',
    );
  } finally {
    unregister();
  }
  await returnToChat();
  expect(new URLSearchParams(window.location.search).get('selected')).toBe(
    'original',
  );
});

test.each(['cancel', 'authority loss'] as const)(
  '%s revokes a delayed return before its route commit',
  async (reason) => {
    const view = harness();
    await openSetup();
    const repairLocation = navigationStore.captureLocation();
    let approve: (() => void) | undefined;
    const unregister = navigationStore.registerNavigationGuard(
      Symbol('dirty form'),
      (proceed) => {
        approve = proceed;
      },
    );
    try {
      fireEvent.click(
        screen.getByRole('button', { name: 'Return to New Chat' }),
      );
      await waitFor(() => expect(approve).toBeTypeOf('function'));
      if (reason === 'cancel')
        fireEvent.click(screen.getByRole('button', { name: 'Cancel return' }));
      else {
        authorityCurrent = false;
        view.update({
          requestAuthority: { ...authority, authorityKey: 'changed' },
        });
      }
      await act(async () => approve?.());
      expect(navigationStore.isCurrentLocation(repairLocation)).toBe(true);
      expect(screen.queryByRole('dialog', { name: 'New Chat' })).toBeNull();
      expect(view.onClose).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  },
);

test('a written goal returns from setup automatically when its selected agent is ready', async () => {
  const goal = 'Keep the original goal';
  const view = harness({ startWithDefault: true, initialPrompt: goal });
  fireEvent.click(screen.getByRole('button', { name: 'Connect this agent' }));
  await waitFor(() =>
    expect(navigationStore.getSnapshot().pathname).toMatch(/^\/connections/),
  );
  view.update({ agents: [READY] });
  await waitFor(() => expect(view.onSelect).toHaveBeenCalledOnce());
  expect(view.onSelect.mock.calls[0]?.[3]).toBe(goal);
  expect(navigationStore.getSnapshot().pathname).toBe('/');
});

test('opening setup commits the destination before retiring dialog history and keeps the returned draft writable', async () => {
  const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
  try {
    const view = harness({ agents: [READY] });
    fireEvent.change(screen.getByPlaceholderText('Search agents...'), {
      target: { value: '' },
    });
    view.update({ agents: [NEEDS_SETUP] });
    await openSetup();
    expect(back).not.toHaveBeenCalled();
    view.update({ agents: [READY] });
    await returnToChat();
    fireEvent.keyDown(screen.getByPlaceholderText('Search agents...'), {
      key: 'Enter',
    });
    expect(view.onSelect).toHaveBeenCalledOnce();
  } finally {
    cleanup();
    back.mockRestore();
  }
});

test('a refused setup navigation restores the draft with feedback instead of leaving a waiting banner', async () => {
  const view = harness();
  const unregister = navigationStore.registerNavigationGuard(
    Symbol('cancel setup'),
    (_proceed, cancel) => cancel?.(),
  );
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Connect Assistant' }));
    await screen.findByText(/Could not open setup/);
    expect(screen.getByRole('dialog', { name: 'New Chat' })).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Return to New Chat' }),
    ).toBeNull();
    expect(navigationStore.getSnapshot().pathname).toBe('/');
    expect(view.onSelect).not.toHaveBeenCalled();
  } finally {
    unregister();
  }
});

test('composer setup returns directly to the retained message and repaired Agent without starting work', async () => {
  const view = harness({ startSurface: true, agents: [NEEDS_SETUP] });
  fireEvent.change(
    screen.getByRole('textbox', { name: 'What would you like done?' }),
    { target: { value: 'Keep my message' } },
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Connect Assistant' }),
  );
  await waitFor(() =>
    expect(navigationStore.getSnapshot().pathname).toBe('/connections/models'),
  );
  view.update({ agents: [READY] });
  fireEvent.click(screen.getByRole('button', { name: 'Return to New Chat' }));
  expect(
    await screen.findByRole('textbox', { name: 'What would you like done?' }),
  ).toHaveProperty('value', 'Keep my message');
  expect(view.onSelect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Start' }));
  expect(view.onSelect).toHaveBeenCalledOnce();
  expect(view.onSelect.mock.calls[0][3]).toBe('Keep my message');
});

// Owner decision 1: setup from Home's composer is handed to this composer,
// where the setup journey survives the page change. The hand-off must be
// lossless: the prompt, the project, the Agent and the Model Home's chips
// showed all come back after setup, and start exactly as chosen.
test("a hand-off from Home's composer runs setup here and returns with the prompt and every choice intact", async () => {
  const view = harness({
    startSurface: true,
    agents: [NEEDS_SETUP],
    initialPrompt: 'Keep my Home message',
    startSelection: {
      context: 'beta',
      agentSlug: 'assistant',
      model: { modelId: 'chosen', providerOptions: { effort: 'high' } },
    },
    handoff: { kind: 'repair', agentSlug: 'assistant', route: 'models' },
  });
  // The hand-off starts the setup journey by itself: no second click.
  await waitFor(() =>
    expect(navigationStore.getSnapshot().pathname).toBe('/connections/models'),
  );
  view.update({ agents: [READY] });
  fireEvent.click(
    await screen.findByRole('button', { name: 'Return to New Chat' }),
  );
  expect(
    await screen.findByRole('textbox', { name: 'What would you like done?' }),
  ).toHaveProperty('value', 'Keep my Home message');
  expect(screen.getByRole('button', { name: 'Project: Beta' })).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Agent: Assistant · Chosen' }),
  ).toBeTruthy();
  expect(view.onSelect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Start' }));
  expect(view.onSelect).toHaveBeenCalledOnce();
  const call = view.onSelect.mock.calls[0];
  expect(call[0].slug).toBe('assistant');
  expect(call[1]).toBe('beta');
  expect(call[3]).toBe('Keep my Home message');
  expect(call[4]).toBe('chosen');
  expect(call[8]).toEqual({ effort: 'high' });
});
