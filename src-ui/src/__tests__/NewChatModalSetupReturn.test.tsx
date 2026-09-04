// @vitest-environment jsdom
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

vi.mock('@kontourai/station-sdk', () => ({
  useMaterializeEngineAgentMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
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
  expect(screen.queryByRole('dialog', { name: 'New Chat' })).toBeNull();
}
async function returnToChat() {
  fireEvent.click(screen.getByRole('button', { name: 'Return to New Chat' }));
  await screen.findByRole('dialog', { name: 'New Chat' });
}
beforeAll(() => {
  window.matchMedia = vi.fn().mockReturnValue({ matches: false });
  Element.prototype.scrollIntoView = vi.fn();
});
beforeEach(() => {
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
  test('retains intentional Project and Model through repair without selecting or sending', async () => {
    const view = harness();
    fireEvent.click(screen.getByRole('button', { name: 'Workspace: Alpha' }));
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
    expect(
      screen.getByRole('button', { name: 'Workspace: Beta' }),
    ).toBeTruthy();
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
      screen.getByRole('button', { name: 'Workspace: Select workspace' }),
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
    fireEvent.click(screen.getByRole('button', { name: 'Workspace: Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: /Beta/ }));
    await openSetup();
    view.unmount();
    harness();
    expect(
      screen.queryByRole('button', { name: 'Return to New Chat' }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Workspace: Alpha' }),
    ).toBeTruthy();
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
    expect(continueNavigation).toBeTypeOf('function');
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
