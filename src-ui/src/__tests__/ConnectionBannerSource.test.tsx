// @vitest-environment jsdom

import type { ConnectionFailureReason } from '@kontourai/station-connect';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionBannerSource } from '../components/notifications/ConnectionBannerSource';
import { StationDetailsHost } from '../components/notifications/StationConditions';
import { openStationDetails } from '../components/notifications/stationDetailsEvents';
import { bannerStore } from '../contexts/banner-store';
import {
  getStreamConnectionState,
  setStreamConnectionState,
} from '../hooks/orchestration/streamConnectionState';
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
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <ConnectionBannerSource />
      <StationDetailsHost />
    </QueryClientProvider>,
  );
  act(openStationDetails);
  return view;
}

async function findStationDetails(): Promise<HTMLElement> {
  return screen.findByRole('dialog', { name: 'Station details' });
}

beforeEach(() => {
  setStreamConnectionState('https://station.example.test', 'unknown');
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

it('known credential rejection also blocks chat recovery until an authenticated delivery', () => {
  connectionStatus.blocked = true;
  connectionStatus.reason = 'authentication-failed';
  renderChrome();
  expect(getStreamConnectionState('https://station.example.test').phase).toBe(
    'closed',
  );
  setStreamConnectionState('https://station.example.test', 'interrupted');
  expect(getStreamConnectionState('https://station.example.test').phase).toBe(
    'closed',
  );
  setStreamConnectionState('https://station.example.test', 'receiving');
  expect(getStreamConnectionState('https://station.example.test').phase).toBe(
    'receiving',
  );
});

afterEach(() => {
  bannerStore.reset();
});

describe('ConnectionBannerSource → Station details — version drift', () => {
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
    'host-unavailable',
    'busy',
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
        expect(screen.getByText('No additional Station notices.')).toBeTruthy(),
      );
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
        expect(screen.queryByText('No additional Station notices.')).toBeNull(),
      );
    },
  );

  it('offers exactly pairing and removal for an identity mismatch — no retry', async () => {
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

      const actions = within(await findStationDetails())
        .getAllByRole('button')
        .filter(
          (button) =>
            !['Close Station details', 'Manage Stations'].includes(
              button.getAttribute('aria-label') ?? button.textContent ?? '',
            ),
        );
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
        await vi.waitFor(
          () => screen.getByRole('dialog', { name: 'Station details' }),
          { timeout: 5000 },
        );

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
        // Pairing remains available while removal awaits confirmation.
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
        await vi.waitFor(
          () => screen.getByRole('dialog', { name: 'Station details' }),
          { timeout: 5000 },
        );

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
      await screen.findByRole('dialog', { name: 'Station details' });

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
      await screen.findByRole('dialog', { name: 'Station details' });

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
        await vi.waitFor(
          () => screen.getByRole('dialog', { name: 'Station details' }),
          { timeout: 5000 },
        );

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
  });

  it('renders the version-mismatch banner, with no retry affordance', async () => {
    connectionStatus.reason = 'unsupported-capability-version';

    renderChrome();

    await waitFor(() =>
      expect(
        screen.getByRole('dialog', { name: 'Station details' }).textContent,
      ).toMatch(/running incompatible versions/),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('dialog', { name: 'Station details' }).textContent,
      ).toMatch(/Upgrade Station on the host machine/),
    );
    expect(screen.queryByRole('button', { name: 'Try now' })).toBeNull();
    expect(
      screen.queryByText(/isn't the one this device paired with/),
    ).toBeNull();
  });

  it('tells the reader to update this app when the host refused its protocol (#2962)', async () => {
    activeConnection = {
      id: 'connection-1',
      name: 'Studio',
      url: 'https://station.example.test',
    };
    connectionStatus.reason = 'client-protocol-unsupported';
    connectionStatus.failureStreak = 1;

    renderChrome();

    const alert = await screen.findByRole('dialog', {
      name: 'Station details',
    });
    expect(alert.textContent).toContain(
      'Studio no longer supports this version of the app.',
    );
    // Not the host-side copy the handshake mismatch strip renders.
    expect(screen.queryByText(/running incompatible versions/)).toBeNull();
    expect((await findStationDetails()).textContent).toContain(
      'Install the latest Station app or CLI on this device',
    );
  });

  it('keeps a connection decision repairable in Station details', async () => {
    connectionStatus.reason = 'unexpected-response';
    connectionStatus.failureStreak = 1;

    renderChrome();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Try now' })).toBeTruthy(),
    );
    expect(screen.queryByText(/running incompatible versions/)).toBeNull();
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

    expect((await findStationDetails()).textContent).toMatch(
      /Use the host's IP address instead of localhost/,
    );
  });

  // station#2327: `busy` means the address ANSWERED, which is exactly what
  // the localhost advice assumes did not happen.
  it('does not offer localhost advice for a busy loopback Station', async () => {
    connectionStatus.reason = 'busy';
    connectionStatus.failureStreak = 3;
    activeConnection = {
      id: 'conn-1',
      name: 'Tailnet Station',
      url: 'http://localhost:3242',
    };

    renderChrome();

    await waitFor(() =>
      expect(screen.getByText('No additional Station notices.')).toBeTruthy(),
    );
  });

  it('keeps a same-origin browser restart transient instead of asking for another address', async () => {
    connectionStatus.reason = 'timeout';
    connectionStatus.failureStreak = 4;
    activeConnection = {
      id: 'conn-1',
      name: 'This Station',
      url: window.location.origin,
    };

    renderChrome();

    await waitFor(() =>
      expect(screen.getByText('No additional Station notices.')).toBeTruthy(),
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

    await waitFor(() =>
      expect(screen.getByText('No additional Station notices.')).toBeTruthy(),
    );
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
    await waitFor(() =>
      expect(screen.getByText('No additional Station notices.')).toBeTruthy(),
    );
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

    expect((await findStationDetails()).textContent).toMatch(
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

    expect((await findStationDetails()).textContent).toMatch(
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

    await waitFor(() =>
      expect(screen.getByText('No additional Station notices.')).toBeTruthy(),
    );
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
      expect(screen.getByText('No additional Station notices.')).toBeTruthy(),
    );
  });

  // This suite keeps the real connectionFailureCopy implementation via
  // importOriginal above. Calling it with awaiting-approval would throw because
  // that reason deliberately has no failure-copy entry, so a passing render
  // proves the guard remains in front of the real function.
  it('renders nothing for a healthy host awaiting approval', async () => {
    connectionStatus.reason = 'awaiting-approval';

    renderChrome();

    await waitFor(() =>
      expect(screen.getByText('No additional Station notices.')).toBeTruthy(),
    );
  });
});

