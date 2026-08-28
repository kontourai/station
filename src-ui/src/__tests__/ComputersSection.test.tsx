/**
 * @vitest-environment jsdom
 *
 * Computers — the one list (lane design §4). Replaces the separate
 * KnownEnvironmentsSection/SshEnvironmentsSection suites: those covered two
 * lists that each folded the same SSH profiles, so an SSH computer appeared
 * twice with two different status grammars.
 *
 * The claims worth pinning are the honest ones: a paired connection never
 * reads as evidenced-live, an unauthorized one never claims control, a
 * loopback SSH forward is not offered to a phone, a failed read is an error
 * and not an empty list, and a computer's kind is always stated.
 */

import type { SavedConnection } from '@kontourai/station-connect';
import type { SshEnvironmentView } from '@kontourai/station-sdk';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

interface PeerCredentialSummaryFixture {
  environmentId: string;
  apiBase: string;
  scope: string;
  label: string | null;
  createdAt: number;
  updatedAt: number;
}

const connectionsState: { data: SavedConnection[] } = { data: [] };
const sshState: {
  data: SshEnvironmentView[];
  isLoading: boolean;
  isError: boolean;
} = { data: [], isLoading: false, isError: false };
const peerCredentialsState: {
  isSuccess: boolean;
  data: PeerCredentialSummaryFixture[] | undefined;
} = { isSuccess: false, data: undefined };
let isMobile = false;

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  remove: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock('../hooks/useIsMobile', () => ({ useIsMobile: () => isMobile }));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));
vi.mock('../components/page-frame', () => ({
  PageEyebrowTrail: ({
    segments,
  }: {
    segments: ReadonlyArray<{ label: string }>;
  }) => <span>{segments.map((s) => s.label).join(' / ')}</span>,
  PageFrameActions: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PageHeaderScope: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  usePageHeader: vi.fn(),
}));
vi.mock('../views/connections-hub/AddMachineModal', () => ({
  AddMachineModal: () => null,
}));

vi.mock('@kontourai/station-sdk', () => ({
// The section rail's own reads. They are here because two of these tests
// render the FRAME around this section, which is the only way to compare
// the rail's count against the rows the body actually drew.
  useConnectionsQuery: () => ({ data: [] }),
  useModelConnectionsQuery: () => ({ data: [] }),
  useAgentConnectionsQuery: () => ({ data: [] }),
  useIntegrationsQuery: () => ({ data: [] }),
  useGlobalKnowledgeStatusQuery: () => ({ data: undefined }),
  useSshEnvironmentsQuery: () => ({
    data: sshState.data,
    isLoading: sshState.isLoading,
    isError: sshState.isError,
    refetch: mocks.refetch,
  }),
  usePeerCredentialsQuery: () => ({
    isSuccess: peerCredentialsState.isSuccess,
    data: peerCredentialsState.data,
  }),
  useConnectSshEnvironmentMutation: () => ({
    isPending: false,
    mutateAsync: mocks.connect,
  }),
  useDisconnectSshEnvironmentMutation: () => ({
    isPending: false,
    mutateAsync: mocks.disconnect,
  }),
  useRemoveSshEnvironmentMutation: () => ({
    isPending: false,
    mutateAsync: mocks.remove,
  }),
  sshEnvironmentsToKnownEnvironments: (views: SshEnvironmentView[]) =>
    views.map((view) => ({
      schemaVersion: 1,
      id: `ssh-environment:${view.profile.id}`,
      ...(view.profile.environmentId
        ? { environmentId: view.profile.environmentId }
        : {}),
      label: view.profile.name,
      source: 'ssh',
      endpoints:
        view.state.phase === 'connected'
          ? [
              {
                id: `endpoint:ssh-forward:${view.profile.id}`,
                httpBaseUrl: view.state.localUrl,
                kind: 'ssh-forward',
                preferred: true,
                addedAt: 0,
              },
            ]
          : [],
      createdAt: 0,
      updatedAt: 0,
    })),
}));

