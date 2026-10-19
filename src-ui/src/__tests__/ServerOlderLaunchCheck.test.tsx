/** @vitest-environment jsdom */
import type { ServiceUpdateProgress } from '@kontourai/station-contracts/system-status';
import type { CoreUpdateStatus } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  useCoreUpdateStatusQuery: vi.fn(),
  useApplyCoreUpdateMutation: vi.fn(),
  useServiceUpdateProgressQuery: vi.fn(),
}));
vi.mock('@kontourai/station-sdk', () => sdk);

const IDENTITY = { instanceId: 'inst', bootId: 'boot', sha: 'abc' };
const connected = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));
vi.mock('../hooks/useConnectedServerUpdateContext', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../hooks/useConnectedServerUpdateContext')
    >();
  return {
    ...actual,
    useConnectedServerUpdateContext: () => connected.current,
  };
});

const { ServerOlderLaunchCheck, servedByServer } = await import(
  '../components/ServerOlderLaunchCheck'
);
const { BannerHost } = await import('../components/notifications/BannerHost');
const { bannerStore } = await import('../contexts/banner-store');

let status: CoreUpdateStatus | undefined;
let checkError: Error | null;
let progress: {
  data?: ServiceUpdateProgress;
  dataUpdatedAt: number;
  errorUpdatedAt: number;
};
let applyOptions: {
  onSuccess?: (data: unknown) => void;
  onError?: (error: Error) => void;
};
const mutate = vi.fn();

function serviceArchive(
  overrides: Partial<CoreUpdateStatus> = {},
): CoreUpdateStatus {
  return {
    installKind: 'archive-service',
    applyMethod: 'service-update',
    channel: 'nightly',
    currentVersion: '0.1.11-nightly.246303',
    latestVersion: '0.1.11-nightly.246500',
    releaseCheck: 'verified',
    updateAvailable: true,
    selfUpdateUnavailableReason: null,
    selfUpdateUnavailableCode: null,
    serverIdentity: IDENTITY,
    serviceUpdate: { state: 'idle' },
    ...overrides,
  } as CoreUpdateStatus;
}

function renderWithChrome(clientVersion: string | null) {
  return render(
    <>
      <ServerOlderLaunchCheck clientVersion={clientVersion} />
      <BannerHost />
    </>,
  );
}

const NEWER_CLIENT = '0.1.11-nightly.2465';

beforeEach(() => {
  status = serviceArchive();
  checkError = null;
  progress = { dataUpdatedAt: 0, errorUpdatedAt: 0 };
  mutate.mockReset();
  connected.current = {
    scopeKey: 'scope',
    apiBase: 'http://station.test:38141',
    connectionName: 'station',
    reachability: 'connected',
    kind: 'remote-server',
    identity: IDENTITY,
    identitySettled: true,
    identityReady: true,
    nativeObservationPending: false,
    claimedOwnerUnresolved: false,
    isCurrent: () => true,
  };
  sdk.useCoreUpdateStatusQuery.mockReset();
  sdk.useCoreUpdateStatusQuery.mockImplementation(
    (_apiBase: string, options: { enabled: boolean }) => ({
      data: options.enabled ? status : undefined,
      error: checkError,
      refetch: vi.fn(),
    }),
  );
  sdk.useApplyCoreUpdateMutation.mockReset();
  sdk.useApplyCoreUpdateMutation.mockImplementation(
    (_apiBase: string, options: typeof applyOptions) => {
      applyOptions = options;
      return { mutate };
    },
  );
  sdk.useServiceUpdateProgressQuery.mockReset();
  sdk.useServiceUpdateProgressQuery.mockImplementation(() => progress);
  bannerStore.clear();
  try {
    window.localStorage.clear();
  } catch {}
});

afterEach(() => {
  bannerStore.clear();
});

