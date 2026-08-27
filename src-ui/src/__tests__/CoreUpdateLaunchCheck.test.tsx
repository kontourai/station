/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let isMobile = false;
let desktopStatus:
  | {
      updateAvailable: boolean;
      installKind?: 'source-checkout' | 'desktop-bundle' | 'unknown';
      applyMethod?: 'git-pull' | 'reinstall' | 'self-update';
      behind?: number;
      channel?: string;
    }
  | undefined;
const { useCoreUpdateStatusQuery } = vi.hoisted(() => ({
  useCoreUpdateStatusQuery: vi.fn(),
}));
vi.mock('@kontourai/station-sdk', () => ({ useCoreUpdateStatusQuery }));
vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ isMobile }),
}));

const { CoreUpdateLaunchCheck, compareVersions, validateNativeUpdateFeed } =
  await import('../components/CoreUpdateLaunchCheck');
const { BannerHost } = await import('../components/notifications/BannerHost');
const { BANNER_PRIORITY, bannerStore } = await import(
  '../contexts/banner-store'
);

/**
 * Update state is chrome: it must reach the user through the shell's banner
 * slot, never through markup of its own. Rendering the real host here keeps
 * these assertions on what a user sees AND proves the routing.
 */
function renderWithChrome(node: React.ReactNode) {
  return render(
    <>
      {node}
      <BannerHost />
    </>,
  );
}

