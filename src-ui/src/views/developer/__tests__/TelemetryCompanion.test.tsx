import type { ProductTelemetryTrends } from '@kontourai/station-contracts/product-telemetry';
/** @vitest-environment jsdom */
import {
  TELEMETRY_COMPANION_ARCHIVE_PREPARATION_PROTOCOL,
  type TelemetryCompanionAction,
  type TelemetryCompanionArchivePreparation,
  type TelemetryCompanionInstallation,
  type TelemetryCompanionManagedState,
  type TelemetryCompanionPreparationState,
  type TelemetryCompanionPrerequisites,
} from '@kontourai/station-contracts/telemetry-delivery';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createTelemetryCompanionRoutes } from '../../../../../src-server/routes/system/telemetry-companion-routes';
import TelemetryTab from '../TelemetryTab';

vi.mock('../../MonitoringView', () => ({
  MonitoringViewWithBoundary: () => <p>Local activity</p>,
}));

const host = vi.hoisted(() => ({
  apiBase: 'https://station.example.test',
  authorityKey: 'operator-one',
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({ ...host }),
}));
const clients: QueryClient[] = [];
beforeEach(() => {
  host.authorityKey = 'operator-one';
  setClientCredentialResolver(() => {
    const authorityKey = host.authorityKey;
    return {
      origin: host.apiBase,
      requestAuthority: {
        apiBase: host.apiBase,
        authorityKey,
        isCurrent: () => host.authorityKey === authorityKey,
      },
    };
  });
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});
const available: TelemetryCompanionPrerequisites = {
  kind: 'available',
  checkedAt: '2026-10-23T00:00:00.000Z',
  containerHost: 'local',
  architecture: 'arm64',
  dockerVersion: '29.4.0',
  composeVersion: '5.1.2',
};
function mount(
  options: {
    operator?: boolean;
    prerequisites?: () => Promise<TelemetryCompanionPrerequisites>;
    preparationState?: () => Promise<TelemetryCompanionPreparationState>;
    prepareArchive?: (
      request: Request,
      operationId: string,
    ) => Promise<TelemetryCompanionArchivePreparation>;
    archivePreparation?: (
      operationId: string,
    ) => Promise<TelemetryCompanionArchivePreparation | null>;
    dropPreparationReply?: boolean;
    managedState?: () => Promise<TelemetryCompanionManagedState>;
    install?: (
      request: Request,
      installationId: string,
      preparationId: string,
    ) => Promise<TelemetryCompanionInstallation>;
    installation?: (
      installationId: string,
    ) => Promise<TelemetryCompanionInstallation | null>;
    control?: (
      request: Request,
      installationId: string,
      operationId: string,
      action: 'start' | 'stop',
    ) => Promise<TelemetryCompanionAction>;
    action?: (
      installationId: string,
      operationId: string,
    ) => Promise<TelemetryCompanionAction | null>;
    dropActionReply?: boolean;
    productTrends?: (
      request: Request,
      window: { from: string; to: string },
    ) => Promise<ProductTelemetryTrends>;
  } = {},
) {
  const probe = vi.fn(options.prerequisites ?? (async () => available));
  const app = new Hono().route(
    '/api/operator/telemetry-companion',
    createTelemetryCompanionRoutes({
      requireOperator: async () => {
        if (options.operator === false) throw new Error('operator required');
      },
      prerequisites: probe,
      productTrends: options.productTrends,
      managedState:
        options.managedState ??
        (async () => ({
          supported: true,
          hasOperationLock: false,
          installation: null,
          latestAction: null,
          runtime: 'not-installed',
          storage: 'not-checked',
          observedAt: '2026-10-24T00:00:00.000Z',
        })),
      install: options.install,
      installation: options.installation,
      control: options.control,
      action: options.action,
      preparationState:
        options.preparationState ??
        (async () => ({
          supported: true,
          mayPrepare: false,
          hasOperationLock: false,
          latestOperationId: null,
          latest: null,
        })),
      prepareArchive: options.prepareArchive,
      archivePreparation: options.archivePreparation,
    }),
  );
  const mutations: Array<{ path: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === 'POST')
        mutations.push({
          path: new URL(request.url).pathname,
          body: await request.clone().json(),
        });
      const response = await app.fetch(request);
      if (
        options.dropPreparationReply &&
        response.ok &&
        request.method === 'POST' &&
        new URL(request.url).pathname.endsWith('/archive-preparations')
      )
        throw new TypeError('reply lost');
      if (
        options.dropActionReply &&
        response.ok &&
        request.method === 'POST' &&
        new URL(request.url).pathname.endsWith('/actions')
      )
        throw new TypeError('action reply lost');
      return response;
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const tree = () => (
    <QueryClientProvider client={client}>
      <TelemetryTab />
    </QueryClientProvider>
  );
  const rendered = render(tree());
  fireEvent.click(screen.getByRole('tab', { name: 'Companion' }));
  return {
    probe,
    mutations,
    client,
    unmount: rendered.unmount,
    rerender: () => rendered.rerender(tree()),
  };
}