describe('ServerOlderLaunchCheck', () => {
  test.each(['accepted', 'refused'] as const)(
    'keeps the current update pending when the previous server reply is %s',
    async (oldReply) => {
      const actualSdk = await vi.importActual<
        typeof import('@kontourai/station-sdk')
      >('@kontourai/station-sdk');
      sdk.useApplyCoreUpdateMutation.mockImplementation(
        actualSdk.useApplyCoreUpdateMutation,
      );
      const client = new QueryClient({
        defaultOptions: {
          queries: { retry: false, gcTime: Infinity },
          mutations: { retry: false, gcTime: Infinity },
        },
      });
      const pending: Array<{
        url: string;
        resolve: (response: Response) => void;
      }> = [];
      const response = (requestId: string) =>
        new Response(
          JSON.stringify({ success: true, serviceUpdate: { requestId } }),
          {
            headers: { 'Content-Type': 'application/json' },
          },
        );
      vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (
          init?.method !== 'POST' ||
          ![
            'http://station.test:38141/api/system/core-update',
            'http://second.test:38142/api/system/core-update',
          ].includes(url)
        )
          throw new Error(
            `Unexpected update fixture request: ${init?.method} ${url}`,
          );
        return new Promise<Response>((resolve) =>
          pending.push({ url, resolve }),
        );
      });
      const tree = () => (
        <QueryClientProvider client={client}>
          <ServerOlderLaunchCheck clientVersion={NEWER_CLIENT} />
          <BannerHost />
        </QueryClientProvider>
      );
      const view = render(tree());
      try {
        fireEvent.click(
          screen.getByRole('button', {
            name: 'Update server to Nightly Oct 1',
          }),
        );
        await waitFor(() => expect(pending).toHaveLength(1));
        const firstMutation = client.getMutationCache().getAll()[0];
        connected.current = {
          ...connected.current,
          apiBase: 'http://second.test:38142',
          scopeKey: 'second-scope',
          identity: { instanceId: 'second', bootId: 'second-boot', sha: 'def' },
        };
        status = serviceArchive({
          serverIdentity: {
            instanceId: 'second',
            bootId: 'second-boot',
            sha: 'def',
          },
        });
        view.rerender(tree());
        fireEvent.click(
          await screen.findByRole('button', {
            name: 'Update server to Nightly Oct 1',
          }),
        );
        await waitFor(() => expect(pending).toHaveLength(2));
        expect(pending.map((request) => request.url)).toEqual([
          'http://station.test:38141/api/system/core-update',
          'http://second.test:38142/api/system/core-update',
        ]);
        await act(async () => {
          pending[0].resolve(
            oldReply === 'accepted'
              ? response('previous-request')
              : new Response(
                  JSON.stringify({
                    success: false,
                    error: 'Previous server refused',
                  }),
                  {
                    headers: { 'Content-Type': 'application/json' },
                  },
                ),
          );
          await waitFor(() =>
            expect(firstMutation.state.status).toBe(
              oldReply === 'accepted' ? 'success' : 'error',
            ),
          );
        });
        expect(screen.getByText('Requesting the server update…')).toBeTruthy();
        const secondMutation = client.getMutationCache().getAll()[1];
        await act(async () => {
          pending[1].resolve(response('current-request'));
          await waitFor(() =>
            expect(secondMutation.state.status).toBe('success'),
          );
        });
        expect(
          screen.getByText(
            'Update requested. Waiting for the Station service to start it…',
          ),
        ).toBeTruthy();
      } finally {
        await act(async () => {
          for (const request of pending)
            request.resolve(response('cleanup-request'));
          await Promise.resolve();
        });
        view.unmount();
        client.clear();
        vi.unstubAllGlobals();
      }
    },
  );

  test('offers a one-click update and follows it through the restart to its outcome', async () => {
    const view = renderWithChrome(NEWER_CLIENT);
    expect(
      screen.getByText(
        'This Station server runs Nightly Sep 29, build 3, which is older than this app (Nightly Oct 1).',
      ),
    ).toBeTruthy();

    const button = screen.getByRole('button', {
      name: 'Update server to Nightly Oct 1',
    });
    button.focus();
    fireEvent.click(button);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Requesting the server update…')).toBeTruthy();
    // The button left with the offer; focus stays on the banner's text.
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe(
        'Requesting the server update…',
      ),
    );

    act(() =>
      applyOptions.onSuccess?.({
        success: true,
        serviceUpdate: { requestId: 'r1' },
      }),
    );
    expect(
      screen.getByText(
        'Update requested. Waiting for the Station service to start it…',
      ),
    ).toBeTruthy();
    // Following polls the service's progress.
    expect(sdk.useServiceUpdateProgressQuery).toHaveBeenLastCalledWith(
      'http://station.test:38141',
      expect.objectContaining({ enabled: true }),
    );

    progress = { dataUpdatedAt: 0, errorUpdatedAt: 1 };
    view.rerender(
      <>
        <ServerOlderLaunchCheck clientVersion={NEWER_CLIENT} />
        <BannerHost />
      </>,
    );
    expect(
      screen.getByText('The server is restarting. Reconnecting…'),
    ).toBeTruthy();

    progress = {
      data: {
        state: 'committed',
        requestId: 'r1',
        fromVersion: '0.1.11-nightly.246303',
        targetVersion: '0.1.11-nightly.246500',
        finishedAt: '2026-10-11T10:00:00.000Z',
      },
      dataUpdatedAt: 2,
      errorUpdatedAt: 1,
    };
    view.rerender(
      <>
        <ServerOlderLaunchCheck clientVersion={NEWER_CLIENT} />
        <BannerHost />
      </>,
    );
    expect(
      screen.getByText(
        /^Server updated from 0\.1\.11-nightly\.246303 to 0\.1\.11-nightly\.246500/,
      ),
    ).toBeTruthy();
  });

  test('dismissing an update it stopped following does not re-offer it from the old answer', () => {
    vi.useFakeTimers();
    try {
      renderWithChrome(NEWER_CLIENT);
      fireEvent.click(
        screen.getByRole('button', { name: 'Update server to Nightly Oct 1' }),
      );
      act(() =>
        applyOptions.onSuccess?.({
          success: true,
          serviceUpdate: { requestId: 'r1' },
        }),
      );
      // 45 minutes without an outcome: the update may still have committed.
      act(() => {
        vi.advanceTimersByTime(45 * 60 * 1000);
      });
      expect(
        screen.getByText(
          'Stopped following the server update without reading its outcome.',
        ),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
      act(() => {
        vi.runOnlyPendingTimers();
      });
      // The cached answer predates the update; it must not offer it again.
      expect(
        screen.queryByRole('button', { name: /Update server/ }),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test('dismissing a running update does not bring the stale offer back', () => {
    renderWithChrome(NEWER_CLIENT);
    fireEvent.click(
      screen.getByRole('button', { name: 'Update server to Nightly Oct 1' }),
    );
    act(() =>
      applyOptions.onSuccess?.({
        success: true,
        serviceUpdate: { requestId: 'r1' },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByRole('button', { name: /Update server/ })).toBeNull();
    // Still following the update it started.
    expect(sdk.useServiceUpdateProgressQuery).toHaveBeenLastCalledWith(
      'http://station.test:38141',
      expect.objectContaining({ enabled: true }),
    );
  });

  test('an answer that is not a queued update is a refusal, not a follow', () => {
    renderWithChrome(NEWER_CLIENT);
    fireEvent.click(
      screen.getByRole('button', { name: 'Update server to Nightly Oct 1' }),
    );
    act(() =>
      applyOptions.onSuccess?.({
        success: false,
        serviceUpdate: { requestId: 'r1' },
      }),
    );
    expect(
      screen.getByText(/The server update could not be started/),
    ).toBeTruthy();
  });

  test.each([
    ['unreachable', { reachability: 'unavailable' }],
    ['superseded', { isCurrent: () => false }],
  ])(
    'offers nothing from cached facts once the server is %s',
    (_label, change) => {
      // The query is off, but the cache still holds the last answer.
      sdk.useCoreUpdateStatusQuery.mockImplementation(() => ({
        data: status,
        error: null,
        refetch: vi.fn(),
      }));
      connected.current = { ...connected.current, ...change };
      renderWithChrome(NEWER_CLIENT);
      expect(
        screen.queryByRole('button', { name: /Update server/ }),
      ).toBeNull();
      expect(bannerStore.getSnapshot()).toHaveLength(0);
    },
  );

  test('dismissing it for one server does not hide it for another', () => {
    const first = renderWithChrome(NEWER_CLIENT);
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    first.unmount();
    status = serviceArchive({
      serverIdentity: { instanceId: 'other', bootId: 'boot', sha: 'abc' },
    });
    connected.current = {
      ...connected.current,
      apiBase: 'http://other.test:38141',
      identity: { instanceId: 'other', bootId: 'boot', sha: 'abc' },
    };
    renderWithChrome(NEWER_CLIENT);
    expect(
      screen.getByRole('button', { name: 'Update server to Nightly Oct 1' }),
    ).toBeTruthy();
  });

  test('says how to update when the server cannot do it from here, with no update button', () => {
    status = serviceArchive({
      installKind: 'archive',
      applyMethod: 'station-upgrade',
    });
    renderWithChrome(NEWER_CLIENT);
    expect(
      screen.getByText(/which is older than this app \(Nightly Oct 1\)/),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Update server/ })).toBeNull();
    const details = screen.getByRole('link', {
      name: 'Server update details',
    });
    expect(details.getAttribute('href')).toBe(
      '/settings?view=system&highlight=core-app-updates',
    );
  });

  test('stays silent for a dev build and mounts no server check at all', () => {
    renderWithChrome(null);
    expect(bannerStore.getSnapshot()).toHaveLength(0);
    // No update hook runs, so a shell whose SDK provides none (App's own
    // tests, a dev build) is untouched by this check.
    expect(sdk.useCoreUpdateStatusQuery).not.toHaveBeenCalled();
    expect(sdk.useApplyCoreUpdateMutation).not.toHaveBeenCalled();
    expect(sdk.useServiceUpdateProgressQuery).not.toHaveBeenCalled();
  });

  test('stays silent when the versions are equal', () => {
    renderWithChrome('0.1.11-nightly.2463.3');
    expect(bannerStore.getSnapshot()).toHaveLength(0);
  });

  test("stays silent for the server's own web UI and asks it nothing", () => {
    connected.current = {
      ...connected.current,
      apiBase: window.location.origin,
    };
    // Another reader of the same query key may already hold the answer.
    sdk.useCoreUpdateStatusQuery.mockImplementation(() => ({
      data: status,
      error: null,
      refetch: vi.fn(),
    }));
    renderWithChrome(NEWER_CLIENT);
    expect(bannerStore.getSnapshot()).toHaveLength(0);
    expect(sdk.useCoreUpdateStatusQuery).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ enabled: false }),
      expect.anything(),
    );
  });

  test('stays silent for the built-in server a desktop app updates itself', () => {
    connected.current = { ...connected.current, kind: 'embedded-sidecar' };
    renderWithChrome(NEWER_CLIENT);
    expect(bannerStore.getSnapshot()).toHaveLength(0);
  });

  test('a dismissal holds for the same pair of versions', () => {
    const first = renderWithChrome(NEWER_CLIENT);
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    first.unmount();
    bannerStore.clear('nothing-matches');
    renderWithChrome(NEWER_CLIENT);
    expect(
      bannerStore.getSnapshot().filter((banner) => banner.phase !== 'exiting'),
    ).toHaveLength(0);
  });
});

describe('servedByServer', () => {
  test.each([
    ['', 'http://a.test', true],
    ['http://a.test', 'http://a.test', true],
    ['http://a.test:38141', 'http://a.test', false],
    ['http://127.0.0.1:38141', 'tauri://localhost', false],
    ['http://a.test', undefined, false],
  ])('%j from %j is %s', (apiBase, origin, expected) => {
    expect(servedByServer(apiBase, origin)).toBe(expected);
  });
});
