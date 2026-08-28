// @vitest-environment jsdom

import type { ConnectionFailureReason } from '@kontourai/station-connect';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BannerHost } from '../components/notifications/BannerHost';
import { ConnectionBannerSource } from '../components/notifications/ConnectionBannerSource';
import { BANNER_IDS, bannerStore } from '../contexts/banner-store';
import type { PlatformProfile } from '../platform/PlatformProfileContext';

const connectionStatus = {
  status: 'error' as 'error' | 'connected',
  reason: null as ConnectionFailureReason | null,
  failureStreak: 0,
  blocked: false,
  recheck: vi.fn(),
};
const removeConnection = vi.fn();
let activeConnection: {
  id: string;
  credentialState?: 'required';
  lastSuccessAt?: number;
  name: string;
  url: string;
} | null = null;
let platformProfile: PlatformProfile = {
  isTauri: false,
  target: 'web' as const,
  isMobile: false,
  isDesktop: false,
  supervisesBundledServer: false,
  isDevBuild: false,
};

vi.mock('@kontourai/station-connect', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@kontourai/station-connect')>();
  return {
    ...actual,
    useConnections: () => ({
      apiBase: 'https://station.example.test',
      activeConnection,
      removeConnection,
    }),
    useConnectionStatus: () => connectionStatus,
  };
});

vi.mock('../lib/serverHealth', () => ({
  checkServerHealth: vi.fn(),
  probeServerConnection: vi.fn(),
}));

vi.mock('../lib/compatibility', () => ({
  checkHostCompatibility: vi.fn(async () => ({
    verdict: 'server-too-old',
    blocking: true,
    reason: 'Update the Station host. Upgrade Station on the host machine.',
    serverVersion: '0.1.0',
  })),
}));

vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => platformProfile,
}));

function renderChrome() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ConnectionBannerSource />
      <BannerHost />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  globalThis.localStorage.clear();
  activeConnection = null;
  platformProfile = {
    isTauri: false,
    target: 'web',
    isMobile: false,
    isDesktop: false,
    supervisesBundledServer: false,
    isDevBuild: false,
  };
  connectionStatus.status = 'error';
  connectionStatus.reason = null;
  connectionStatus.failureStreak = 0;
  connectionStatus.blocked = false;
  connectionStatus.recheck.mockReset();
  removeConnection.mockReset();
  bannerStore.reset();
});

afterEach(() => {
  bannerStore.reset();
});