test.each(['recovered', 'unconfirmed'] as const)(
  'a lost preparation reply is %s through receipt reads, including after reopening',
  async (recovery) => {
    let latest: TelemetryCompanionArchivePreparation | null = null;
    const prepareArchive = vi.fn(
      async (
        _request: Request,
        operationId: string,
      ): Promise<TelemetryCompanionArchivePreparation> => {
        latest = {
          protocol: TELEMETRY_COMPANION_ARCHIVE_PREPARATION_PROTOCOL,
          operationId,
          phase: 'authenticated',
          version: '0.7.0-nightly.12',
          source: 'a'.repeat(40),
          artifactSha256: 'b'.repeat(64),
          expectedBytes: 10,
          receivedBytes: 10,
          createdAt: '2026-10-23T00:00:00.000Z',
          installationAuthority: false,
          payloadPrepared: true,
        };
        return latest;
      },
    );
    const options = {
      prerequisites: async (): Promise<TelemetryCompanionPrerequisites> => ({
        ...available,
        artifact: {
          kind: 'parent-envelope-verified',
          version: '0.7.0-nightly.12',
          source: 'a'.repeat(40),
          artifactSha256: 'b'.repeat(64),
          qualification: 'build-only',
          installationAuthority: false,
        },
      }),
      preparationState:
        async (): Promise<TelemetryCompanionPreparationState> => ({
          supported: true,
          mayPrepare: true,
          hasOperationLock: false,
          latestOperationId: latest?.operationId ?? null,
          latest: recovery === 'recovered' ? latest : null,
        }),
      prepareArchive,
      archivePreparation: async (operationId: string) =>
        recovery === 'recovered' && latest?.operationId === operationId
          ? latest
          : null,
      dropPreparationReply: true,
    };
    const first = mount(options);
    const button = await screen.findByRole('button', {
      name: 'Prepare signed archive',
    });
    await waitFor(() => expect(button).toHaveProperty('disabled', false));
    fireEvent.click(button);
    await waitFor(() => expect(prepareArchive).toHaveBeenCalledTimes(1));
    if (recovery === 'recovered') {
      expect(
        await screen.findByText(/Archive bytes verified for 0.7.0-nightly.12/),
      ).toBeTruthy();
      expect(
        screen.getByText(/Companion files prepared and verified/),
      ).toBeTruthy();
    } else {
      expect(
        await screen.findByText(/preparation outcome is unconfirmed/),
      ).toBeTruthy();
      expect(
        screen.getByRole('button', { name: 'Prepare signed archive' }),
      ).toHaveProperty('disabled', true);
      fireEvent.click(
        screen.getByRole('button', { name: 'Check preparation status' }),
      );
      await waitFor(() => expect(first.client.isFetching()).toBe(0));
      expect(screen.queryByText(/Archive bytes verified/)).toBeNull();
    }
    expect(prepareArchive).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
    first.unmount();
    mount(options);
    if (recovery === 'recovered') {
      expect(
        await screen.findByText(/Archive bytes verified for 0.7.0-nightly.12/),
      ).toBeTruthy();
    } else {
      expect(
        await screen.findByText(/recorded operation has no readable receipt/),
      ).toBeTruthy();
      expect(
        screen.getByRole('button', { name: 'Prepare signed archive' }),
      ).toHaveProperty('disabled', true);
    }
    expect(prepareArchive).toHaveBeenCalledTimes(1);
  },
);

