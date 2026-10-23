/** @vitest-environment jsdom */
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  type UpdateNotice,
  useOpenUpdatesRequest,
  useUpdateNotices,
} from '../components/updates/updatesEvents';

let isMobile = false;
let isDesktop = false;
let desktopStatus:
  | {
      updateAvailable: boolean;
      installKind?: 'source-checkout' | 'desktop-bundle' | 'unknown';
      applyMethod?: 'git-pull' | 'reinstall' | 'self-update';
      behind?: number;
      ahead?: number;
      currentHash?: string;
      remoteHash?: string;
      channel?: string;
    }
  | undefined;
const { useCoreUpdateStatusQuery, useConnectedServerUpdateContext } =
  vi.hoisted(() => ({
    useCoreUpdateStatusQuery: vi.fn(),
    useConnectedServerUpdateContext: vi.fn(),
  }));
const context = {
  scopeKey: 'scope:station.test',
  apiBase: 'http://station.test',
  connectionName: 'station',
  reachability: 'connected',
  kind: 'remote-server',
  identity: null,
  identitySettled: true,
  identityReady: true,
  nativeObservationPending: false,
  claimedOwnerUnresolved: false,
  isCurrent: () => true,
};
vi.mock('@kontourai/station-sdk', () => ({ useCoreUpdateStatusQuery }));
vi.mock('../hooks/useConnectedServerUpdateContext', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../hooks/useConnectedServerUpdateContext')
  >()),
  useConnectedServerUpdateContext,
}));
vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ isMobile, isDesktop }),
}));
const { CoreUpdateLaunchCheck } = await import(
  '../components/CoreUpdateLaunchCheck'
);

let notices: readonly UpdateNotice[] = [];
let openRequest: ReturnType<typeof useOpenUpdatesRequest>;
function UpdatesObserver() {
  notices = useUpdateNotices();
  openRequest = useOpenUpdatesRequest();
  return null;
}
function renderCheck(
  props: React.ComponentProps<typeof CoreUpdateLaunchCheck> = {},
) {
  return render(
    <>
      <CoreUpdateLaunchCheck apiBase="http://station.test" {...props} />
      <UpdatesObserver />
    </>,
  );
}
const feedProps = {
  feedUrl: 'https://updates.example.test/feed',
  providerOrigin: 'https://updates.example.test',
  installedVersion: '1.0.0',
};
function feedResponse(
  version = '2.0.0',
  releaseUrl = 'https://updates.example.test/app',
) {
  return {
    ok: true,
    url: feedProps.feedUrl,
    json: async () => ({ channel: 'stable', version, releaseUrl }),
  } as Response;
}
function expectQueryEnabled(enabled: boolean) {
  expect(useCoreUpdateStatusQuery).toHaveBeenLastCalledWith(
    'http://station.test',
    expect.objectContaining({ enabled }),
    expect.objectContaining({
      scopeKey: 'scope:station.test\u0000no-boot',
      assertCurrent: context.isCurrent,
    }),
  );
}

beforeEach(() => {
  isMobile = false;
  isDesktop = false;
  desktopStatus = undefined;
  notices = [];
  useCoreUpdateStatusQuery.mockReset();
  useCoreUpdateStatusQuery.mockImplementation(() => ({ data: desktopStatus }));
  useConnectedServerUpdateContext.mockReset();
  useConnectedServerUpdateContext.mockReturnValue(context);
});
afterEach(() => vi.restoreAllMocks());

