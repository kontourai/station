/** @vitest-environment jsdom */
import {
  TELEMETRY_COMPANION_ARCHIVE_PREPARATION_PROTOCOL,
  type TelemetryCompanionArchivePreparation,
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
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const response = await app.fetch(request);
      if (
        options.dropPreparationReply &&
        request.method === 'POST' &&
        new URL(request.url).pathname.endsWith('/archive-preparations')
      )
        throw new TypeError('reply lost');
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
    client,
    unmount: rendered.unmount,
    rerender: () => rendered.rerender(tree()),
  };
}

test('prepares through the SDK and mounted route, recovers a lost reply and reopens without resending', async () => {
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
        latest,
      }),
    prepareArchive,
    archivePreparation: async (operationId: string) =>
      latest?.operationId === operationId ? latest : null,
    dropPreparationReply: true,
  };
  const first = mount(options);
  const button = await screen.findByRole('button', {
    name: 'Prepare signed archive',
  });
  await waitFor(() => expect(button).toHaveProperty('disabled', false));
  fireEvent.click(button);
  expect(
    await screen.findByText(/Archive bytes verified for 0.7.0-nightly.12/),
  ).toBeTruthy();
  expect(prepareArchive).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
  first.unmount();
  mount(options);
  expect(
    await screen.findByText(/Archive bytes verified for 0.7.0-nightly.12/),
  ).toBeTruthy();
  expect(prepareArchive).toHaveBeenCalledTimes(1);
});

test('renders the host observation from the real SDK/route without claiming installation', async () => {
  const h = mount();
  expect(
    await screen.findByText(
      /Host prerequisites passed: Linux arm64, Docker 29.4.0, Compose 5.1.2/,
    ),
  ).toBeTruthy();
  expect(screen.getByText(/Installation is not available yet/)).toBeTruthy();
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
  expect(
    screen.getByText(/archive-byte authentication and runtime qualification/),
  ).toBeTruthy();
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