vi.mock('@kontourai/station-sdk/developer-runtime', () => ({
  useSystemInstanceQuery: () => ({ data: undefined }),
}));

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({ connections: connectionsState.data }),
}));

function makeConnection(
  overrides: Partial<SavedConnection> = {},
): SavedConnection {
  return {
    profileVersion: 4,
    id: 'conn-1',
    name: 'Box B',
    url: 'https://box-b.tailnet.ts.net',
    endpoints: [
      {
        endpointVersion: 1,
        id: 'endpoint-1',
        url: 'https://box-b.tailnet.ts.net',
        kind: 'tailnet-https',
        priority: 100,
      },
    ],
    selectedEndpointId: 'endpoint-1',
    accessMethods: [
      {
        accessVersion: 1,
        id: 'access-1',
        kind: 'direct-http',
        endpointId: 'endpoint-1',
      },
    ],
    selectedAccessMethodId: 'access-1',
    environmentId: null,
    authProtocolVersion: null,
    credentialRef: { credentialVersion: 1, kind: 'connection', id: 'conn-1' },
    capabilities: null,
    credentialState: 'not-required',
    ...overrides,
  } as SavedConnection;
}

function sshView(
  overrides: Partial<SshEnvironmentView['profile']> = {},
  state: SshEnvironmentView['state'] = { phase: 'idle' },
): SshEnvironmentView {
  return {
    profile: {
      schemaVersion: 1,
      id: 'ssh-env-1',
      name: 'Media Server',
      hostAlias: 'media-server',
      remoteProjectPath: '/home/dev/project',
      remotePort: 3141,
      launchMode: 'attach',
      environmentId: null,
      hostIdentity: null,
      remoteHome: null,
      verifiedProjectPath: null,
      workerProtocolVersion: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastConnectedAt: null,
      ...overrides,
    },
    state,
  } as SshEnvironmentView;
}

import { ConnectionsSectionFrame } from '../views/ConnectionsSectionFrame';
import { ComputersSection } from '../views/connections-hub/ComputersSection';
import {
  knownEnvironmentRegistry,
  resetKnownEnvironmentRegistry,
} from '../views/connections-hub/known-environment-registry';

