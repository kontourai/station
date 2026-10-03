/**
 * @vitest-environment jsdom
 */

import type { AuthorityObservation } from '@kontourai/station-sdk/authority-observation';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render as renderView,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { hostActionCopy } from '../components/host-action/host-action-copy';

const operatorScope = {
  apiBase: 'https://operator.example.test',
  authorityKey: 'view-operator',
  isCurrent: () => true,
};
const operatorAuthority: AuthorityObservation = {
  schemaVersion: 'station.authority-observation/v1',
  environmentId: 'view-host',
  principal: { kind: 'human', id: 'human:local:operator' },
  grant: { kind: 'operator' },
};
vi.mock('../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => operatorScope,
}));
let queryClient: QueryClient;
async function render(view: ReactElement) {
  const mounted = renderView(view, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  return mounted;
}
afterEach(() => {
  queryClient.clear();
  setClientCredentialResolver(undefined);
});

const save = vi.fn();
const clearMutate = vi.fn();
const applyMutate = vi.fn();
const enrollmentMutate = vi.fn();
const policyMutate = vi.fn();
const upsertMutate = vi.fn();
const deleteProfileMutate = vi.fn();
const resetMutate = vi.fn();
const importProfileMutate = vi.fn();
let saveFailure: Error | null = null;
const checkConnection = vi.fn();
let modelConnections: unknown[] = [];
/**
 * The device projection this page reads. `undefined` is the honest default --
 * it is what a server that has not answered yet returns, and `HostAction`
 * takes its host branch there, claiming nothing about a second machine. Each
 * test that cares sets it.
 */
let devicePresentation:
  | { deviceClass: 'host' | 'paired'; hostName: string }
  | undefined;
vi.mock('../hooks/useDevicePresentation', () => ({
  useDevicePresentation: () => devicePresentation,
}));

/**
 * What `buildCliRuntimePrerequisites` ACTUALLY writes when the binary is
 * absent: TWO required prerequisites, the second named `<Engine> login` --
 * whose own description says the CLI must be installed BEFORE authentication
 * can be verified.
 *
 * Hand-written single-prerequisite fixtures are what let the missing-binary
 * case ship untested: no producer emits that shape, so the assertion could
 * not reach the branch it named.
 */
function museMissingBinaryConnection() {
  return {
    id: 'muse',
    kind: 'agent',
    type: 'muse',
    name: 'Muse Code',
    enabled: true,
    status: 'missing_prerequisites',
    capabilities: ['agent-runtime'],
    config: { executionClass: 'connected', providerLabel: 'Muse' },
    prerequisites: [
      {
        id: 'muse-cli',
        name: 'Muse Code CLI',
        description: 'Required to launch the Muse Code runtime.',
        status: 'missing',
        category: 'required',
        installGuide: {
          steps: ['Install the Muse Code CLI and ensure `muse` is on PATH.'],
        },
      },
      {
        id: 'muse-auth',
        name: 'Muse Code login',
        description:
          'Muse Code CLI must be installed before authentication can be verified.',
        status: 'missing',
        category: 'required',
        installGuide: {
          steps: [
            'Install the Muse Code CLI and ensure `muse` is on PATH.',
            'Run `muse auth set --api-key-stdin` before starting Station.',
          ],
        },
      },
    ],
    setup: { state: 'available', detected: false, configured: false },
  };
}
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
    id: 'station',
    kind: 'agent',
    type: 'station-agent',
    name: 'Station engine',
    enabled: true,
    status: 'ready',
    capabilities: ['agent-runtime'],
    prerequisites: [],
    config: { engineId: 'station' },
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
/**
 * The ACP bridge's live connection set — the projection that gates (and the
 * reconnect route 404s against) the detail header's Reconnect action. Empty
 * by default so non-ACP fixtures keep rendering without it.
 */
let acpBridgeConnections: unknown[] = [];
const reconnectMutate = vi.fn();
let reconnectMutationError: Error | null = null;

vi.mock('@kontourai/station-sdk', () => ({
  useSkillsQuery: () => ({
    data: [
      { name: 'pizza-skill', description: 'Bakes a pizza' },
      { name: 'salad-skill', description: 'Tosses a salad' },
    ],
  }),
  useEngineConnectionsQuery: () => ({
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
    mutate: resetMutate,
    isPending: false,
  }),
  useTestAgentConnectionMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useSmokeAgentConnectionMutation: () => ({
    mutate: checkConnection,
    isPending: false,
  }),
  useModelConnectionsQuery: () => ({ data: modelConnections }),
  useReconnectACPConnectionMutation: (options: {
    onError?: (error: Error) => void;
  }) => ({
    mutate: (id: string) => {
      reconnectMutate(id);
      if (reconnectMutationError) options.onError?.(reconnectMutationError);
    },
    isPending: false,
  }),
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

vi.mock('../contexts/NavigationContext', () => {
  // NavigationContext publishes two read hooks: `useNavigation` (subscribes to
  // the store, optionally through a selector) and `useNavigationActions` (the
  // memoized actions, no subscription). This mock answers both from one value.
  const navigation = () => ({ navigate: vi.fn() });
  return {
    useNavigation: (
      selector?: (state: ReturnType<typeof navigation>) => unknown,
    ) => (selector ? selector(navigation()) : navigation()),
    useNavigationActions: navigation,
  };
});

vi.mock('../hooks/useACPConnections', () => ({
  useACPConnections: () => ({ data: acpBridgeConnections }),
  useACPConnectionRegistry: () => ({ data: acpRegistryEntries }),
}));

import { AgentConnectionView } from '../views/AgentConnectionView';

describe('AgentConnectionView', () => {
  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    setClientCredentialResolver(() => ({
      origin: operatorScope.apiBase,
      requestAuthority: operatorScope,
      transport: async (url) => {
        const path = new URL(String(url)).pathname;
        const reply = (data: unknown) =>
          new Response(JSON.stringify(data), {
            headers: { 'Content-Type': 'application/json' },
          });
        if (path.endsWith('/accounts'))
          return reply({
            success: true,
            data: {
              engine: path.includes('claude') ? 'claude' : 'codex',
              accounts: [],
              activeProfileRef: null,
            },
          });
        if (path.endsWith('/usage-rollup'))
          return reply({
            success: true,
            data: {
              window: { from: '2026-09-25', to: '2026-10-01' },
              rows: [],
              receipts: [],
              coverage: [],
            },
          });
        if (path.endsWith('/account-login'))
          return reply({ success: true, data: { login: null } });
        if (new URL(String(url)).pathname !== '/api/auth/authority')
          throw new Error('Unexpected authority fixture request');
        return new Response(JSON.stringify(operatorAuthority), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
    }));
    devicePresentation = undefined;
    resetMutate.mockClear();
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
    acpBridgeConnections = [];
    reconnectMutate.mockReset();
    reconnectMutationError = null;
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
  test('an engine the list drops as not-yet-added is still offered in Add', async () => {
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

    const { rerender } = await render(
      <AgentConnectionView onNavigate={vi.fn()} />,
    );
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

  test('the already-listed claim is reserved for a catalogue nothing is missing from', async () => {
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

    await render(
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
  test('the empty-state claim requires both populations exhausted, not just the native one', async () => {
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

    await render(
      <AgentConnectionView selectedRuntimeId="new" onNavigate={vi.fn()} />,
    );

    expect(
      screen.queryByText('Every supported engine is already listed'),
    ).toBeNull();
    expect(screen.getByText('Kiro CLI')).toBeTruthy();
  });

  test('titles the engines route Engines, not Providers', async () => {
    await render(<AgentConnectionView onNavigate={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'Engines' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Providers' })).toBeNull();
    // The breadcrumb reads CONNECTIONS / ENGINES too; nothing on this route
    // says "Providers" any more.
    expect(screen.queryAllByText('Providers')).toHaveLength(0);
    expect(screen.getAllByText('Engines').length).toBeGreaterThan(1);
  });

  // archive#771 regression: `useEngineConnectionsQuery`'s isLoading was
  // consulted by `SplitPaneLayout`'s `loading` prop but its error was never
  // passed through, so a settled read failure rendered the same "no engines"
  // empty state as a host with none configured — no error, no retry.
  test('renders the engines list error state with retry when the connections query fails', async () => {
    agentConnections = [];
    agentConnectionsQueryError = new Error('engines unavailable');

    await render(<AgentConnectionView onNavigate={vi.fn()} />);

    expect(screen.getByText('engines unavailable')).toBeTruthy();
    expect(screen.queryByText('Codex')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetchAgentConnections).toHaveBeenCalledTimes(1);
  });

  // The section frame owns this section's single add action and reaches the
  // catalogue by route (`/connections/engines/new`), not by an in-view button
  // so the route is what these two drive now.
  test('keeps available apps in Add and shows the Station engine returned by the API', async () => {
    const { rerender } = await render(
      <AgentConnectionView onNavigate={vi.fn()} />,
    );

    expect(screen.getByText('Codex')).toBeTruthy();
    expect(screen.queryByText('Claude Code')).toBeNull();
    expect(screen.getByText('Station engine')).toBeTruthy();

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
    expect(screen.getByText('Station engine')).toBeTruthy();

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
  test('a catalog row that already reads ready is not offered as an Add choice', async () => {
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

    await render(
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
  test('the merged catalogue offers both populations and routes an ACP choice into its setup route', async () => {
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

    await render(
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
      type: 'connections-engine-new',
      providerId: 'kiro',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Set up OpenCode' }));
    expect(onNavigate).toHaveBeenCalledWith({
      type: 'connections-engine-new',
      providerId: 'opencode',
    });
  });

  test('the merged catalogue routes the trailing custom entry into the ACP custom setup route', async () => {
    const onNavigate = vi.fn();

    await render(
      <AgentConnectionView selectedRuntimeId="new" onNavigate={onNavigate} />,
    );

    expect(screen.getByText('Custom engine')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Set up custom engine' }),
    );
    expect(onNavigate).toHaveBeenCalledWith({
      type: 'connections-engine-new',
      providerId: 'custom',
    });
  });

  test('reports Add catalog save failures in place', async () => {
    saveFailure = new Error('Could not add Claude Code');
    await render(
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
      'Sign in to Codex.',
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
      'Claude executable required on PATH.',
    ],
  ] as const)(
    'projects the backend %s setup tuple into the provider detail',
    async (state, configured, status, prerequisites, readiness, detail) => {
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

      await render(
        <AgentConnectionView selectedRuntimeId="claude" onNavigate={vi.fn()} />,
      );

      expect(screen.getAllByText(readiness)).not.toHaveLength(0);
      if (detail) {
        expect(screen.getAllByText(detail)).not.toHaveLength(0);
      }
    },
  );

  /*
   * The shape `buildCliRuntimePrerequisites` ACTUALLY emits when the binary is
   * absent, byte for byte: TWO required prerequisites, the second of them
   * named `<Engine> login`.
   *
   * The table above only ever fed the one-prerequisite shape, which no
   * producer writes for this state -- so the missing-binary case was never
   * exercised, and the page shipped telling a user whose engine was not
   * installed to sign in. The negative assertion is the point of the test: a
   * remedy the user cannot perform must not be named, and it must not crowd
   * out the one they can.
   */
  test('a missing engine binary reports setup, never sign-in, even though the server also reports an unmet login prerequisite', async () => {
    connectionQueryData = museMissingBinaryConnection();
    await render(
      <AgentConnectionView selectedRuntimeId="muse" onNavigate={vi.fn()} />,
    );

    expect(screen.getAllByText('Setup required')).not.toHaveLength(0);
    expect(
      screen.getAllByText('Required to launch the Muse Code runtime.'),
    ).not.toHaveLength(0);
    expect(screen.queryByText('Sign in required')).toBeNull();
    expect(screen.queryByText('Sign in to finish connecting.')).toBeNull();
  });

  /*
   * The page is a REMOTE ADMINISTRATION surface: every prerequisite on it is a
   * fact about the machine Station runs on, while the person reading may be
   * holding a phone. Before this, nothing here named that machine -- so a
   * correct observation ("Muse is not installed on desktop-win") was read as a
   * broken screen, and the remedy was a POSIX shell command for a Windows box
   * the reader was not sitting at.
   *
   * Compared against `hostActionCopy` rather than a transcribed sentence: the
   * map is the single source, so this asserts ADOPTION. Re-wording the map
   * must not fail this test; failing to go through the map must.
   */
  test('a paired device is told which machine the engine is missing from', async () => {
    devicePresentation = { deviceClass: 'paired', hostName: 'desktop-win' };
    connectionQueryData = museMissingBinaryConnection();

    await render(
      <AgentConnectionView selectedRuntimeId="muse" onNavigate={vi.fn()} />,
    );

    const expected = hostActionCopy('engine-missing', devicePresentation);
    expect(expected).toContain('desktop-win');
    expect(screen.getAllByText(expected)).not.toHaveLength(0);
  });

  test('on the host the same state names no second machine', async () => {
    devicePresentation = { deviceClass: 'host', hostName: 'desktop-win' };
    connectionQueryData = museMissingBinaryConnection();

    await render(
      <AgentConnectionView selectedRuntimeId="muse" onNavigate={vi.fn()} />,
    );

    // Branch 1: there is no second machine to name, so the page must not
    // start talking about one.
    expect(screen.queryByText(/desktop-win/)).toBeNull();
    expect(screen.getAllByText('Setup required')).not.toHaveLength(0);
  });

  /*
   * The rail used to be three static spans with the first hardcoded complete,
   * so it rendered identically for a working engine and a broken one. These
   * two cases differ ONLY in the engine's state, so they fail if the rail goes
   * back to being decoration.
   */
  test('the setup rail stops at Connect while a prerequisite blocks the engine', async () => {
    connectionQueryData = museMissingBinaryConnection();

    const { container } = await render(
      <AgentConnectionView selectedRuntimeId="muse" onNavigate={vi.fn()} />,
    );

    const steps = [
      ...container.querySelectorAll('.provider-detail__progress-step'),
    ];
    expect(steps.map((step) => step.textContent)).toEqual([
      'Choose',
      'Connect',
      'Ready',
    ]);
    const complete = steps.map((step) =>
      step.classList.contains('provider-detail__progress-step--complete'),
    );
    expect(complete).toEqual([true, false, false]);
    // Exactly one step is announced as current, and it is the first incomplete.
    const current = steps.filter(
      (step) => step.getAttribute('aria-current') === 'step',
    );
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toBe('Connect');
  });

  test('a ready engine completes every step and announces none as current', async () => {
    connectionQueryData = {
      ...museMissingBinaryConnection(),
      status: 'ready',
      prerequisites: [
        {
          id: 'muse-cli',
          name: 'Muse Code CLI',
          description: 'Required to launch the Muse Code runtime.',
          status: 'installed',
          category: 'required',
        },
      ],
      setup: { state: 'ready', detected: true, configured: true },
    };

    const { container } = await render(
      <AgentConnectionView selectedRuntimeId="muse" onNavigate={vi.fn()} />,
    );

    const steps = [
      ...container.querySelectorAll('.provider-detail__progress-step'),
    ];
    expect(
      steps.map((step) =>
        step.classList.contains('provider-detail__progress-step--complete'),
      ),
    ).toEqual([true, true, true]);
    expect(
      steps.filter((step) => step.getAttribute('aria-current') === 'step'),
    ).toHaveLength(0);
  });

  // The refusal sentence (enriched-agents.ts) names the setup page as the
  // first path to the handshake retry — so the setup page has to actually
  // carry the action. The bridge's live connection set is the gate: it is
  // the same projection the reconnect route 404s against.
  test('an ACP-managed engine offers the handshake reconnect in place', async () => {
    acpBridgeConnections = [{ id: 'opencode', name: 'OpenCode' }];
    connectionQueryData = {
      id: 'opencode',
      kind: 'agent',
      type: 'acp',
      name: 'OpenCode',
      enabled: true,
      status: 'degraded',
      capabilities: ['agent-runtime'],
      prerequisites: [],
      config: {},
      setup: { state: 'ready', detected: true, configured: true },
    };

    await render(
      <AgentConnectionView selectedRuntimeId="opencode" onNavigate={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(reconnectMutate).toHaveBeenCalledWith('opencode');
  });

  test('an engine the ACP bridge does not manage offers no reconnect', async () => {
    connectionQueryData = {
      id: 'codex',
      kind: 'agent',
      type: 'codex',
      name: 'Codex',
      enabled: true,
      status: 'ready',
      capabilities: ['agent-runtime'],
      prerequisites: [],
      config: { executionClass: 'connected', providerLabel: 'Codex' },
      setup: { state: 'ready', detected: true, configured: false },
    };

    await render(
      <AgentConnectionView selectedRuntimeId="codex" onNavigate={vi.fn()} />,
    );

    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
  });

  test('a refused reconnect reports the engine observation in place', async () => {
    acpBridgeConnections = [{ id: 'opencode', name: 'OpenCode' }];
    reconnectMutationError = new Error(
      'The ACP connection could not be reconnected. Engine exited before handshake',
    );
    connectionQueryData = {
      id: 'opencode',
      kind: 'agent',
      type: 'acp',
      name: 'OpenCode',
      enabled: true,
      status: 'degraded',
      capabilities: ['agent-runtime'],
      prerequisites: [],
      config: {},
      setup: { state: 'ready', detected: true, configured: true },
    };

    await render(
      <AgentConnectionView selectedRuntimeId="opencode" onNavigate={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(screen.getByText(/Engine exited before handshake/)).toBeTruthy();
  });

  /*
   * "Reset to defaults" is a DELETE that also unregisters the engine. It ran on
   * a single tap with no confirmation, while the less destructive "Clear this
   * app home" five fields away confirmed.
   */
  test('resetting an engine asks before it deletes', async () => {
    connectionQueryData = museMissingBinaryConnection();

    await render(
      <AgentConnectionView selectedRuntimeId="muse" onNavigate={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    expect(resetMutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(resetMutate).toHaveBeenCalledTimes(1);
  });

  /*
   * A refetch overwrote the form unconditionally, so pressing the re-check
   * button -- or any background invalidation -- silently discarded whatever the
   * user had typed. Re-rendering with a NEW query object is exactly what the
   * effect keyed on.
   */
  test('a refetch of the same engine does not discard an unsaved edit', async () => {
    connectionQueryData = museMissingBinaryConnection();

    const { rerender } = await render(
      <AgentConnectionView selectedRuntimeId="muse" onNavigate={vi.fn()} />,
    );

    fireEvent.click(screen.getByText('Advanced'));
    const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'My Muse' } });
    expect(nameInput.value).toBe('My Muse');

    // A fresh object from the server, same connection: what an invalidation
    // produces.
    connectionQueryData = museMissingBinaryConnection();
    rerender(
      <AgentConnectionView selectedRuntimeId="muse" onNavigate={vi.fn()} />,
    );

    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(
      'My Muse',
    );
  });

  test('selecting another engine while dirty asks before navigating', async () => {
    const muse = {
      ...museMissingBinaryConnection(),
      setup: { state: 'ready', detected: true, configured: true },
    };
    agentConnections = [...DEFAULT_AGENT_CONNECTIONS, muse];
    connectionQueryData = muse;
    const onNavigate = vi.fn();

    await render(
      <AgentConnectionView selectedRuntimeId="muse" onNavigate={onNavigate} />,
    );

    fireEvent.click(screen.getByText('Advanced'));
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'My Muse' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Codex/ }));

    expect(screen.getByText('Unsaved Changes')).toBeTruthy();
    expect(onNavigate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onNavigate).toHaveBeenCalledWith({
      type: 'connections-engine-edit',
      id: 'codex',
    });
  });

  test('selecting a different engine re-seeds the form even after an edit', async () => {
    connectionQueryData = museMissingBinaryConnection();

    const { rerender } = await render(
      <AgentConnectionView selectedRuntimeId="muse" onNavigate={vi.fn()} />,
    );

    fireEvent.click(screen.getByText('Advanced'));
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'My Muse' },
    });

    connectionQueryData = {
      ...museMissingBinaryConnection(),
      id: 'codex',
      name: 'Codex',
    };
    rerender(
      <AgentConnectionView selectedRuntimeId="codex" onNavigate={vi.fn()} />,
    );

    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(
      'Codex',
    );
  });

  test('claude shows an accessible skills-materialization multiselect, off by default, that saves the selected ids', async () => {
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

    await render(
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

  // archive#896: codex joins claude in the app-home opt-in.
  test.each([
    {
      id: 'claude',
      name: 'Claude Code',
      description: 'Claude Code integration.',
      config: { providerLabel: 'Claude', provideSkills: [] },
    },
    {
      id: 'codex',
      name: 'Codex',
      description: 'Codex app-server engine.',
      config: { providerLabel: 'Codex' },
    },
  ])(
    '$id shows the app-home opt-in, off by default, that saves the toggle',
    async ({ id, name, description, config }) => {
      connectionQueryData = {
        id,
        kind: 'agent',
        type: id,
        name,
        enabled: true,
        status: 'ready',
        description,
        capabilities: ['agent-runtime'],
        prerequisites: [],
        config: { executionClass: 'connected', ...config, useAppHome: false },
        setup: { state: 'ready', detected: true, configured: false },
      };
      const importName = `Import a snapshot of your global ${name} settings`;

      await render(
        <AgentConnectionView selectedRuntimeId={id} onNavigate={vi.fn()} />,
      );

      fireEvent.click(screen.getByText('Advanced'));
      const appHomeCheckbox = screen.getByRole('checkbox', {
        name: /Run sessions in a Station-managed app home/,
      });
      expect((appHomeCheckbox as HTMLInputElement).checked).toBe(false);
      // Import stays hidden until the toggle is on — never a silent action.
      expect(screen.queryByRole('button', { name: importName })).toBeNull();

      fireEvent.click(appHomeCheckbox);
      expect(screen.getByRole('button', { name: importName })).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(save).toHaveBeenCalledWith({
        connection: expect.objectContaining({
          id,
          config: expect.objectContaining({ useAppHome: true }),
        }),
        isNew: false,
      });
    },
  );

  // archive#896: bounded profile GC — usage report + explicit clear.
  test('the app home clear action confirms before calling the clear mutation', async () => {
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

    await render(
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

  test('credential recovery is manual-first, safely exposes credential entry labels, and requires explicit enrollment', async () => {
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

    await render(
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

  test('treats a legacy credential-recovery response as empty and fail-closed instead of crashing the route', async () => {
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

    await render(
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
  test('renders an error state with retry when the credential-recovery query fails', async () => {
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

    await render(
      <AgentConnectionView selectedRuntimeId="codex" onNavigate={vi.fn()} />,
    );

    expect(screen.getByText("Couldn't load credential entries")).toBeTruthy();
    expect(screen.getByText('credential recovery unavailable')).toBeTruthy();
    expect(screen.queryByText('No credential entries added yet.')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetchCredentialRecovery).toHaveBeenCalledTimes(1);
  });

  // One gate: recovery is unsupported unless group, policy, and application
  // state are all present AND the capability is restart_resume. The enabled
  // path is 'manual apply explains its billable verification…' below.
  test.each([
    {
      state: 'application capability is missing',
      recovery: {
        profiles: [{ ref: 'backup-profile' }],
        group: { profileRefs: ['backup-profile'], enrolledProfileRefs: [] },
        policy: { automatic: false },
      },
    },
    {
      state: 'group and policy state are missing',
      recovery: {
        profiles: [{ ref: 'backup-profile' }],
        application: { capability: 'restart_resume' },
      },
    },
    {
      state: 'the capability is unsupported',
      recovery: {
        profiles: [{ ref: 'backup-profile' }],
        group: { profileRefs: ['backup-profile'], enrolledProfileRefs: [] },
        policy: { automatic: false },
        application: { capability: 'unsupported' },
      },
      explains: true,
    },
  ])(
    'keeps automatic recovery and manual apply disabled when $state',
    async ({ recovery, explains }) => {
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
      credentialRecoveryQueryData = recovery;

      await render(
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
      if (explains) {
        expect(
          screen.getByText(/does not declare a safe application capability/),
        ).toBeTruthy();
      }
    },
  );

  test('manual apply explains its billable verification and only runs after confirmation', async () => {
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

    await render(
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

  test('a rolled-back outcome is announced as failure rather than success', async () => {
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

    await render(
      <AgentConnectionView selectedRuntimeId="claude" onNavigate={vi.fn()} />,
    );

    expect(screen.getByRole('alert').textContent).toContain(
      'Credential application was rolled back; the active credential was not changed.',
    );
  });

  test('shows errors from every credential-profile mutation in one accessible error surface', async () => {
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

    await render(
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
    async (continuity, expected) => {
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
      await render(
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

test('guided proxy setup saves a reference and checks only saved settings', async () => {
  modelConnections = [
    {
      id: 'proxy-home',
      kind: 'model',
      type: 'openai-compat',
      name: 'brian-media',
      enabled: true,
      config: { apiKeyConfigured: true },
      capabilities: ['llm'],
      status: 'ready',
      prerequisites: [],
    },
  ];
  connectionQueryData = {
    id: 'codex',
    kind: 'agent',
    type: 'codex',
    name: 'Codex',
    enabled: true,
    capabilities: ['agent-runtime'],
    status: 'ready',
    prerequisites: [],
    config: { defaultModel: 'gpt-6.1-sol' },
    runtimeCatalog: {
      source: 'live',
      models: [
        { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', originalId: 'gpt-6.1-sol' },
      ],
    },
  };
  await render(
    <AgentConnectionView selectedRuntimeId="codex" onNavigate={vi.fn()} />,
  );
  expect(screen.getByRole('combobox', { name: 'Default model' })).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox', { name: 'Connect through' }), {
    target: { value: 'proxy-home' },
  });
  expect(
    (
      screen.getByRole('button', {
        name: 'Check connection',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      connection: expect.objectContaining({
        config: expect.objectContaining({ proxyConnectionId: 'proxy-home' }),
      }),
    }),
  );
  const stored = save.mock.calls.at(-1)?.[0];
  expect(stored.connection.config).not.toHaveProperty('apiKey');
  expect(stored.connection.config).not.toHaveProperty('env');
  modelConnections = [];
});
