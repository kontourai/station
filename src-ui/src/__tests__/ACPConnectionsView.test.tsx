/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const acpRegistryState = vi.hoisted(() => ({
  data: [] as Array<Record<string, unknown>>,
}));
const acpConnectionsState = vi.hoisted(() => ({
  data: [] as Array<Record<string, unknown>>,
  error: null as Error | null,
  isError: false,
  isFetching: false,
  refetch: vi.fn(),
}));
const detailModalProps = vi.hoisted(() => ({
  current: null as { onUpdateToolServers?: unknown } | null,
}));
const installRegistryEntry = vi.hoisted(() => vi.fn());

vi.mock('@kontourai/station-sdk', () => ({
  useACPConnectionsQuery: () => acpConnectionsState,
  useACPConnectionRegistryQuery: () => ({ data: acpRegistryState.data }),
  useCreateACPConnectionMutation: () => ({ mutateAsync: vi.fn() }),
  useInstallACPConnectionRegistryEntryMutation: () => ({
    mutateAsync: installRegistryEntry,
  }),
  useUpdateACPConnectionMutation: () => ({ mutateAsync: vi.fn() }),
  useDeleteACPConnectionMutation: () => ({ mutateAsync: vi.fn() }),
  useReconnectACPConnectionMutation: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock('../components/acp-connections/ACPConnectionDetailModal', () => ({
  ACPConnectionDetailModal: (props: { onUpdateToolServers?: unknown }) => {
    detailModalProps.current = props;
    return <div data-testid="connection-detail-modal" />;
  },
}));

import { PageFrame } from '../components/page-frame';
import { ACPConnectionsView } from '../views/ACPConnectionsView';

describe('ACPConnectionsView', () => {
  beforeEach(() => {
    acpRegistryState.data = [];
    acpConnectionsState.data = [];
    acpConnectionsState.error = null;
    acpConnectionsState.isError = false;
    acpConnectionsState.isFetching = false;
    acpConnectionsState.refetch.mockReset();
    acpConnectionsState.refetch.mockResolvedValue(undefined);
    detailModalProps.current = null;
    installRegistryEntry.mockReset();
    installRegistryEntry.mockResolvedValue(undefined);
  });

  it('renders canonical Empty copy for the ACP empty state', () => {
    render(<ACPConnectionsView agents={[]} />);

    expect(screen.getByText('Add an engine to get started')).toBeTruthy();
    expect(
      screen.getByText('Choose a detected engine or connect a custom one.'),
    ).toBeTruthy();
  });

  it('publishes an unlinked Connections eyebrow (parent-context text only) into the page frame', () => {
    render(
      <PageFrame
        routeIdentity="connections-acp-new"
        spec={{
          title: 'Provider setup',
          subtitle: 'Connect providers that run as local apps or commands.',
          width: 'narrow',
        }}
      >
        <ACPConnectionsView agents={[]} />
      </PageFrame>,
    );

    const header = document.querySelector('.page-frame__header');
    expect(header?.textContent).toContain('Connections');
    // The title, not the eyebrow, says 'Provider setup' — archive#4463 slice
    // 1 retired the breadcrumb-as-eyebrow that restated it a second time.
    expect(document.querySelector('.page__label')?.textContent?.trim()).toBe(
      'Connections',
    );
    expect(document.querySelector('.page__title')?.textContent).toBe(
      'Provider setup',
    );
    expect(
      screen.getByText('Connect providers that run as local apps or commands.'),
    ).toBeTruthy();
    expect(screen.queryByText(/\bACP\b/i)).toBeNull();

    // Fix round (arbiter decision #4): `/connections` is a redirect-only
    // resolver, so a click on its eyebrow would be a no-op or a sibling jump
    // dressed up as "go up" — worse than no affordance. Plain text, not a
    // link: no `.page__label-link`, and clicking the word does nothing.
    expect(document.querySelector('.page__label-link')).toBeNull();
    // Clicking the word is inert: the component takes no navigation callback
    // at all since the, so there is nothing a click could reach.
    fireEvent.click(screen.getByText('Connections'));
  });

  it('renders no page header of its own', () => {
    const { container } = render(<ACPConnectionsView agents={[]} />);

    expect(container.querySelector('.page__header')).toBeNull();
    expect(container.querySelector('h1')).toBeNull();
  });

  // #592 slice 2: this section no longer owns an "Add engine" trigger — the
  // merged catalogue on the Engines tab (`AgentConnectionView`'s
  // `EngineAddCatalog`) is the sole browse-and-choose entry point, covered
  // there. This section's dialog only opens pre-addressed, via a provider id
  // named in the route.
  it('keeps detected registry choices out of the configured list, and renders no add trigger of its own', () => {
    acpRegistryState.data = [
      {
        id: 'kiro',
        name: 'Kiro CLI',
        command: 'kiro',
        detected: true,
        installed: false,
      },
    ];
    render(<ACPConnectionsView agents={[]} />);

    expect(screen.queryByText('Kiro CLI')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add engine' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Engines' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // CI-R8 — the hub card that routes here reads as a status ("Found, not
  // connected"), and one click used to write a persistent connection and mint
  // an agent with nothing asked and nothing said.
  it('a routed detected provider confirms before creating anything', async () => {
    acpRegistryState.data = [
      {
        id: 'kiro',
        name: 'Kiro CLI',
        command: 'kiro',
        detected: true,
        installed: false,
      },
    ];
    render(<ACPConnectionsView agents={[]} initialProviderId="kiro" />);

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(installRegistryEntry).not.toHaveBeenCalled();
    // The confirmation names both durable effects, not just the connection.
    expect(
      screen.getByText(/Saves a connection to Kiro CLI on this computer\./),
    ).toBeTruthy();
    expect(
      screen.getByText(/Adds an agent named Kiro CLI to your Agents list\./),
    ).toBeTruthy();
    expect(screen.queryByText('Choose an engine')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Connect Kiro CLI' }));
    await screen.findByText('Station is checking this engine now.');
    expect(installRegistryEntry).toHaveBeenCalledWith('kiro');
  });

  it('passes a post-mutation connection refresh failure through to recoverable setup', async () => {
    acpRegistryState.data = [
      { id: 'kiro', name: 'Kiro CLI', command: 'kiro', installed: false },
    ];
    acpConnectionsState.error = new Error('Connection refresh failed');
    acpConnectionsState.isError = true;
    // The merged catalogue's own choice is what used to open this dialog and
    // pick Kiro CLI from the catalog stage; a route naming the provider is
    // this section's only remaining entry point, so it arrives already past
    // that stage (`confirm`).
    render(<ACPConnectionsView agents={[]} initialProviderId="kiro" />);

    const dialog = screen.getByRole('dialog');
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Connect Kiro CLI' }),
    );
    await within(dialog).findByRole('alert');
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Retry refresh' }),
    );
    expect(acpConnectionsState.refetch).toHaveBeenCalledTimes(1);
  });

  it('does not pass a mutable tool-server callback to a plugin-owned connection', () => {
    acpConnectionsState.data = [
      {
        id: 'plugin-engine',
        name: 'Plugin engine',
        command: 'plugin-engine',
        enabled: true,
        status: 'available',
        modes: [],
        sessionId: null,
        mcpServers: [],
        currentModel: null,
        source: 'plugin',
      },
    ];
    render(<ACPConnectionsView agents={[]} />);

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Open Plugin engine connection details',
      }),
    );

    expect(screen.getByTestId('connection-detail-modal')).toBeTruthy();
    expect(detailModalProps.current?.onUpdateToolServers).toBeUndefined();
  });
});