describe('ComputersSection', () => {
  beforeEach(() => {
    localStorage.clear();
    resetKnownEnvironmentRegistry();
    isMobile = false;
    connectionsState.data = [];
    sshState.data = [];
    sshState.isLoading = false;
    sshState.isError = false;
    peerCredentialsState.isSuccess = false;
    peerCredentialsState.data = undefined;
    mocks.connect.mockReset().mockResolvedValue(undefined);
    mocks.disconnect.mockReset().mockResolvedValue(undefined);
    mocks.remove.mockReset().mockResolvedValue(undefined);
    mocks.refetch.mockReset();
  });

  test('renders the shared skeleton while the list is loading, not a text placeholder (CI-R21)', () => {
    sshState.isLoading = true;
    const { container } = render(<ComputersSection />);
    expect(container.querySelector('.skeleton')).toBeTruthy();
    expect(screen.queryByText(/Loading environments/)).toBeNull();
  });

  test('a failed read is an error with Retry, never an empty list', () => {
    sshState.isError = true;
    render(<ComputersSection />);
    expect(screen.getByText('Computers could not be loaded')).toBeTruthy();
    expect(screen.queryByText('No other computers yet')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mocks.refetch).toHaveBeenCalled();
  });

  test('shows the shared empty state when nothing is known', () => {
    render(<ComputersSection />);
    expect(screen.getByText('No other computers yet')).toBeTruthy();
  });

  test('a paired device names its kind and never reads as evidenced-live', () => {
    connectionsState.data = [makeConnection()];
    render(<ComputersSection />);
    expect(screen.getByText('Box B')).toBeTruthy();
    expect(screen.getByText('Paired device')).toBeTruthy();
    const state = screen.getByText('Authorized');
    expect(state.className).toContain('connections-computers__state--disabled');
    expect(state.className).not.toContain(
      'connections-computers__state--ready',
    );
    expect(
      screen.getByText(
        'You reach it from this device — you can control it directly.',
      ),
    ).toBeTruthy();
  });

  test('a saved-but-unauthorized paired connection is not claimed as controllable', () => {
    connectionsState.data = [makeConnection({ credentialState: 'required' })];
    render(<ComputersSection />);
    expect(screen.getByText('Not authorized')).toBeTruthy();
    expect(
      screen.getByText(
        'Saved on this device — authorize it to control it directly.',
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        'You reach it from this device — you can control it directly.',
      ),
    ).toBeNull();
  });

  test('an SSH computer states the server phase, its host and folder, and offers one action', () => {
    sshState.data = [sshView()];
    render(<ComputersSection />);
    expect(screen.getByText('Media Server')).toBeTruthy();
    expect(screen.getByText('SSH')).toBeTruthy();
    expect(screen.getByText('media-server · /home/dev/project')).toBeTruthy();
    expect(screen.getByText('Not connected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(mocks.connect).toHaveBeenCalledWith('ssh-env-1');
  });

  test('a connected SSH computer offers Stop and says what it unlocks', () => {
    sshState.data = [
      sshView(
        { lastConnectedAt: '2026-01-01T00:05:00.000Z' },
        {
          phase: 'connected',
          localUrl: 'http://127.0.0.1:41200',
          instanceId: 'i',
          sha: 's',
          bootId: 'b',
          connectedAt: '2026-01-01T00:05:00.000Z',
        },
      ),
    ];
    render(<ComputersSection />);
    expect(screen.getByText('Ready')).toBeTruthy();
    expect(
      screen.getByText(
        'This Station can run delegated tasks here — work runs on Media Server, with its own agents and workspace.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(mocks.disconnect).toHaveBeenCalledWith('ssh-env-1');
  });

  test('an SSH failure phase renders the server action string, not a bare state word (CI-R14)', () => {
    sshState.data = [
      sshView(
        {},
        {
          phase: 'error',
          reason: 'station-unavailable',
          action:
            'Connection refused on port 22 — is sshd running on media-server?',
        },
      ),
    ];
    render(<ComputersSection />);
    expect(screen.getByText('Action needed')).toBeTruthy();
    expect(
      screen.getByText(
        'Connection refused on port 22 — is sshd running on media-server?',
      ),
    ).toBeTruthy();
  });

  test('an SSH computer can be removed — a creator without a remover is a dead end', async () => {
    sshState.data = [sshView()];
    render(<ComputersSection />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove this computer' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('ssh-env-1'));
  });

  test('does not expose this Station loopback SSH tunnel as a mobile endpoint', () => {
    isMobile = true;
    sshState.data = [
      sshView(
        { id: 'ssh-env-mobile' },
        {
          phase: 'connected',
          localUrl: 'http://127.0.0.1:41200',
          instanceId: 'i',
          sha: 's',
          bootId: 'b',
          connectedAt: '2026-01-01T00:05:00.000Z',
        },
      ),
    ];
    connectionsState.data = [];
    render(<ComputersSection />);
    expect(screen.getByText('Media Server')).toBeTruthy();
    expect(screen.queryByText(/127\.0\.0\.1:41200/)).toBeNull();
  });

  test('folds a paired connection and an SSH profile sharing an environmentId into one row', () => {
    connectionsState.data = [
      makeConnection({ environmentId: 'environment-box-b' }),
    ];
    sshState.data = [
      sshView({ id: 'ssh-env-1', environmentId: 'environment-box-b' }),
    ];
    render(<ComputersSection />);
    const rows = document.querySelectorAll('.connections-computers__row');
    expect(rows).toHaveLength(1);
  });

  test('a manual Station entry states its kind and can be removed', () => {
    localStorage.setItem(
      'station-known-environments',
      JSON.stringify([
        {
          schemaVersion: 1,
          id: 'manual-1',
          label: 'Manual host',
          source: 'manual',
          endpoints: [],
          createdAt: 0,
          updatedAt: 0,
        },
      ]),
    );
    resetKnownEnvironmentRegistry();
    render(<ComputersSection />);
    expect(screen.getByText('Manual host')).toBeTruthy();
    expect(screen.getByText('Station')).toBeTruthy();
    expect(screen.getByText('Not verified')).toBeTruthy();
    expect(
      screen.getByText('Not yet verified — no confirmed way to reach it yet.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
  });

//This section constructed its OWN
// `KnownEnvironmentRegistry`, so it subscribed to listeners nobody else
// notified: the add dialog wrote to the same localStorage through a
// different instance and this list did not hear about it. The code comment
// in `known-environment-registry.ts` described the failure exactly; the
// section was the one place that had not adopted the singleton.
  test('a Station added through the shared registry appears without a remount', async () => {
    render(<ComputersSection />);
    expect(screen.getByText('No other computers yet')).toBeTruthy();

// The dialog's own write path — the same singleton, not a second instance.
    act(() => {
      knownEnvironmentRegistry().add({
        label: 'Box B',
        source: 'manual',
        httpBaseUrl: 'http://box-b.local:3141',
        kind: 'direct',
      });
    });

// No re-render, no remount: the subscription is what has to deliver this.
    await waitFor(() => expect(screen.getByText('Box B')).toBeTruthy());
    expect(
      document.querySelectorAll('.connections-computers__row'),
    ).toHaveLength(1);
  });

// The rail's count used to be `savedStations.length + sshComputers.length`,
// which is wrong in BOTH directions against the list it labels: it missed
// every manual entry, and counted a paired device and its SSH profile
// twice where the body folds them into one row. Both cases are present
// here, so a count that is merely "close" still fails.
  test('the rail count is the number of rows the body renders', async () => {
    connectionsState.data = [
      makeConnection({ environmentId: 'environment-box-b' }),
    ];
    sshState.data = [
      sshView({ id: 'ssh-env-1', environmentId: 'environment-box-b' }),
      sshView({ id: 'ssh-env-2' }),
    ];
    localStorage.setItem(
      'station-known-environments',
      JSON.stringify([
        {
          schemaVersion: 1,
          id: 'manual-1',
          label: 'Manual host',
          source: 'manual',
          endpoints: [],
          createdAt: 0,
          updatedAt: 0,
        },
      ]),
    );
    resetKnownEnvironmentRegistry();

    render(
      <ConnectionsSectionFrame sectionId="computers">
        <ComputersSection />
      </ConnectionsSectionFrame>,
    );

    const renderedRows = document.querySelectorAll(
      '.connections-computers__row',
    ).length;
// 1 manual + 1 folded (paired + its SSH profile) + 1 standalone SSH.
    expect(renderedRows).toBe(3);
    const computersTab = screen
      .getAllByRole('tab')
      .find((element) => element.textContent?.startsWith('Computers'))!;
    expect(computersTab.textContent).toContain(String(renderedRows));
  });

  test('unconfigured peer credentials render as one row with a copy-command action (CI-R13)', () => {
    peerCredentialsState.isSuccess = true;
    peerCredentialsState.data = [];
    render(<ComputersSection />);
    expect(screen.getByText('Outbound peer credentials')).toBeTruthy();
    expect(screen.getByText(/station environment peers add/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeTruthy();
  });

  test('configured peer credentials render in the same row shape as everything else', () => {
    peerCredentialsState.isSuccess = true;
    peerCredentialsState.data = [
      {
        environmentId: 'unlabeled-env',
        apiBase: 'https://unlabeled.tailnet.ts.net',
        scope: 'orchestration:read',
        label: null,
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    render(<ComputersSection />);
    expect(screen.getByText('unlabeled-env')).toBeTruthy();
    expect(
      screen.getByText('https://unlabeled.tailnet.ts.net · orchestration:read'),
    ).toBeTruthy();
  });

  test('renders nothing for peer credentials while the fetch has not succeeded', () => {
    render(<ComputersSection />);
    expect(screen.queryByText('Outbound peer credentials')).toBeNull();
  });
});