test.each(['recovered', 'unconfirmed'] as const)(
  'managed pane submits explicit install intent and reads a %s control outcome without repeating effects, including after reopening',
  async (recovery) => {
    const prepared: TelemetryCompanionArchivePreparation = {
      protocol: TELEMETRY_COMPANION_ARCHIVE_PREPARATION_PROTOCOL,
      operationId: '11234567-89ab-4cde-8fab-0123456789ab',
      phase: 'authenticated',
      source: 'a'.repeat(40),
      version: '0.7.0-nightly.12',
      artifactSha256: 'b'.repeat(64),
      expectedBytes: 10,
      receivedBytes: 10,
      createdAt: '2026-10-24T00:00:00.000Z',
      installationAuthority: false,
      payloadPrepared: true,
      qualifiedArchitectures: ['arm64'],
    };
    let current: TelemetryCompanionManagedState = {
      supported: true,
      hasOperationLock: false,
      installation: null,
      latestAction: null,
      runtime: 'not-installed',
      storage: 'not-checked',
      observedAt: '2026-10-24T00:00:00.000Z',
    };
    let profileAvailable = false;
    const install = vi.fn(
      async (
        _request: Request,
        installationId: string,
        preparationId: string,
      ): Promise<TelemetryCompanionInstallation> => {
        const receipt: TelemetryCompanionInstallation = {
          protocol: 'station-companion-installation/v1',
          installationId,
          preparationId,
          source: prepared.source,
          version: prepared.version,
          architecture: 'arm64',
          phase: 'installed',
          createdAt: prepared.createdAt,
          host: 'selected-station',
          storage: 'managed-docker-volumes',
          configuresSending: false,
        };
        current = { ...current, installation: receipt, runtime: 'stopped' };
        return receipt;
      },
    );
    const control = vi.fn(
      async (
        _request: Request,
        installationId: string,
        operationId: string,
        action: 'start' | 'stop',
      ): Promise<TelemetryCompanionAction> => {
        expect(action).toBe('start');
        const receipt: TelemetryCompanionAction = {
          protocol: 'station-companion-action/v1',
          installationId,
          operationId,
          action,
          phase: recovery === 'recovered' ? 'completed' : 'unconfirmed',
          createdAt: prepared.createdAt,
          configuresSending: false,
        };
        current = {
          ...current,
          latestAction: receipt,
          runtime: recovery === 'recovered' ? 'running' : 'partial',
          storage: recovery === 'recovered' ? 'ready' : 'not-checked',
        };
        if (recovery === 'unconfirmed')
          throw new Error('fixture outcome unconfirmed');
        return receipt;
      },
    );
    const options = {
      prerequisites: async (): Promise<TelemetryCompanionPrerequisites> => ({
        ...available,
        artifact: {
          kind: 'parent-envelope-verified',
          version: prepared.version,
          source: prepared.source,
          artifactSha256: prepared.artifactSha256,
          qualification: 'build-only',
          installationAuthority: false,
        },
      }),
      preparationState: async () => ({
        supported: true,
        mayPrepare: true,
        hasOperationLock: false,
        latestOperationId: prepared.operationId,
        latest: profileAvailable
          ? prepared
          : { ...prepared, qualifiedArchitectures: undefined },
      }),
      managedState: async () => ({ ...current }),
      install,
      installation: async () => current.installation,
      control,
      action: async () => current.latestAction,
      dropActionReply: true,
    };
    const h = mount(options);
    const button = await screen.findByRole('button', {
      name: 'Install companion',
    });
    expect(button).toHaveProperty('disabled', true);
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: /Install on the selected Station using managed Docker volumes/,
      }),
    );
    await waitFor(() => expect(h.client.isFetching()).toBe(0));
    expect(button).toHaveProperty('disabled', true);
    profileAvailable = true;
    fireEvent.click(
      screen.getByRole('button', { name: 'Check companion status' }),
    );
    await waitFor(() => expect(button).toHaveProperty('disabled', false));
    fireEvent.click(button);
    const start = await screen.findByRole('button', {
      name: 'Start companion',
    });
    await waitFor(() => expect(start).toHaveProperty('disabled', false));
    expect(install).toHaveBeenCalledTimes(1);
    expect(
      h.mutations.find((mutation) => mutation.path.endsWith('/installations'))
        ?.body,
    ).toMatchObject({
      preparationId: prepared.operationId,
      host: 'selected-station',
      storage: 'managed-docker-volumes',
    });
    fireEvent.click(start);
    await waitFor(() => expect(control).toHaveBeenCalledTimes(1));
    if (recovery === 'recovered')
      expect(
        await screen.findByText(/Running. Receiver storage is ready/),
      ).toBeTruthy();
    else
      expect(
        await screen.findByText(/last start outcome needs reconciliation/),
      ).toBeTruthy();
    const stop = await screen.findByRole('button', { name: 'Stop companion' });
    await waitFor(() => expect(stop).toHaveProperty('disabled', false));
    fireEvent.click(
      screen.getByRole('button', { name: 'Check companion status' }),
    );
    await waitFor(() => expect(h.client.isFetching()).toBe(0));
    expect(control).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledTimes(1);
    h.unmount();
    mount(options);
    if (recovery === 'recovered')
      expect(
        await screen.findByText(/Running. Receiver storage is ready/),
      ).toBeTruthy();
    else
      expect(
        await screen.findByText(/last start outcome needs reconciliation/),
      ).toBeTruthy();
    expect(control).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledTimes(1);
  },
);