describe('CoreUpdateLaunchCheck', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    isMobile = false;
    desktopStatus = undefined;
    useCoreUpdateStatusQuery.mockClear();
    useCoreUpdateStatusQuery.mockImplementation(() => ({
      data: desktopStatus,
    }));
    bannerStore.clear();
  });

  afterEach(() => {
    bannerStore.clear();
  });

  test('stays silent on mobile when the build declares no update channel', async () => {
    isMobile = true;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderWithChrome(<CoreUpdateLaunchCheck feedUrl="" providerOrigin="" />);
    // A build without a feed has not failed a check. Reporting that state as
    // build identity is #2211; it must not raise an alert here.
    await waitFor(() => expect(fetchSpy).not.toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(bannerStore.getSnapshot()).toHaveLength(0);
  });

  test('presents a source update at launch and routes review to the truthful settings surface', async () => {
    desktopStatus = {
      updateAvailable: true,
      installKind: 'source-checkout',
      applyMethod: 'git-pull',
      behind: 3,
    };

    renderWithChrome(<CoreUpdateLaunchCheck apiBase="http://station.test" />);

    expect((await screen.findByRole('status')).textContent).toContain(
      'Station update available — 3 commits behind.',
    );
    expect(
      screen.getByRole('link', { name: 'Review update' }).getAttribute('href'),
    ).toBe('/settings?view=system&highlight=core-app-updates');
    expect(useCoreUpdateStatusQuery).toHaveBeenCalledWith(
      'http://station.test',
      expect.objectContaining({ enabled: true }),
    );
  });

  test('does not claim a reinstall-only bundle can apply from the banner', async () => {
    desktopStatus = {
      updateAvailable: true,
      installKind: 'desktop-bundle',
      applyMethod: 'reinstall',
      channel: 'nightly',
    };

    renderWithChrome(<CoreUpdateLaunchCheck apiBase="http://station.test" />);

    expect((await screen.findByRole('status')).textContent).toContain(
      'A Station nightly update is available.',
    );
    expect(screen.getByRole('link', { name: 'Review update' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Update Station' })).toBeNull();
  });

  test('desktop check stays quiet when the selected Station is current', () => {
    desktopStatus = { updateAvailable: false };
    renderWithChrome(<CoreUpdateLaunchCheck apiBase="http://station.test" />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  test('presents a genuine check failure through the banner slot', async () => {
    isMobile = true;
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    renderWithChrome(
      <CoreUpdateLaunchCheck
        feedUrl="https://updates.example.test/feed"
        providerOrigin="https://updates.example.test"
        installedVersion="1.0.0"
      />,
    );
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Update check failed');
    expect(alert.closest('.banner-host')).not.toBeNull();
    const [banner] = bannerStore.getSnapshot();
    // Reaching the host always outranks an update; the band proves it.
    expect(banner.priority).toBe(BANNER_PRIORITY.info);
    expect(banner.priority).toBeLessThan(BANNER_PRIORITY.connectionTransient);
    expect(banner.dismissible).toBe(true);
  });

  test('reads a provenance-pinned native app feed rather than the selected host', async () => {
    isMobile = true;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      url: 'https://updates.example.test/mobile/stable.json',
      json: async () => ({
        channel: 'stable',
        version: '1.2.3',
        releaseUrl: 'https://updates.example.test/releases/1.2.3',
      }),
    } as Response);
    renderWithChrome(
      <CoreUpdateLaunchCheck
        apiBase="https://station-host.example.test"
        feedUrl="https://updates.example.test/mobile/stable.json"
        providerOrigin="https://updates.example.test"
        installedVersion="1.2.3"
      />,
    );
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      'https://updates.example.test/mobile/stable.json',
    );
  });

  test('rejects non-HTTPS release actions', () => {
    expect(() =>
      validateNativeUpdateFeed(
        {
          channel: 'stable',
          version: '1.2.3',
          releaseUrl: 'http://downloads.example/app.apk',
        },
        'https://updates.example.test',
      ),
    ).toThrow(/must use HTTPS/);
  });

  test.each([
    ['1.2.3', '1.2.3', false],
    ['1.2.3', '1.2.4', true],
    ['1.2.3', '1.2.2', false],
  ])(
    'compares installed %s with latest %s',
    async (installedVersion, version, available) => {
      isMobile = true;
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        url: 'https://updates.example.test/mobile/stable.json',
        json: async () => ({
          channel: 'stable',
          version,
          releaseUrl: 'https://updates.example.test/releases/app',
        }),
      } as Response);
      renderWithChrome(
        <CoreUpdateLaunchCheck
          feedUrl="https://updates.example.test/mobile/stable.json"
          providerOrigin="https://updates.example.test/"
          installedVersion={installedVersion}
        />,
      );
      if (available)
        expect(
          await screen.findByRole('link', { name: 'Update Station' }),
        ).toBeTruthy();
      else
        await waitFor(() =>
          expect(
            screen.queryByRole('link', { name: 'Update Station' }),
          ).toBeNull(),
        );
    },
  );

  test('offers the update as an outbound link, not a scripted window open', async () => {
    isMobile = true;
    const openSpy = vi.spyOn(window, 'open');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      url: 'https://updates.example.test/feed',
      json: async () => ({
        channel: 'stable',
        version: '2.0.0',
        releaseUrl: 'https://updates.example.test/releases/2.0.0',
      }),
    } as Response);
    renderWithChrome(
      <CoreUpdateLaunchCheck
        feedUrl="https://updates.example.test/feed"
        providerOrigin="https://updates.example.test"
        installedVersion="1.0.0"
      />,
    );
    const link = await screen.findByRole('link', { name: 'Update Station' });
    // An Android WebView may ignore window.open('_blank'), which fails
    // silently on the one action the banner exists to offer.
    expect(link.getAttribute('href')).toBe(
      'https://updates.example.test/releases/2.0.0',
    );
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(openSpy).not.toHaveBeenCalled();
  });

  test('offers a retry after a failed check', async () => {
    isMobile = true;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        ok: true,
        url: 'https://updates.example.test/feed',
        json: async () => ({
          channel: 'stable',
          version: '2.0.0',
          releaseUrl: 'https://updates.example.test/app',
        }),
      } as Response);
    renderWithChrome(
      <CoreUpdateLaunchCheck
        feedUrl="https://updates.example.test/feed"
        providerOrigin="https://updates.example.test"
        installedVersion="1.0.0"
      />,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Retry update check' }),
    );
    expect(
      await screen.findByRole('link', { name: 'Update Station' }),
    ).toBeTruthy();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test('rejects redirected or cross-origin provider responses', async () => {
    isMobile = true;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      url: 'https://cdn.example.test/feed',
      json: async () => ({}),
    } as Response);
    renderWithChrome(
      <CoreUpdateLaunchCheck
        feedUrl="https://updates.example.test/feed"
        providerOrigin="https://updates.example.test/"
        installedVersion="1.0.0"
      />,
    );
    expect((await screen.findByRole('alert')).textContent).toContain(
      'not trusted',
    );
  });

  test.each([
    ['1.2.3-preview.2', '1.2.3-preview.10', -1],
    ['1.2.3-preview.10', '1.2.3', -1],
    ['1.2.3', '1.2.4-preview.1', -1],
    ['1.2.3', '1.2.3-preview.1', 1],
  ])('uses SemVer ordering for %s vs %s', (installed, latest, expected) => {
    expect(compareVersions(installed, latest)).toBe(expected);
  });

  test('does not probe in web or desktop shells', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderWithChrome(
      <CoreUpdateLaunchCheck
        feedUrl="https://updates.example.test/feed"
        providerOrigin="https://updates.example.test"
      />,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