describe('ConnectionBannerSource → Station details — blocked credential', () => {
  it('explains paused automatic retry and keeps credential repair available', async () => {
    connectionStatus.reason = 'authentication-failed';
    connectionStatus.blocked = true;

    renderChrome();

    const alert = await screen.findByRole('dialog', {
      name: 'Station details',
    });
    expect(
      within(alert).getByRole('region', { name: 'Approval needed' }),
    ).toBeTruthy();
    expect((await findStationDetails()).textContent).toMatch(
      /Automatic reconnect is paused/,
    );
    expect(screen.getByRole('button', { name: 'Try now' })).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Dismiss connection notice' }),
    ).toBeNull();
  });

  it('does not claim automatic retry is paused for a non-credential decision', async () => {
    connectionStatus.reason = 'unexpected-response';
    connectionStatus.failureStreak = 1;
    connectionStatus.blocked = false;

    renderChrome();

    const alert = await screen.findByRole('dialog', {
      name: 'Station details',
    });
    expect(
      within(alert).queryByRole('region', { name: 'Approval needed' }),
    ).toBeNull();
    expect((await findStationDetails()).textContent).not.toMatch(
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

      const actions = within(await findStationDetails())
        .getAllByRole('button')
        .filter(
          (button) =>
            !['Close Station details', 'Manage Stations'].includes(
              button.getAttribute('aria-label') ?? button.textContent ?? '',
            ),
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

    const alert = await screen.findByRole('dialog', {
      name: 'Station details',
    });
    // The exact string a phone was shown while its host answered 401.
    expect(alert.textContent).not.toMatch(
      /off, asleep, or on another network|Can't reach/,
    );
    expect(alert.textContent).toMatch(
      /Tailnet Station isn't accepting this device/,
    );
  });
});