test('renders the host observation from the real SDK/route without claiming installation', async () => {
  const h = mount();
  expect(
    await screen.findByText(
      /Host prerequisites passed: Linux arm64, Docker 29.4.0, Compose 5.1.2/,
    ),
  ).toBeTruthy();
  expect(
    screen.getByText(/Host capability alone does not establish/),
  ).toBeTruthy();
  expect(h.probe).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
});

test('renders verified parent evidence through the SDK while refusing installation authority', async () => {
  mount({
    prerequisites: async () => ({
      ...available,
      artifact: {
        kind: 'parent-envelope-verified',
        version: '0.7.0-nightly.12',
        source: 'a'.repeat(40),
        artifactSha256: 'b'.repeat(64),
        qualification: 'build-only',
        installationAuthority: false,
      },
    }),
  });
  expect(
    await screen.findByText(
      /Parent release 0.7.0-nightly.12 has a verified signed envelope/,
    ),
  ).toBeTruthy();
  expect(screen.getByText(/archive must be authenticated/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
});

test('a refused operator read shows the required authority and launches no probe', async () => {
  const h = mount({ operator: false });
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    expect.stringContaining('operator session'),
  );
  expect(h.probe).not.toHaveBeenCalled();
  expect(screen.queryByText(/Host prerequisites passed/)).toBeNull();
});

test('a malformed refresh replaces prior success with an error', async () => {
  mount();
  await screen.findByText(/Host prerequisites passed/);
  vi.mocked(fetch).mockResolvedValueOnce(
    Response.json({ data: { kind: 'available' } }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Check host again' }));
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    expect.stringContaining('host check is unavailable'),
  );
  expect(screen.queryByText(/Host prerequisites passed/)).toBeNull();
});

test('the SDK refuses a response that promotes build evidence to installation authority', async () => {
  mount();
  await screen.findByText(/Host prerequisites passed/);
  vi.mocked(fetch).mockResolvedValueOnce(
    Response.json({
      data: {
        ...available,
        artifact: {
          kind: 'parent-envelope-verified',
          version: '0.7.0-nightly.12',
          source: 'a'.repeat(40),
          artifactSha256: 'b'.repeat(64),
          qualification: 'build-only',
          installationAuthority: true,
        },
      },
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Check host again' }));
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    expect.stringContaining('host check is unavailable'),
  );
  expect(screen.queryByText(/Parent release/)).toBeNull();
});

test('a delayed prior-authority result cannot replace the newly selected authority', async () => {
  let release: ((value: TelemetryCompanionPrerequisites) => void) | undefined;
  const old = new Promise<TelemetryCompanionPrerequisites>((resolve) => {
    release = resolve;
  });
  let first = true;
  const h = mount({
    prerequisites: async () => {
      if (first) {
        first = false;
        return old;
      }
      return {
        kind: 'unavailable',
        checkedAt: available.checkedAt,
        reason: 'container-runtime-missing',
      };
    },
  });
  await waitFor(() => expect(h.probe).toHaveBeenCalledTimes(1));
  host.authorityKey = 'operator-two';
  h.rerender();
  await screen.findByText(/Install Docker and Compose on the Station host/);
  await act(async () => {
    release?.(available);
    await old;
  });
  expect(screen.queryByText(/Host prerequisites passed/)).toBeNull();
  expect(
    JSON.stringify(
      h.client
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data),
    ),
  ).not.toContain('29.4.0');
});

test('running companion renders received product groups with release/window filters and hides results after failed refresh', async () => {
  const installation: TelemetryCompanionInstallation = {
    protocol: 'station-companion-installation/v1',
    installationId: '01234567-89ab-4cde-8fab-0123456789ab',
    preparationId: '11234567-89ab-4cde-8fab-0123456789ab',
    source: 'a'.repeat(40),
    version: '0.1.11',
    architecture: 'arm64',
    phase: 'installed',
    createdAt: '2026-10-24T00:00:00.000Z',
    host: 'selected-station',
    storage: 'managed-docker-volumes',
    configuresSending: false,
  };
  const productTrends = vi.fn(
    async (
      _request: Request,
      window: { from: string; to: string },
    ): Promise<ProductTelemetryTrends> => ({
      scope: 'received-product-observations',
      window,
      retentionDays: 90,
      eventTime: 'producer-wall-clock',
      deliveryCoverage: 'unknown',
      rows: [
        {
          day: window.from.slice(0, 10),
          event: 'station_started',
          version: '0.1.11',
          sha: 'a'.repeat(40),
          shaSource: 'build-stamp',
          engine: null,
          outcome: null,
          count: 3,
        },
        {
          day: window.from.slice(0, 10),
          event: 'station_started',
          version: '0.1.10',
          sha: null,
          shaSource: null,
          engine: null,
          outcome: null,
          count: 2,
        },
      ],
    }),
  );
  mount({
    productTrends,
    managedState: async () => ({
      supported: true,
      hasOperationLock: false,
      installation,
      latestAction: null,
      runtime: 'running',
      storage: 'ready',
      observedAt: '2026-10-24T00:00:00.000Z',
    }),
  });
  expect(await screen.findByText(/3 received\. Release 0.1.11/)).toBeTruthy();
  expect(screen.getByText(/Delivery coverage is unknown/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Release'), {
    target: { value: JSON.stringify(['0.1.11', 'a'.repeat(40)]) },
  });
  expect(screen.queryByText(/2 received\. Release 0.1.10/)).toBeNull();
  fireEvent.change(screen.getByLabelText('Time window'), {
    target: { value: '14' },
  });
  await waitFor(() => expect(productTrends).toHaveBeenCalledTimes(2));
  const window = productTrends.mock.calls[1]?.[1];
  if (!window) throw new Error('Expected second query window');
  expect(Date.parse(window.to) - Date.parse(window.from)).toBe(14 * 86400000);
  expect(await screen.findByText(/2 received\. Release 0.1.10/)).toBeTruthy();
  productTrends.mockRejectedValueOnce(new Error('private receiver failure'));
  fireEvent.click(
    screen.getByRole('button', { name: 'Refresh product trends' }),
  );
  expect(
    await screen.findByText(/Product trends are unavailable/),
  ).toBeTruthy();
  expect(screen.queryByText(/3 received\. Release 0.1.11/)).toBeNull();
  expect(screen.queryByText(/private receiver failure/)).toBeNull();
});
