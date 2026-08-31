/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const save = vi.fn();
const clearMutate = vi.fn();
const applyMutate = vi.fn();
const enrollmentMutate = vi.fn();
const policyMutate = vi.fn();
const upsertMutate = vi.fn();
const deleteProfileMutate = vi.fn();
const importProfileMutate = vi.fn();
let saveFailure: Error | null = null;
let connectionQueryData: unknown = null;
let appHomeProfileQueryData: unknown = null;
let credentialRecoveryQueryData: unknown = null;
let credentialRecoveryQueryError: Error | null = null;
const refetchCredentialRecovery = vi.fn();
let agentConnectionsQueryError: Error | null = null;
const refetchAgentConnections = vi.fn();
let importProfileMutationData: unknown = null;
let upsertMutationError: Error | null = null;
let deleteProfileMutationError: Error | null = null;
let enrollmentMutationError: Error | null = null;
let policyMutationError: Error | null = null;
let importProfileMutationError: Error | null = null;
let applyMutationError: Error | null = null;
const refetchEnrolment = vi.fn();

/**
 * archive#3981: the two engine reads are separate fixtures now so a test can
 * drive a state the hardcoded pair could not — a connection the `/agents`
 * inventory reports with `setup.state: 'available'`. Both default to exactly
 * what they were, so every existing case is unchanged.
 */
const DEFAULT_AGENT_CONNECTIONS: unknown[] = [
  {
    id: 'codex',
    kind: 'agent',
    type: 'codex',
    name: 'Codex',
    enabled: true,
    status: 'ready',
    description: 'Ready local Codex app.',
    capabilities: ['agent-runtime'],
    prerequisites: [],
    config: { executionClass: 'connected', providerLabel: 'Codex' },
    setup: { state: 'ready', detected: true, configured: false },
  },
  {
    id: 'bedrock-runtime',
    kind: 'agent',
    type: 'bedrock-runtime',
    name: 'Station engine',
    enabled: true,
    status: 'ready',
    capabilities: ['agent-runtime'],
    prerequisites: [],
    config: { executionClass: 'managed' },
    setup: { state: 'ready', detected: true, configured: false },
  },
];
const DEFAULT_AGENT_CATALOG: unknown[] = [
  {
    id: 'claude',
    kind: 'agent',
    type: 'claude',
    name: 'Claude Code',
    enabled: true,
    status: 'missing_prerequisites',
    description: 'Claude Code integration.',
    capabilities: ['agent-runtime'],
    prerequisites: [],
    config: { executionClass: 'connected', providerLabel: 'Claude' },
    setup: { state: 'available', detected: true, configured: false },
  },
];
let agentConnections: unknown[] = DEFAULT_AGENT_CONNECTIONS;
let agentCatalog: unknown[] = DEFAULT_AGENT_CATALOG;
/**
 * #592 slice 2: the merged Add-engine catalogue's second population. Empty
 * by default so every pre-existing native-only test is unchanged; tests that
 * exercise the ACP half set this explicitly.
 */
let acpRegistryEntries: unknown[] = [];

vi.mock('@kontourai/station-sdk', () => ({
  useSkillsQuery: () => ({
    data: [
      { name: 'pizza-skill', description: 'Bakes a pizza' },
      { name: 'salad-skill', description: 'Tosses a salad' },
    ],
  }),
  useAgentConnectionsQuery: () => ({
    isLoading: false,
    data: agentConnections,
    error: agentConnectionsQueryError,
    refetch: refetchAgentConnections,
  }),
  useAgentConnectionCatalogQuery: () => ({ data: agentCatalog }),
  useAgentConnectionQuery: () => ({ data: connectionQueryData }),
  useSaveAgentConnectionMutation: (options: {
    onError?: (error: Error) => void;
  }) => ({
    mutate: (variables: unknown) => {
      save(variables);
      if (saveFailure) options.onError?.(saveFailure);
    },
    isPending: false,
    variables: undefined,
  }),
  useDeleteAgentConnectionMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useTestAgentConnectionMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useAppHomeProfileQuery: () => ({ data: appHomeProfileQueryData }),
  useCredentialRecoveryQuery: () => ({
    data: credentialRecoveryQueryData,
    isLoading: false,
    isError: credentialRecoveryQueryError !== null,
    error: credentialRecoveryQueryError,
    refetch: refetchCredentialRecovery,
  }),
  useEnrolmentQuery: () => ({
    data: {
      authState: 'unknown',
      command: {
        command: 'codex',
        args: ['login'],
        env: {},
        description: 'Checks the credential entry with Codex itself.',
      },
    },
    error: null,
    isLoading: false,
    isFetching: false,
    refetch: refetchEnrolment,
  }),
  useUpsertCredentialProfileMutation: () => ({
    mutate: upsertMutate,
    isPending: false,
    error: upsertMutationError,
  }),
  useDeleteCredentialProfileMutation: () => ({
    mutate: deleteProfileMutate,
    isPending: false,
    error: deleteProfileMutationError,
  }),
  useSetCredentialProfileEnrollmentMutation: () => ({
    mutate: enrollmentMutate,
    isPending: false,
    error: enrollmentMutationError,
  }),
  useSetCredentialRecoveryAutomaticPolicyMutation: () => ({
    mutate: policyMutate,
    isPending: false,
    error: policyMutationError,
  }),
  useImportCredentialProfileSnapshotMutation: () => ({
    mutate: importProfileMutate,
    isPending: false,
    error: importProfileMutationError,
    data: importProfileMutationData,
  }),
  useApplyCredentialProfileMutation: () => ({
    mutate: applyMutate,
    isPending: false,
    error: applyMutationError,
    data: null,
  }),
  useImportAppHomeSnapshotMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useCreateSetupImportPreviewMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    data: null,
  }),
  useApplySetupImportMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    data: null,
  }),
  useClearAppHomeProfileMutation: () => ({
    mutate: clearMutate,
    isPending: false,
    error: null,
  }),
}));

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