describe('ConnectionBannerSource → BannerHost — version drift', () => {
  /**
   * archive#3297 — transient reachability never banners.
   *
   * The owner's words: "kinda getting tired of the big banners for offline —
   * need more subtle yet noticeable UI... or better use the connection
   * indicator". A remote host that is briefly not answering needs no decision
   * from anyone; the indicator carries it and costs no vertical space.
   */
  it.each([
    'unreachable',
    'timeout',
    'undetermined',
    'offline',
    'server-restarted',
  ] as const)(
    'never banners a transient %s failure, however long it lasts',
    async (reason) => {
      connectionStatus.reason = reason;
      // Well past the old 3-probe threshold: duration is not what made the
      // old rule fire wrongly, the reason was.
      connectionStatus.failureStreak = 12;
      activeConnection = {
        id: 'conn-1',
        name: 'Tailnet Station',
        url: 'https://station.example.test',
      };

      renderChrome();

      await waitFor(() =>
        expect(
          document.querySelector(`[data-banner-id="${BANNER_IDS.offline}"]`),
        ).toBeNull(),
      );
      expect(screen.queryByRole('alert')).toBeNull();
    },
  );

  it.each([
    'identity-mismatch',
    'origin-not-allowed',
    'unexpected-response',
    'mixed-content',
  ] as const)(
    'banners %s on the first probe, because it needs a decision',
    async (reason) => {
      // No streak at all: a decision does not get more true by being repeated,
      // and withholding it is withholding the one thing the reader can act on.
      connectionStatus.reason = reason;
      connectionStatus.failureStreak = 1;
      activeConnection = {
        id: 'conn-1',
        name: 'Tailnet Station',
        url: 'https://station.example.test',
      };

      renderChrome();

      await waitFor(() =>
        expect(
          document.querySelector(`[data-banner-id="${BANNER_IDS.offline}"]`),
        ).not.toBeNull(),
      );
    },
  );

  it('collapses a decision to one line, with the remedy a tap away', async () => {
    connectionStatus.reason = 'identity-mismatch';
    connectionStatus.failureStreak = 1;
    activeConnection = {
      id: 'conn-1',
      name: 'Tailnet Station',
      url: 'https://station.example.test',
    };

    renderChrome();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/isn't the one this device paired with/);
    // The remedy is NOT on the visible line.
    expect(alert.textContent).not.toMatch(/may have been reset or reinstalled/);

    // archive#4470b: the toggle's own label no longer
    // encodes expanded/collapsed state ("More"/"Less" read as a second
    // collapse affordance beside the card's own chevron) — it stays
    // "Details" throughout, and `aria-expanded` alone carries the state.
    const details = screen.getByRole('button', { name: 'Details' });
    expect(details.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(details);

    expect((await screen.findByRole('alert')).textContent).toMatch(
      /may have been reset or reinstalled/,
    );
    expect(
      screen
        .getByRole('button', { name: 'Details' })
        .getAttribute('aria-expanded'),
    ).toBe('true');
  });

  /**
   * archive#4470d — the pairing-identity-mismatch banner's own detail text
   * ("Pair again, or remove this connection") named two remedies the CTA row
   * never offered: the only action was "Try now", which cannot recover a
   * host whose identity genuinely changed. Every action the banner renders
   * must actually perform what it is named for — a dead "Pair again" would
   * be worse than "Try now" — so this asserts each one drives the real
   * mechanism (the same pairing-flow event `authentication-failed` above
   * uses, and the same `removeConnection` primitive the connections modal's
   * own remove control calls), not just that a click handler exists.
   */
  it('offers exactly pairing and removal for an identity mismatch — no retry', async () => {
    // archive#4470: a third action ("Try now") does not
    // fit this banner collapsed at 390px (BannerHost.collapsed-controls
    // test proves it against the real, cascade-resolved layout); the owner
    // named exactly two remedies for this reason, so retry is dropped
    // entirely rather than demoted to a tertiary.
    connectionStatus.reason = 'identity-mismatch';
    connectionStatus.failureStreak = 1;
    activeConnection = {
      id: 'conn-mismatched',
      name: 'Tailnet Station',
      url: 'https://station.example.test',
    };
    const opened: unknown[] = [];
    const listener = (event: Event) =>
      opened.push(event instanceof CustomEvent ? event.detail : null);
    window.addEventListener('station:open-connections-modal', listener);
    try {
      renderChrome();

      const alert = await screen.findByRole('alert');
      const actions = alert.querySelectorAll('.banner-host__action');
      // Visible text stays short ("Remove"); the accessible name is
      // the full sentence, asserted via `getByRole` below.
      expect([...actions].map((node) => node.textContent)).toEqual([
        'Pair again',
        'Remove',
      ]);
      expect(screen.queryByRole('button', { name: 'Try now' })).toBeNull();
      expect(
        screen.getByRole('button', { name: 'Remove connection' }),
      ).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Pair again' }));
      expect(opened).toEqual([{ mode: 'request-access' }]);
      expect(removeConnection).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('station:open-connections-modal', listener);
    }
  });

  /**
   * archive#4470 + : removing the
   * active connection is destructive, so it takes two deliberate taps — the
   * same MECHANISM PairedDeviceList.tsx's inline revoke confirm already
   * uses: an explicit Confirm and an explicit Cancel (not just a relabeled
   * single button), which only ever render once the banner is force-
   * expanded (so the confirm is never hidden behind a collapsed 52px bar).
   * A second tap within the arm-debounce window is ignored, not treated as
   * the confirming tap.
   */
  describe('the two-step "Remove" confirm', () => {
    beforeEach(() => {
      connectionStatus.reason = 'identity-mismatch';
      connectionStatus.failureStreak = 1;
      activeConnection = {
        id: 'conn-mismatched',
        name: 'Tailnet Station',
        url: 'https://station.example.test',
      };
    });

    it('arms on the first tap (Confirm + Cancel, full accessible names) and removes after the debounce window', async () => {
      vi.useFakeTimers();
      try {
        renderChrome();
        await vi.waitFor(() => screen.getByRole('alert'), { timeout: 5000 });

        fireEvent.click(
          screen.getByRole('button', { name: 'Remove connection' }),
        );
        expect(removeConnection).not.toHaveBeenCalled();
        expect(
          screen.queryByRole('button', { name: 'Remove connection' }),
        ).toBeNull();
        const confirmButton = screen.getByRole('button', {
          name: 'Confirm removing this connection',
        });
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
        // "Pair again" survives armed — three actions, all reachable, since
        // arming only ever presents this row expanded.
        expect(screen.getByRole('button', { name: 'Pair again' })).toBeTruthy();

        act(() => {
          vi.advanceTimersByTime(301);
        });
        fireEvent.click(confirmButton);
        expect(removeConnection).toHaveBeenCalledTimes(1);
        expect(removeConnection).toHaveBeenCalledWith('conn-mismatched');
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * a fast double-tap on the same screen location must arm, not
     * arm-then-remove in one gesture: the second (synthetic) tap lands on
     * "Confirm" where "Remove" used to be, within the debounce window.
     */
    it('ignores a confirm tap within 300ms of arming, then removes a later one', async () => {
      vi.useFakeTimers();
      try {
        renderChrome();
        await vi.waitFor(() => screen.getByRole('alert'), { timeout: 5000 });

        fireEvent.click(
          screen.getByRole('button', { name: 'Remove connection' }),
        );
        const confirmButton = screen.getByRole('button', {
          name: 'Confirm removing this connection',
        });

        // Tap 1: within the debounce window (no time advanced at all).
        fireEvent.click(confirmButton);
        expect(removeConnection).not.toHaveBeenCalled();
        expect(
          screen.getByRole('button', {
            name: 'Confirm removing this connection',
          }),
        ).toBeTruthy();

        // Tap 2: within the window, but close to its edge.
        act(() => {
          vi.advanceTimersByTime(200);
        });
        fireEvent.click(
          screen.getByRole('button', {
            name: 'Confirm removing this connection',
          }),
        );
        expect(removeConnection).not.toHaveBeenCalled();

        // Tap 3: past the window — a deliberate, separate confirming tap.
        act(() => {
          vi.advanceTimersByTime(101);
        });
        fireEvent.click(
          screen.getByRole('button', {
            name: 'Confirm removing this connection',
          }),
        );
        expect(removeConnection).toHaveBeenCalledTimes(1);
        expect(removeConnection).toHaveBeenCalledWith('conn-mismatched');
      } finally {
        vi.useRealTimers();
      }
    });

    it('Cancel disarms without removing', async () => {
      renderChrome();
      await screen.findByRole('alert');

      fireEvent.click(
        screen.getByRole('button', { name: 'Remove connection' }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(
        screen.getByRole('button', { name: 'Remove connection' }),
      ).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
      expect(removeConnection).not.toHaveBeenCalled();
    });

    it('disarms on blur without removing', async () => {
      renderChrome();
      await screen.findByRole('alert');

      fireEvent.click(
        screen.getByRole('button', { name: 'Remove connection' }),
      );
      const confirmButton = screen.getByRole('button', {
        name: 'Confirm removing this connection',
      });
      fireEvent.blur(confirmButton);

      expect(
        screen.getByRole('button', { name: 'Remove connection' }),
      ).toBeTruthy();
      expect(removeConnection).not.toHaveBeenCalled();
    });

    it('disarms after a timeout without removing', async () => {
      vi.useFakeTimers();
      try {
        renderChrome();
        await vi.waitFor(() => screen.getByRole('alert'), { timeout: 5000 });

        fireEvent.click(
          screen.getByRole('button', { name: 'Remove connection' }),
        );
        expect(
          screen.getByRole('button', {
            name: 'Confirm removing this connection',
          }),
        ).toBeTruthy();

        act(() => {
          vi.advanceTimersByTime(5_000);
        });

        expect(
          screen.getByRole('button', { name: 'Remove connection' }),
        ).toBeTruthy();
        expect(removeConnection).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * (a) — an armed confirm has to stay VISIBLE to be cancellable. A
     * collapsed banner still renders its actions row (archive#4470), so
     * arming from collapsed force-expands the card; Cancel restores
     * collapsed since arming is what changed it.
     */
    it('force-expands a collapsed banner on arm, and restores collapsed on cancel', async () => {
      renderChrome();
      const alert = await screen.findByRole('alert');

      fireEvent.click(screen.getByRole('button', { name: 'Collapse notice' }));
      expect(alert.className).toMatch(/banner-host__item--collapsed/);

      fireEvent.click(
        screen.getByRole('button', { name: 'Remove connection' }),
      );
      expect(alert.className).not.toMatch(/banner-host__item--collapsed/);

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(alert.className).toMatch(/banner-host__item--collapsed/);
      expect(removeConnection).not.toHaveBeenCalled();
    });

    it('does not collapse an already-expanded banner when the confirm is cancelled', async () => {
      renderChrome();
      const alert = await screen.findByRole('alert');
      expect(alert.className).not.toMatch(/banner-host__item--collapsed/);

      fireEvent.click(
        screen.getByRole('button', { name: 'Remove connection' }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(alert.className).not.toMatch(/banner-host__item--collapsed/);
    });

    /**
     * archive#4470 — the collapse chevron was gated only
     * on the card's exit animation (BannerHost.tsx), never on this banner's
     * armed state. Arming from an already-EXPANDED banner leaves
     * `forcedExpandRef` false (arming did not need to force anything open),
     * so nothing in the previous round stopped a reader from then tapping
     * the chevron and landing the three-action armed row COLLAPSED — the
     * exact overflow (message clipped to 0px, Cancel/dismiss pushed
     * outside the clipped card) this whole feature exists to avoid, live
     * for up to the 5s auto-disarm. Collapsing while armed now disarms:
     * the reader lands on the safe, established two-action collapsed shape
     * instead.
     */
    it('disarms (rather than staying armed-and-collapsed) when the chevron collapses an armed, already-expanded banner', async () => {
      renderChrome();
      const alert = await screen.findByRole('alert');
      expect(alert.className).not.toMatch(/banner-host__item--collapsed/);

      fireEvent.click(
        screen.getByRole('button', { name: 'Remove connection' }),
      );
      expect(
        screen.getByRole('button', {
          name: 'Confirm removing this connection',
        }),
      ).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Collapse notice' }));

      expect(alert.className).toMatch(/banner-host__item--collapsed/);
      expect(
        screen.queryByRole('button', {
          name: 'Confirm removing this connection',
        }),
      ).toBeNull();
      expect(
        screen.getByRole('button', { name: 'Remove connection' }),
      ).toBeTruthy();
      expect(removeConnection).not.toHaveBeenCalled();
    });
  });

  it('occupies no space until there is something to say', () => {
    // This previously asserted the opposite — that the rail stays mounted and
    // empty — which is the behavior that pushed project and chat content down
    // by 104px on mobile (archive#2268). The rail was justified as keeping the
    // header's touch targets stable, but the header is a separate preceding
    // row and never moved.
    const { container } = render(<BannerHost connectionSlot />);

    expect(screen.queryByTestId('banner-host')).toBeNull();
    expect(container.firstChild).toBeNull();

    act(() => {
      bannerStore.present({
        id: 'test:connection-rail',
        priority: 1,
        tone: 'info',
        message: 'Connection status is available.',
      });
    });

    const rail = screen.getByTestId('banner-host');
    expect(rail.className).toMatch(/banner-host--connection-slot/);
    expect(screen.getByText('Connection status is available.')).toBeTruthy();

    act(() => {
      bannerStore.clear();
    });

    // And it goes away again rather than leaving the rail behind.
    expect(screen.queryByTestId('banner-host')).toBeNull();
  });

  it('renders the version-mismatch banner, with no retry affordance', async () => {
    connectionStatus.reason = 'unsupported-capability-version';

    renderChrome();

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(
        /running incompatible versions/,
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(
        /Upgrade Station on the host machine/,
      ),
    );
    expect(
      document.querySelector(`[data-banner-id="${BANNER_IDS.compat}"]`),
    ).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Try now' })).toBeNull();
    expect(
      document.querySelector(`[data-banner-id="${BANNER_IDS.offline}"]`),
    ).toBeNull();
  });

  it('keeps a decision banner dismissible, retryable and swipeable', async () => {
    connectionStatus.reason = 'unexpected-response';
    connectionStatus.failureStreak = 1;

    renderChrome();

    await waitFor(() =>
      expect(
        document.querySelector(`[data-banner-id="${BANNER_IDS.offline}"]`),
      ).not.toBeNull(),
    );
    expect(
      document.querySelector(`[data-banner-id="${BANNER_IDS.compat}"]`),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Dismiss connection notice' }),
    ).toBeTruthy();
    expect(screen.getByRole('alert').dataset.swipeDismissible).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Try now' }));
    expect(connectionStatus.recheck).toHaveBeenCalledOnce();
  });

  /**
   * The one reachability failure that IS a decision: a loopback address
   * reached from something other than the machine hosting it can never
   * resolve, so retrying is not a remedy and a different address is. The
   * 3-probe streak still gates it (archive#2630), which is what keeps it off a dev
   * server that is merely restarting.
   */
  it('still banners a loopback address that cannot resolve from here', async () => {
    connectionStatus.reason = 'unreachable';
    connectionStatus.failureStreak = 3;
    activeConnection = {
      id: 'conn-1',
      name: 'Tailnet Station',
      url: 'http://localhost:3242',
    };

    renderChrome();

    fireEvent.click(await screen.findByRole('button', { name: 'Details' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Use the host's IP address instead of localhost/,
    );
  });

  it('withholds it until the same sustained streak the old rule required', async () => {
    connectionStatus.reason = 'unreachable';
    connectionStatus.failureStreak = 2;
    activeConnection = {
      id: 'conn-1',
      name: 'Tailnet Station',
      url: 'http://localhost:3242',
    };

    renderChrome();

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('does not offer localhost advice from the Tauri desktop shell', async () => {
    platformProfile = {
      isTauri: true,
      target: 'macos',
      isMobile: false,
      isDesktop: true,
      supervisesBundledServer: true,
      isDevBuild: false,
    };
    connectionStatus.reason = 'unreachable';
    connectionStatus.failureStreak = 3;
    activeConnection = {
      id: 'conn-1',
      name: 'Bundled Station',
      url: 'http://localhost:3242',
    };

    renderChrome();

    // On the machine that hosts it, loopback is the correct address and this
    // is an ordinary outage — so there is nothing to decide, and no banner.
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('keeps the loopback decision for a native mobile client', async () => {
    platformProfile = {
      isTauri: true,
      target: 'android',
      isMobile: true,
      isDesktop: false,
      supervisesBundledServer: false,
      isDevBuild: false,
    };
    connectionStatus.reason = 'unreachable';
    connectionStatus.failureStreak = 3;
    activeConnection = {
      id: 'conn-1',
      name: 'Tailnet Station',
      url: 'http://localhost:3242',
    };

    renderChrome();

    fireEvent.click(await screen.findByRole('button', { name: 'Details' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Use the host's IP address instead of localhost/,
    );
  });

  it('recognizes the full IPv4 loopback range', async () => {
    connectionStatus.reason = 'unreachable';
    connectionStatus.failureStreak = 3;
    activeConnection = {
      id: 'conn-1',
      name: 'Tailnet Station',
      url: 'http://127.0.0.2:3242',
    };

    renderChrome();

    fireEvent.click(await screen.findByRole('button', { name: 'Details' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Use the host's IP address instead of localhost/,
    );
  });

  it('does not mistake a DNS name beginning with 127 for loopback', async () => {
    // The discrimination this pins is now stronger than it was: getting it
    // wrong no longer just adds a stray sentence, it invents a whole banner
    // for an ordinary outage.
    connectionStatus.reason = 'unreachable';
    connectionStatus.failureStreak = 3;
    activeConnection = {
      id: 'conn-1',
      name: 'Tailnet Station',
      url: 'https://127.example.test',
    };

    renderChrome();

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('suppresses generic offline copy while a persisted pairing request awaits approval', async () => {
    connectionStatus.reason = 'unreachable';
    connectionStatus.failureStreak = 3;
    activeConnection = {
      id: 'conn-1',
      name: 'Tailnet Station',
      url: 'http://localhost:3242',
    };
    const now = Date.now();
    globalThis.localStorage.setItem(
      'station-pairing-pending-exchange:v1:http://localhost:3242:direct',
      JSON.stringify({
        endpoint: 'http://localhost:3242',
        offerId: 'offer-1',
        proof: 'proof-1',
        requestId: 'request-1',
        requestedAt: now - 60_000,
        expiresAt: now + 240_000,
        browserSession: false,
        requestKind: 'direct',
      }),
    );

    renderChrome();

    await waitFor(() =>
      expect(
        document.querySelector(`[data-banner-id="${BANNER_IDS.offline}"]`),
      ).toBeNull(),
    );
  });

  // This suite keeps the real connectionFailureCopy implementation via
  // importOriginal above. Calling it with awaiting-approval would throw because
  // that reason deliberately has no failure-copy entry, so a passing render
  // proves the guard remains in front of the real function.
  it('renders nothing for a healthy host awaiting approval', async () => {
    connectionStatus.reason = 'awaiting-approval';

    renderChrome();

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});

describe('ConnectionBannerSource → BannerHost — blocked credential', () => {
  it('marks the banner as blocked and explains automatic retry is paused', async () => {
    connectionStatus.reason = 'authentication-failed';
    connectionStatus.blocked = true;

    renderChrome();

    const alert = await screen.findByRole('alert');
    expect(alert.className).toMatch(/banner-host__item--blocked/);
    expect(alert.textContent).toMatch(/Credential required/);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Automatic reconnect is paused/,
    );
    expect(screen.getByRole('button', { name: 'Try now' })).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Dismiss connection notice' }),
    ).toBeNull();
    expect(alert.dataset.swipeDismissible).toBeUndefined();
  });

  it('does not mark the banner as blocked for a non-credential decision', async () => {
    connectionStatus.reason = 'unexpected-response';
    connectionStatus.failureStreak = 1;
    connectionStatus.blocked = false;

    renderChrome();

    const alert = await screen.findByRole('alert');
    expect(alert.className).not.toMatch(/banner-host__item--blocked/);
    expect(alert.textContent).not.toMatch(/Credential required/);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect((await screen.findByRole('alert')).textContent).not.toMatch(
      /Automatic reconnect is paused/,
    );
  });

  /**
   * archive#3297 — the remedy, offered. "Try now" was the only action
   * on a rejected credential, and it is the one thing that provably cannot
   * fix one.
   */
  it('offers pairing first for a rejected credential, and recheck second', async () => {
    connectionStatus.reason = 'authentication-failed';
    connectionStatus.blocked = true;
    const opened: unknown[] = [];
    const listener = (event: Event) =>
      opened.push(event instanceof CustomEvent ? event.detail : null);
    window.addEventListener('station:open-connections-modal', listener);
    try {
      renderChrome();

      const actions = (await screen.findByRole('alert')).querySelectorAll(
        '.banner-host__action',
      );
      expect([...actions].map((node) => node.textContent)).toEqual([
        'Pair again',
        'Try now',
      ]);
      fireEvent.click(screen.getByRole('button', { name: 'Pair again' }));
      expect(opened).toEqual([{ mode: 'request-access' }]);
    } finally {
      window.removeEventListener('station:open-connections-modal', listener);
    }
  });

  it('says nothing about the network for a rejected credential', async () => {
    connectionStatus.reason = 'authentication-failed';
    connectionStatus.blocked = true;
    activeConnection = {
      id: 'conn-1',
      name: 'Tailnet Station',
      url: 'https://kontour.example.ts.net',
    };

    renderChrome();

    const alert = await screen.findByRole('alert');
    // The exact string a phone was shown while its host answered 401.
    expect(alert.textContent).not.toMatch(
      /off, asleep, or on another network|Can't reach/,
    );
    expect(alert.textContent).toMatch(
      /Tailnet Station isn't accepting this device/,
    );
  });
});