describe('CoreUpdateLaunchCheck notices', () => {
  test.each([1, 3])(
    'publishes a source comparison of %i commits for review in the unified panel',
    (behind) => {
      desktopStatus = {
        updateAvailable: true,
        installKind: 'source-checkout',
        applyMethod: 'git-pull',
        behind,
        ahead: 0,
      };
      const { container } = renderCheck();
      expect(container.firstChild).toBeNull();
      expect(notices).toEqual([
        expect.objectContaining({
          target: 'server',
          message: `Server checkout is ${behind} commit${behind === 1 ? '' : 's'} behind its configured upstream.`,
          actionLabel: 'Review server update',
        }),
      ]);
      expectQueryEnabled(true);
      const sequence = openRequest.sequence;
      act(() => notices[0].onAction?.());
      expect(openRequest).toMatchObject({
        target: 'server',
        sequence: sequence + 1,
      });
    },
  );

  test.each([
    { installKind: 'desktop-bundle' as const, behind: undefined, ahead: 0 },
    { installKind: 'desktop-bundle' as const, behind: 3, ahead: 0 },
    { installKind: 'source-checkout' as const, behind: 3, ahead: 2 },
    { installKind: 'source-checkout' as const, behind: 0, ahead: 0 },
  ])(
    'does not turn stamp differences or a diverged/current checkout into an offer: %j',
    (facts) => {
      desktopStatus = {
        updateAvailable: true,
        applyMethod: 'reinstall',
        currentHash: 'aaaaaaa',
        remoteHash: 'bbbbbbb',
        ...facts,
      };
      renderCheck();
      expect(notices).toEqual([]);
    },
  );

  test.each([
    ['embedded sidecar', { kind: 'embedded-sidecar' }],
    ['failed identity', { identityReady: false }],
    ['pending identity', { identityReady: false, identitySettled: false }],
    ['pending native observation', { nativeObservationPending: true }],
    ['unresolved claimed owner', { claimedOwnerUnresolved: true }],
  ])('withholds the desktop source query for %s', (_label, change) => {
    isDesktop = true;
    useConnectedServerUpdateContext.mockReturnValue({ ...context, ...change });
    renderCheck();
    expect(useConnectedServerUpdateContext).toHaveBeenCalledWith({
      identityEnabled: true,
    });
    expectQueryEnabled(false);
    expect(notices).toEqual([]);
  });

  test.each([true, false])(
    'leaves native identity correlation off when mobile=%s',
    (mobile) => {
      isMobile = mobile;
      renderCheck();
      expect(useConnectedServerUpdateContext).toHaveBeenCalledWith({
        identityEnabled: false,
      });
      expectQueryEnabled(!mobile);
    },
  );

  test('a current selected Station publishes no update notice', () => {
    desktopStatus = { updateAvailable: false };
    renderCheck();
    expect(notices).toEqual([]);
  });

  test('a mobile build without an update channel neither probes nor reports failure', () => {
    isMobile = true;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderCheck({ feedUrl: '', providerOrigin: '' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  });

  test('publishes a real check failure and retries through its notice action', async () => {
    isMobile = true;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(feedResponse());
    renderCheck(feedProps);
    await waitFor(() =>
      expect(notices).toEqual([
        expect.objectContaining({
          target: 'desktop',
          detail: 'offline',
          actionLabel: 'Retry update check',
        }),
      ]),
    );
    act(() => notices[0].onAction?.());
    await waitFor(() =>
      expect(notices).toEqual([
        expect.objectContaining({
          message: 'Station 2.0.0 is available.',
          href: 'https://updates.example.test/app',
        }),
      ]),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test('reads the provenance-pinned app feed rather than the selected Station', async () => {
    isMobile = true;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(feedResponse());
    renderCheck({ ...feedProps, apiBase: 'https://selected-station.test' });
    await waitFor(() => expect(notices).toHaveLength(1));
    expect(String(fetchSpy.mock.calls[0][0])).toBe(feedProps.feedUrl);
    expect(fetchSpy.mock.calls[0][1]).toEqual(
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  test.each([
    [
      'insecure release',
      'https://updates.example.test/feed',
      'http://downloads.example/app.apk',
      /must use HTTPS/,
    ],
    [
      'cross-origin response',
      'https://cdn.example.test/feed',
      'https://updates.example.test/app',
      /not trusted/,
    ],
  ])(
    'rejects %s without publishing an install action',
    async (_label, url, releaseUrl, detail) => {
      isMobile = true;
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ...feedResponse('2.0.0', releaseUrl),
        url,
      });
      renderCheck(feedProps);
      await waitFor(() => expect(notices[0]?.detail).toMatch(detail));
      expect(notices.some((notice) => notice.href)).toBe(false);
    },
  );

  test.each([
    ['1.2.3', '1.2.3', false],
    ['1.2.3', '1.2.4', true],
    ['1.2.3', '1.2.2', false],
    ['1.2.3-preview.2', '1.2.3-preview.10', true],
    ['1.2.3-preview.10', '1.2.3', true],
    ['1.2.3', '1.2.4-preview.1', true],
    ['1.2.3', '1.2.3-preview.1', false],
  ])(
    'orders installed %s against feed %s',
    async (installedVersion, version, available) => {
      isMobile = true;
      let answerFeed!: (value: unknown) => void;
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ...feedResponse(),
        json: () =>
          new Promise((resolve) => {
            answerFeed = resolve;
          }),
      });
      renderCheck({ ...feedProps, installedVersion });
      await waitFor(() => expect(answerFeed).toBeDefined());
      await act(async () =>
        answerFeed({
          channel: 'stable',
          version,
          releaseUrl: 'https://updates.example.test/app',
        }),
      );
      expect(
        notices.some(
          (notice) => notice.href === 'https://updates.example.test/app',
        ),
      ).toBe(available);
      expect(notices.some((notice) => notice.detail)).toBe(false);
    },
  );

  test('publishes an outbound release URL without opening a window or installing automatically', async () => {
    isMobile = true;
    const openSpy = vi.spyOn(window, 'open');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(feedResponse());
    renderCheck(feedProps);
    await waitFor(() =>
      expect(notices[0]?.href).toBe('https://updates.example.test/app'),
    );
    expect(notices[0]?.onAction).toBeUndefined();
    expect(openSpy).not.toHaveBeenCalled();
  });

  test.each([false, true])(
    'does not probe the app feed in desktop=%s shells',
    (desktop) => {
      isDesktop = desktop;
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      renderCheck(feedProps);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
});