vi.mock('../hooks/useACPConnections', () => ({
  useACPConnections: () => ({ data: [] }),
  useACPConnectionRegistry: () => ({ data: acpRegistryEntries }),
}));

import { AgentConnectionView } from '../views/AgentConnectionView';

describe('AgentConnectionView', () => {
  beforeEach(() => {
    save.mockReset();
    clearMutate.mockReset();
    applyMutate.mockReset();
    enrollmentMutate.mockReset();
    policyMutate.mockReset();
    upsertMutate.mockReset();
    deleteProfileMutate.mockReset();
    importProfileMutate.mockReset();
    saveFailure = null;
    agentConnections = DEFAULT_AGENT_CONNECTIONS;
    agentCatalog = DEFAULT_AGENT_CATALOG;
    acpRegistryEntries = [];
    connectionQueryData = null;
    appHomeProfileQueryData = null;
    credentialRecoveryQueryData = null;
    credentialRecoveryQueryError = null;
    refetchCredentialRecovery.mockReset();
    agentConnectionsQueryError = null;
    refetchAgentConnections.mockReset();
    importProfileMutationData = null;
    upsertMutationError = null;
    deleteProfileMutationError = null;
    enrollmentMutationError = null;
    policyMutationError = null;
    importProfileMutationError = null;
    applyMutationError = null;
    window.localStorage.clear();
  });

  // CI-R10: /connections/providers and /connections/engines both rendered the
  // H1 "Providers" and the breadcrumb CONNECTIONS / PROVIDERS, so four paths
  // produced one indistinguishable title. The engines route owns the noun the
  // redirect table already treats as canonical.
  /**
   * archive#3981, reported from an upgraded Nightly: engines detected and
   * ready, `Connections -> Engines` rendering zero rows, and `Add engine`
   * claiming every provider was already listed. No UI path existed to persist
   * a detected engine.
   *
   * The two surfaces read the same inventory and subtract it differently. The
   * list drops `setup.state === 'available'` rows (right: `available` means
   * supported-but-not-yet-added, so it is not a configured engine). The Add
   * catalogue then subtracts EVERY id in that same inventory — including the
   * rows the list just dropped — so an `available` engine is removed from
   * both, and the emptied catalogue asserts the opposite of what the reader
   * can see beside it.
   */
  test('an engine the list drops as not-yet-added is still offered in Add', () => {
    agentConnections = [
      ...DEFAULT_AGENT_CONNECTIONS,
      {
        id: 'muse',
        kind: 'agent',
        type: 'muse',
        name: 'Muse',
        enabled: true,
        status: 'ready',
        description: 'Detected locally, not yet added.',
        capabilities: ['agent-runtime'],
        prerequisites: [],
        config: { executionClass: 'connected', providerLabel: 'Muse' },
        setup: { state: 'available', detected: true, configured: false },
      },
    ];
    agentCatalog = [
      ...DEFAULT_AGENT_CATALOG,
      {
        id: 'muse',
        kind: 'agent',
        type: 'muse',
        name: 'Muse',
        enabled: true,
        status: 'ready',
        description: 'Detected locally, not yet added.',
        capabilities: ['agent-runtime'],
        prerequisites: [],
        config: { executionClass: 'connected', providerLabel: 'Muse' },
        setup: { state: 'available', detected: true, configured: false },
      },
    ];

    const { rerender } = render(<AgentConnectionView onNavigate={vi.fn()} />);
    // Not a configured engine, so the list is right to omit it.
    expect(screen.queryByText('Muse')).toBeNull();

    rerender(
      <AgentConnectionView selectedRuntimeId="new" onNavigate={vi.fn()} />,
    );

    //.which makes Add the only place it can be reached. Being absent from
    // both is the reported dead end.
    expect(screen.getByText('Muse')).toBeTruthy();
    expect(
      screen.queryByText('Every supported engine is already listed'),
    ).toBeNull();
  });

  test('the already-listed claim is reserved for a catalogue nothing is missing from', () => {
    // Every catalogue entry really is a configured engine here, so the
    // sentence is true and must still render.
    agentConnections = [
      {
        id: 'claude',
        kind: 'agent',
        type: 'claude',
        name: 'Claude Code',
        enabled: true,
        status: 'ready',
        capabilities: ['agent-runtime'],
        prerequisites: [],
        config: { executionClass: 'connected', providerLabel: 'Claude' },
        setup: { state: 'ready', detected: true, configured: true },
      },
    ];

    render(
      <AgentConnectionView selectedRuntimeId="new" onNavigate={vi.fn()} />,
    );

    expect(
      screen.getByText('Every supported engine is already listed'),
    ).toBeTruthy();
    // #592 slice 2, review M4b: the manual escape hatch is not part of the
    // "supported engine" claim above — it must still be there, and usable,
    // when both catalog populations are exhausted.
    expect(screen.getByText('Custom engine')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Set up custom engine' }),
    ).toBeTruthy();
  });

  // #592 slice 2, review M4a: `hasCatalogEntries` reads
  // `connections.length > 0 || commandEntries.length > 0` — a rewrite that
  // silently dropped the `commandEntries` term (checking only the native
  // population) would still pass every OTHER test in this file, since none
  // of them exercises "native empty, ACP non-empty" on its own. This is the
  // one that would catch it.
  test('the empty-state claim requires both populations exhausted, not just the native one', () => {
    agentCatalog = [];
    acpRegistryEntries = [
      {
        id: 'kiro',
        name: 'Kiro CLI',
        command: 'kiro',
        installed: false,
        detected: true,
      },
    ];

    render(
      <AgentConnectionView selectedRuntimeId="new" onNavigate={vi.fn()} />,
    );

    expect(
      screen.queryByText('Every supported engine is already listed'),
    ).toBeNull();
    expect(screen.getByText('Kiro CLI')).toBeTruthy();
  });

  test('titles the engines route Engines, not Providers', () => {
    render(<AgentConnectionView onNavigate={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'Engines' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Providers' })).toBeNull();
    // The breadcrumb reads CONNECTIONS / ENGINES too; nothing on this route
    // says "Providers" any more.
    expect(screen.queryAllByText('Providers')).toHaveLength(0);
    expect(screen.getAllByText('Engines').length).toBeGreaterThan(1);
  });

  // archive#771 regression: `useAgentConnectionsQuery`'s isLoading was
  // consulted by `SplitPaneLayout`'s `loading` prop but its error was never
  // passed through, so a settled read failure rendered the same "no engines"
  // empty state as a host with none configured — no error, no retry.
  test('renders the engines list error state with retry when the connections query fails', () => {
    agentConnections = [];
    agentConnectionsQueryError = new Error('engines unavailable');

    render(<AgentConnectionView onNavigate={vi.fn()} />);

    expect(screen.getByText('engines unavailable')).toBeTruthy();
    expect(screen.queryByText('Codex')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetchAgentConnections).toHaveBeenCalledTimes(1);
  });

  // The section frame owns this section's single add action and reaches the
  // catalogue by route (`/connections/engines/new`), not by an in-view button
  // so the route is what these two drive now.
  test('keeps available apps in Add and hides the managed Station engine', () => {
    const { rerender } = render(<AgentConnectionView onNavigate={vi.fn()} />);

    expect(screen.getByText('Codex')).toBeTruthy();
    expect(screen.queryByText('Claude Code')).toBeNull();
    expect(screen.queryByText('Station engine')).toBeNull();

    rerender(
      <AgentConnectionView selectedRuntimeId="new" onNavigate={vi.fn()} />,
    );

    expect(screen.getByRole('heading', { name: 'Add engine' })).toBeTruthy();
    expect(screen.getByText('Claude Code')).toBeTruthy();
    // #592 slice 2: the bespoke Detected/Available chip retired in favor of
    // the same ProviderReadiness vocabulary every other picker uses —
    // `setup.state: 'available', detected: true` reads "Found, not
    // connected" everywhere else on Connections.
    expect(screen.getByText('Found, not connected')).toBeTruthy();
    expect(screen.queryByText('Station engine')).toBeNull();

    // #592 slice 2 review M3: bare "Add" is ambiguous with more than one row
    // in the catalogue — the accessible name carries the engine's own name.
    fireEvent.click(screen.getByRole('button', { name: 'Add Claude Code' }));
    expect(save).toHaveBeenCalledWith({
      connection: expect.objectContaining({ id: 'claude' }),
      isNew: false,
    });
  });

  // #592 slice 2, review M1: the catalog endpoint is not
  // registration-authoritative (`AgentConnectionView.tsx`'s own
  // `isAddedEngine` doc comment) — it can carry a row this Station already
  // treats as usable that the runtime inventory has no record of adding yet.
  // Before this fix, `availableAgentApps` only excluded rows already in
  // `addedIds`; it never required the catalog row's OWN `setup.state` to be
  // `'available'`, so a `'ready'` row rendered here beside an "Add" button.
  test('a catalog row that already reads ready is not offered as an Add choice', () => {
    agentCatalog = [
      ...DEFAULT_AGENT_CATALOG,
      {
        id: 'already-ready',
        kind: 'agent',
        type: 'already-ready-runtime',
        name: 'Already Ready',
        enabled: true,
        status: 'ready',
        capabilities: ['agent-runtime'],
        prerequisites: [],
        config: { executionClass: 'connected' },
        // Reads 'ready' on the catalog's own copy — never in
        // `agentConnections`, so nothing in the runtime inventory says this
        // is added either.
        setup: { state: 'ready', detected: true, configured: true },
      },
    ];

    render(
      <AgentConnectionView selectedRuntimeId="new" onNavigate={vi.fn()} />,
    );

    expect(screen.getByText('Claude Code')).toBeTruthy();
    expect(screen.queryByText('Already Ready')).toBeNull();
    expect(screen.queryByRole('button', { name: /Already Ready/ })).toBeNull();
  });

  // #592 slice 2: the catalogue that used to live only inside the ACP add
  // modal (reached via a second "Add engine" button the ACP section owned)
  // is now this same list's second population, sharing its readiness
  // vocabulary and continuing into the existing ACP setup route rather than
  // a second catalogue.
  test('the merged catalogue offers both populations and routes an ACP choice into its setup route', () => {
    acpRegistryEntries = [
      {
        id: 'kiro',
        name: 'Kiro CLI',
        command: 'kiro',
        description:
          'Connect the Kiro CLI installed on this machine as an engine.',
        installed: false,
        detected: true,
      },
      {
        id: 'opencode',
        name: 'OpenCode',
        command: 'opencode',
        description:
          'Connect the OpenCode CLI installed on this machine as an engine.',
        installed: false,
        detected: false,
      },
      // Already configured — must not reappear as an add choice.
      {
        id: 'configured-cli',
        name: 'Configured CLI',
        command: 'configured-cli',
        installed: true,
        detected: true,
      },
    ];
    const onNavigate = vi.fn();

    render(
      <AgentConnectionView selectedRuntimeId="new" onNavigate={onNavigate} />,
    );

    // Native population, unchanged.
    expect(screen.getByText('Claude Code')).toBeTruthy();
    // ACP population, sharing the same readiness vocabulary.
    expect(screen.getByText('Kiro CLI')).toBeTruthy();
    expect(screen.getAllByText('Found, not connected').length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText('OpenCode')).toBeTruthy();
    expect(screen.getByText('Setup required')).toBeTruthy();
    expect(screen.queryByText('Configured CLI')).toBeNull();
    // The always-available manual escape hatch.
    expect(screen.getByText('Custom engine')).toBeTruthy();

    // #592 slice 2 review M3: bare "Connect"/"Set up" are ambiguous across
    // rows — the accessible name carries the engine's own name too.
    fireEvent.click(screen.getByRole('button', { name: 'Connect Kiro CLI' }));
    expect(onNavigate).toHaveBeenCalledWith({
      type: 'connections-acp-new',
      providerId: 'kiro',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Set up OpenCode' }));
    expect(onNavigate).toHaveBeenCalledWith({
      type: 'connections-acp-new',
      providerId: 'opencode',
    });
  });

  test('the merged catalogue routes the trailing custom entry into the ACP custom setup route', () => {
    const onNavigate = vi.fn();

    render(
      <AgentConnectionView selectedRuntimeId="new" onNavigate={onNavigate} />,
    );

    expect(screen.getByText('Custom engine')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Set up custom engine' }),
    );
    expect(onNavigate).toHaveBeenCalledWith({
      type: 'connections-acp-new',
      providerId: 'custom',
    });
  });

  test('reports Add catalog save failures in place', () => {
    saveFailure = new Error('Could not add Claude Code');
    render(
      <AgentConnectionView selectedRuntimeId="new" onNavigate={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add Claude Code' }));

    expect(screen.getByText('Could not add Claude Code')).toBeTruthy();
  });

  test.each([
    [
      'ready',
      false,
      'ready',
      [
        {
          id: 'claude-cli',
          name: 'Claude CLI',
          description: 'Claude executable available on PATH.',
          status: 'installed',
          category: 'required',
        },
      ],
      'Ready',
      null,
    ],
    [
      'configured',
      true,
      'missing_prerequisites',
      [
        {
          id: 'codex-cli',
          name: 'Codex CLI',
          description: 'Codex executable available on PATH.',
          status: 'installed',
          category: 'required',
        },
        {
          id: 'codex-auth',
          name: 'Codex sign-in',
          description: 'Sign in to Codex.',
          status: 'missing',
          category: 'required',
        },
      ],
      'Sign in required',
      'Sign in to finish connecting.',
    ],
    [
      'available',
      false,
      'missing_prerequisites',
      [
        {
          id: 'claude-cli',
          name: 'Claude CLI',
          description: 'Claude executable required on PATH.',
          status: 'missing',
          category: 'required',
        },
      ],
      'Setup required',
      'Finish setup before using it.',
    ],
  ] as const)(
    'projects the backend %s setup tuple into the provider detail',
    (state, configured, status, prerequisites, readiness, detail) => {
      connectionQueryData = {
        id: 'claude',
        kind: 'agent',
        type: 'claude',
        name: 'Claude Code',
        enabled: true,
        status,
        capabilities: ['agent-runtime'],
        config: { executionClass: 'connected', providerLabel: 'Claude' },
        prerequisites,
        setup: {
          state,
          detected: state !== 'available',
          configured,
        },
      };

      render(
        <AgentConnectionView selectedRuntimeId="claude" onNavigate={vi.fn()} />,
      );

      expect(screen.getAllByText(readiness)).not.toHaveLength(0);
      if (detail) {
        expect(screen.getAllByText(detail)).not.toHaveLength(0);
      }
    },
  );

  test('claude shows an accessible skills-materialization multiselect, off by default, that saves the selected ids', () => {
    connectionQueryData = {
      id: 'claude',
      kind: 'agent',
      type: 'claude',
      name: 'Claude Code',
      enabled: true,
      status: 'ready',
      description: 'Claude Code integration.',
      capabilities: ['agent-runtime'],
      prerequisites: [],
      config: {
        executionClass: 'connected',
        providerLabel: 'Claude',
        provideSkills: [],
      },
      setup: { state: 'ready', detected: true, configured: false },
    };

    render(
      <AgentConnectionView selectedRuntimeId="claude" onNavigate={vi.fn()} />,
    );

    fireEvent.click(screen.getByText('Advanced'));
    expect(screen.getByText('Skills materialization')).toBeTruthy();
    const pizzaCheckbox = screen.getByRole('checkbox', {
      name: /pizza-skill/,
    });
    expect((pizzaCheckbox as HTMLInputElement).checked).toBe(false);

    fireEvent.click(pizzaCheckbox);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(save).toHaveBeenCalledWith({
      connection: expect.objectContaining({
        id: 'claude',
        config: expect.objectContaining({ provideSkills: ['pizza-skill'] }),
      }),
      isNew: false,
    });
  });

  test('claude shows the app-home opt-in, off by default, that saves the toggle', () => {
    connectionQueryData = {
      id: 'claude',
      kind: 'agent',
      type: 'claude',
      name: 'Claude Code',
      enabled: true,
      status: 'ready',
      description: 'Claude Code integration.',
      capabilities: ['agent-runtime'],
      prerequisites: [],
      config: {
        executionClass: 'connected',
        providerLabel: 'Claude',
        provideSkills: [],
        useAppHome: false,
      },
      setup: { state: 'ready', detected: true, configured: false },
    };

    render(
      <AgentConnectionView selectedRuntimeId="claude" onNavigate={vi.fn()} />,
    );

    fireEvent.click(screen.getByText('Advanced'));
    const appHomeCheckbox = screen.getByRole('checkbox', {
      name: /Run sessions in a Station-managed app home/,
    });
    expect((appHomeCheckbox as HTMLInputElement).checked).toBe(false);
    // Import stays hidden until the toggle is on — never a silent action.
    expect(
      screen.queryByRole('button', {
        name: 'Import a snapshot of your global Claude Code settings',
      }),
    ).toBeNull();

    fireEvent.click(appHomeCheckbox);
    expect(
      screen.getByRole('button', {
        name: 'Import a snapshot of your global Claude Code settings',
      }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(save).toHaveBeenCalledWith({
      connection: expect.objectContaining({
        id: 'claude',
        config: expect.objectContaining({ useAppHome: true }),
      }),
      isNew: false,
    });
  });

  // archive#896: codex joins the app-home opt-in.
  test('codex shows the app-home opt-in, off by default, that saves the toggle', () => {
    connectionQueryData = {
      id: 'codex',
      kind: 'agent',
      type: 'codex',
      name: 'Codex',
      enabled: true,
      status: 'ready',
      description: 'Codex app-server engine.',
      capabilities: ['agent-runtime'],
      prerequisites: [],
      config: {
        executionClass: 'connected',
        providerLabel: 'Codex',
        useAppHome: false,
      },
      setup: { state: 'ready', detected: true, configured: false },
    };

    render(
      <AgentConnectionView selectedRuntimeId="codex" onNavigate={vi.fn()} />,
    );

    fireEvent.click(screen.getByText('Advanced'));
    const appHomeCheckbox = screen.getByRole('checkbox', {
      name: /Run sessions in a Station-managed app home/,
    });
    expect((appHomeCheckbox as HTMLInputElement).checked).toBe(false);
    // Import stays hidden until the toggle is on — never a silent action.
    expect(
      screen.queryByRole('button', {
        name: 'Import a snapshot of your global Codex settings',
      }),
    ).toBeNull();

    fireEvent.click(appHomeCheckbox);
    expect(
      screen.getByRole('button', {
        name: 'Import a snapshot of your global Codex settings',
      }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(save).toHaveBeenCalledWith({
      connection: expect.objectContaining({
        id: 'codex',
        config: expect.objectContaining({ useAppHome: true }),
      }),
      isNew: false,
    });
  });

  // archive#896: bounded profile GC — usage report + explicit clear.
  test('the app home clear action confirms before calling the clear mutation', () => {
    connectionQueryData = {
      id: 'claude',
      kind: 'agent',
      type: 'claude',
      name: 'Claude Code',
      enabled: true,
      status: 'ready',
      description: 'Claude Code integration.',
      capabilities: ['agent-runtime'],
      prerequisites: [],
      config: {
        executionClass: 'connected',
        providerLabel: 'Claude',
        provideSkills: [],
        useAppHome: true,
      },
      setup: { state: 'ready', detected: true, configured: false },
    };
    appHomeProfileQueryData = {
      profileDir: '/station/app-homes/claude',
      exists: true,
      seededFrom: 'empty',
      authState: 'unauthenticated',
      keychainAuthPossible: false,
      usage: { sizeBytes: 2048, entryCount: 3, truncated: false },
    };

    render(
      <AgentConnectionView selectedRuntimeId="claude" onNavigate={vi.fn()} />,
    );

    fireEvent.click(screen.getByText('Advanced'));
    // Disabled while the toggle is on — must be turned off and saved first.
    const clearButton = screen.getByRole('button', {
      name: 'Clear this app home',
    });
    expect((clearButton as HTMLButtonElement).disabled).toBe(true);

    // Turn the toggle off (unsaved) to enable the clear action.
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: /Run sessions in a Station-managed app home/,
      }),
    );
    expect((clearButton as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(clearButton);
    // Never window.confirm — a ConfirmModal renders and calling the
    // mutation is gated on its own explicit confirm click.
    expect(clearMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(clearMutate).toHaveBeenCalledWith('claude');
  });

  test('credential recovery is manual-first, safely exposes credential entry labels, and requires explicit enrollment', () => {
    connectionQueryData = {
      id: 'claude',
      kind: 'agent',
      type: 'claude',
      name: 'Claude Code',
      enabled: true,
      status: 'ready',
      capabilities: ['agent-runtime'],
      prerequisites: [],
      config: { useAppHome: true },
      setup: { state: 'ready', detected: true, configured: false },
    };
    credentialRecoveryQueryData = {
      profiles: [{ ref: 'backup-profile', label: 'Backup account' }],
      group: { profileRefs: ['backup-profile'], enrolledProfileRefs: [] },
      policy: { automatic: false },
      application: {
        capability: 'restart_resume',
        activeProfileRef: 'primary-profile',
        outcome: 'adopted',
      },
    };
    importProfileMutationData = {
      outcome: 'completed',
      copied: ['settings.json', 'commands.json'],
      skipped: [{ path: 'credentials.json', reason: 'excluded' }],
      provenanceUpdated: true,
    };

    render(
      <AgentConnectionView selectedRuntimeId="claude" onNavigate={vi.fn()} />,
    );

    fireEvent.click(screen.getByText('Advanced'));
    expect(
      screen.getByRole('heading', { name: 'Credential entries' }),
    ).toBeTruthy();
    expect(screen.getByText('Active: primary-profile')).toBeTruthy();
    const automatic = screen.getByRole('checkbox', {
      name: /Automatically try an enrolled credential entry/,
    }) as HTMLInputElement;
    expect(automatic.checked).toBe(false);
    const enrollment = screen.getByRole('checkbox', {
      name: 'Allow automatic recovery selection',
    }) as HTMLInputElement;
    expect(enrollment.checked).toBe(false);

    fireEvent.click(enrollment);
    expect(enrollmentMutate).toHaveBeenCalledWith({
      id: 'claude',
      ref: 'backup-profile',
      enrolled: true,
    });
    fireEvent.click(automatic);
    expect(policyMutate).toHaveBeenCalledWith({
      id: 'claude',
      automatic: true,
    });

    // Every form control has an accessible label, and the profile ref is
    // displayed as an opaque handle rather than a filesystem location.
    expect(
      screen.getByRole('textbox', { name: 'Credential entry reference' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('textbox', { name: 'Label for backup-profile' }),
    ).toBeTruthy();
    expect(
      screen.queryByText(/\.station\/app-homes\/backup-profile/),
    ).toBeNull();
    expect(
      screen.getByRole('status', {
        name: 'Credential entry provisioning import result',
      }).textContent,
    ).toContain(
      'Provisioning import completed: 2 items copied; 1 item skipped. This credential entry is marked as imported.',
    );
    expect(screen.queryByText('settings.json')).toBeNull();
    expect(screen.queryByText('credentials.json')).toBeNull();

    const includeCredentials = screen.getByRole('checkbox', {
      name: 'Include selected credential entry sign-in credentials',
    }) as HTMLInputElement;
    expect(includeCredentials.checked).toBe(false);
    fireEvent.click(
      screen.getByRole('button', { name: 'Import into Backup account' }),
    );
    expect(importProfileMutate).toHaveBeenCalledWith({
      id: 'claude',
      ref: 'backup-profile',
      includeCredentials: false,
    });
  });

  test('treats a legacy credential-recovery response as empty and fail-closed instead of crashing the route', () => {
    connectionQueryData = {
      id: 'codex',
      kind: 'agent',
      type: 'codex',
      name: 'Codex',
      enabled: true,
      status: 'ready',
      capabilities: ['agent-runtime'],
      prerequisites: [],
      config: { useAppHome: true },
      setup: { state: 'ready', detected: true, configured: false },
    };
    credentialRecoveryQueryData = [];

    render(
      <AgentConnectionView selectedRuntimeId="codex" onNavigate={vi.fn()} />,
    );

    expect(
      screen.getByRole('heading', { name: 'Credential entries' }),
    ).toBeTruthy();
    expect(screen.getByText('No credential entries added yet.')).toBeTruthy();
    expect(
      (
        screen.getByRole('checkbox', {
          name: /Automatically try an enrolled credential entry/,
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
  });

  // archive#771 regression: a settled credential-recovery error used to fall
  // through to the same management UI a genuinely-empty response renders
  // ("No credential entries added yet."), with no indication the read failed.
  test('renders an error state with retry when the credential-recovery query fails', () => {
    connectionQueryData = {
      id: 'codex',
      kind: 'agent',
      type: 'codex',
      name: 'Codex',
      enabled: true,
      status: 'ready',
      capabilities: ['agent-runtime'],
      prerequisites: [],
      config: { useAppHome: true },
      setup: { state: 'ready', detected: true, configured: false },
    };
    credentialRecoveryQueryData = undefined;
    credentialRecoveryQueryError = new Error('credential recovery unavailable');

    render(
      <AgentConnectionView selectedRuntimeId="codex" onNavigate={vi.fn()} />,
    );

    expect(screen.getByText("Couldn't load credential entries")).toBeTruthy();
    expect(screen.getByText('credential recovery unavailable')).toBeTruthy();
    expect(screen.queryByText('No credential entries added yet.')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetchCredentialRecovery).toHaveBeenCalledTimes(1);
  });

  test('keeps recovery actions disabled when application capability is missing', () => {
    connectionQueryData = {
      id: 'codex',
      kind: 'agent',
      type: 'codex',
      name: 'Codex',
      enabled: true,
      status: 'ready',
      capabilities: ['agent-runtime'],
      prerequisites: [],
      config: { useAppHome: true },
      setup: { state: 'ready', detected: true, configured: false },
    };
    credentialRecoveryQueryData = {
      profiles: [{ ref: 'backup-profile' }],
      group: { profileRefs: ['backup-profile'], enrolledProfileRefs: [] },
      policy: { automatic: false },
    };

    render(
      <AgentConnectionView selectedRuntimeId="codex" onNavigate={vi.fn()} />,
    );

    expect(
      (
        screen.getByRole('checkbox', {
          name: /Automatically try an enrolled credential entry/,
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole('button', {
          name: 'Apply manually',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  test('keeps recovery actions disabled when group and policy state are missing', () => {
    connectionQueryData = {
      id: 'codex',
      kind: 'agent',
      type: 'codex',
      name: 'Codex',
      enabled: true,
      status: 'ready',
      capabilities: ['agent-runtime'],
      prerequisites: [],
      config: { useAppHome: true },
      setup: { state: 'ready', detected: true, configured: false },
    };
    credentialRecoveryQueryData = {
      profiles: [{ ref: 'backup-profile' }],
      application: { capability: 'restart_resume' },
    };

    render(
      <AgentConnectionView selectedRuntimeId="codex" onNavigate={vi.fn()} />,
    );

    expect(
      (
        screen.getByRole('checkbox', {
          name: /Automatically try an enrolled credential entry/,
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole('button', {
          name: 'Apply manually',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  test('unsupported capability keeps automatic recovery and manual apply disabled', () => {
    connectionQueryData = {
      id: 'codex',
      kind: 'agent',
      type: 'codex',
      name: 'Codex',
      enabled: true,
      status: 'ready',
      capabilities: ['agent-runtime'],
      prerequisites: [],
      config: { useAppHome: true },
      setup: { state: 'ready', detected: true, configured: false },
    };
    credentialRecoveryQueryData = {
      profiles: [{ ref: 'backup-profile' }],
      group: { profileRefs: ['backup-profile'], enrolledProfileRefs: [] },
      policy: { automatic: false },
      application: { capability: 'unsupported' },
    };

    render(
      <AgentConnectionView selectedRuntimeId="codex" onNavigate={vi.fn()} />,
    );

    expect(
      (
        screen.getByRole('checkbox', {
          name: /Automatically try an enrolled credential entry/,
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole('button', {
          name: 'Apply manually',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      screen.getByText(/does not declare a safe application capability/),
    ).toBeTruthy();
  });

  test('manual apply explains its billable verification and only runs after confirmation', () => {
    connectionQueryData = {
      id: 'claude',
      kind: 'agent',
      type: 'claude',
      name: 'Claude Code',
      enabled: true,
      status: 'ready',
      capabilities: ['agent-runtime'],
      prerequisites: [],
      config: { useAppHome: true },
      setup: { state: 'ready', detected: true, configured: false },
    };
    credentialRecoveryQueryData = {
      profiles: [{ ref: 'backup-profile', label: 'Backup' }],
      group: { profileRefs: ['backup-profile'], enrolledProfileRefs: [] },
      policy: { automatic: false },
      application: { capability: 'restart_resume' },
    };

    render(
      <AgentConnectionView selectedRuntimeId="claude" onNavigate={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Apply manually' }));
    expect(applyMutate).not.toHaveBeenCalled();
    expect(screen.getByText(/potentially billable engine turn/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Apply and verify' }));
    expect(applyMutate).toHaveBeenCalledWith({
      id: 'claude',
      ref: 'backup-profile',
      confirmed: true,
    });
  });

  test('a rolled-back outcome is announced as failure rather than success', () => {
    connectionQueryData = {
      id: 'claude',
      kind: 'agent',
      type: 'claude',
      name: 'Claude Code',
      enabled: true,
      status: 'ready',
      capabilities: ['agent-runtime'],
      prerequisites: [],
      config: { useAppHome: true },
      setup: { state: 'ready', detected: true, configured: false },
    };
    credentialRecoveryQueryData = {
      profiles: [],
      group: { profileRefs: [], enrolledProfileRefs: [] },
      policy: { automatic: false },
      application: { capability: 'restart_resume', outcome: 'rolled_back' },
    };

    render(
      <AgentConnectionView selectedRuntimeId="claude" onNavigate={vi.fn()} />,
    );

    expect(screen.getByRole('alert').textContent).toContain(
      'Credential application was rolled back; the active credential was not changed.',
    );
  });

  test('shows errors from every credential-profile mutation in one accessible error surface', () => {
    connectionQueryData = {
      id: 'claude',
      kind: 'agent',
      type: 'claude',
      name: 'Claude Code',
      enabled: true,
      status: 'ready',
      capabilities: ['agent-runtime'],
      prerequisites: [],
      config: { useAppHome: false },
      setup: { state: 'ready', detected: true, configured: false },
    };
    credentialRecoveryQueryData = {
      profiles: [{ ref: 'backup-profile', label: 'Backup' }],
      group: { profileRefs: ['backup-profile'], enrolledProfileRefs: [] },
      policy: { automatic: false },
      application: { capability: 'restart_resume' },
    };
    upsertMutationError = new Error('Could not save profile');
    deleteProfileMutationError = new Error('Could not remove profile');
    enrollmentMutationError = new Error('Could not update enrollment');
    policyMutationError = new Error('Could not update policy');
    importProfileMutationError = new Error('Could not import profile');
    applyMutationError = new Error('Could not apply profile');

    render(
      <AgentConnectionView selectedRuntimeId="claude" onNavigate={vi.fn()} />,
    );

    const errorText = screen
      .getAllByRole('alert')
      .map((alert) => alert.textContent)
      .join(' ');
    for (const message of [
      'Could not save profile',
      'Could not remove profile',
      'Could not update enrollment',
      'Could not update policy',
      'Could not import profile',
      'Could not apply profile',
    ]) {
      expect(errorText).toContain(message);
    }
  });

  test.each([
    [
      { resume: 'same-session', fork: 'replay-seed', rewind: 'none' },
      [
        'Can continue this execution session',
        'Can start a new conversation from Station’s transcript.',
        'Cannot rewind an execution session in place.',
      ],
    ],
    [
      { resume: 'none', fork: 'native', rewind: 'in-place' },
      [
        'Cannot resume an existing execution session.',
        'Can create an engine-native conversation branch.',
        'Can rewind this execution session in place.',
      ],
    ],
    [
      { resume: 'none', fork: 'none', rewind: 'none' },
      [
        'Cannot resume an existing execution session.',
        'Cannot create an engine-native branch.',
        'Cannot rewind an execution session in place.',
      ],
    ],
  ])(
    'renders continuity dimensions as explanatory detail',
    (continuity, expected) => {
      connectionQueryData = {
        id: 'claude',
        kind: 'agent',
        type: 'claude',
        name: 'Claude Code',
        enabled: true,
        status: 'ready',
        capabilities: ['agent-runtime'],
        prerequisites: [],
        config: {},
        setup: { state: 'ready', detected: true, configured: false },
        continuity,
      };
      render(
        <AgentConnectionView selectedRuntimeId="claude" onNavigate={vi.fn()} />,
      );
      const rendered =
        screen.getByText('Continuity').parentElement?.textContent;
      for (const sentence of expected) expect(rendered).toContain(sentence);
      if (continuity.fork === 'replay-seed')
        expect(
          screen.getByText(/engine cursor, tool, or approval state/),
        ).toBeTruthy();
    },
  );
});
