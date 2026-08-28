// @vitest-environment jsdom

import { pairingScopePresetString } from '@kontourai/station-contracts';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  encodeDevicePairingPayload,
  loadPendingExchange,
  type PendingPairingExchange,
  savePendingExchange,
  setNativePairingExchangeTransport,
} from '../core/devicePairing';
import {
  HostDevicePairingPanel,
  JoinDevicePairingPanel,
} from '../react/DevicePairingPanel';

vi.mock('qrcode', () => ({
  toCanvas: vi.fn(async () => undefined),
}));

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

afterEach(() => {
  setNativePairingExchangeTransport();
  vi.restoreAllMocks();
  vi.useRealTimers();
  // station#1711 Copy-button tests stub these directly on the shared jsdom
  // globals (not via vi.stubGlobal/spyOn), so restore them explicitly.
  Reflect.deleteProperty(navigator, 'clipboard');
  Reflect.deleteProperty(document, 'execCommand');
  // station#1711 — `savePendingExchange` writes to the real jsdom
  // `localStorage`, which persists across tests within this file (unlike
  // the fake-storage-map fixtures `devicePairing.test.ts` uses). Without
  // this, a pending exchange saved by one test restores itself at the start
  // of the next test that happens to reuse the same origin.
  localStorage.clear();
});

describe('device pairing panels', () => {
  test('reviews a supplied pairing payload before it sends an access request', async () => {
    const payload = encodeDevicePairingPayload({
      protocolVersion: 1,
      environmentId: 'environment-link',
      offerId: 'offer-link',
      challenge: 'challenge-link',
      manualCode: 'ABCDE12345',
      endpoint: 'https://station.example.ts.net',
      scope: 'orchestration:read',
      expiresAt: Date.now() + 60_000,
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      response({
        requestId: 'request-link',
        offerId: 'offer-link',
        deviceName: 'This browser',
        scope: 'station:interactive',
        createdAt: Date.now(),
        status: 'pending',
      }),
    );

    render(
      <JoinDevicePairingPanel
        initialPairingPayload={payload}
        onPaired={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText('Review pairing offer')).toBeTruthy();
    expect(screen.getByText('Backend environment identity')).toBeTruthy();
    expect(screen.getByText('environment-link')).toBeTruthy();
    expect(screen.getByText('Endpoint')).toBeTruthy();
    expect(screen.getByText('https://station.example.ts.net')).toBeTruthy();
    expect(screen.getByText('Expires at')).toBeTruthy();
    expect(screen.queryByLabelText('Pairing client channel')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      'https://station.example.ts.net/.well-known/station/v1/pairing/request',
    );
  });

  test('keeps a same-origin access request pending until explicit authority approves it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      response(
        {
          environmentId: 'environment-loopback',
          offerId: 'pending-offer',
          proof: 'pending-proof',
          requestId: 'pending-request',
          expiresAt: Date.now() + 60_000,
        },
        202,
      ),
    );
    const onPaired = vi.fn();
    const onApprovalPending = vi.fn();
    render(
      <JoinDevicePairingPanel
        initialMode="direct"
        onPaired={onPaired}
        onCancel={vi.fn()}
        onApprovalPending={onApprovalPending}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));

    await waitFor(() => expect(onApprovalPending).toHaveBeenCalledOnce());
    expect(onApprovalPending).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: window.location.origin,
        requestId: 'pending-request',
        requestKind: 'direct',
      }),
    );
    expect(onPaired).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('pending-proof');
  });

  test('hands a submitted request to persistent connection chrome without exposing a credential', async () => {
    const onApprovalPending = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      response(
        {
          environmentId: 'environment-direct',
          offerId: 'offer-direct',
          proof: 'proof-direct',
          requestId: 'request-direct',
          expiresAt: Date.now() + 60_000,
        },
        202,
      ),
    );

    render(
      <JoinDevicePairingPanel
        initialMode="direct"
        onPaired={vi.fn()}
        onCancel={vi.fn()}
        onApprovalPending={onApprovalPending}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));

    await waitFor(() =>
      expect(onApprovalPending).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: window.location.origin,
          requestId: 'request-direct',
          requestKind: 'direct',
        }),
      ),
    );
    expect(document.body.textContent).not.toContain('proof-direct');
  });

  test('exposes the selected pairing method to assistive technology', () => {
    render(<JoinDevicePairingPanel onPaired={vi.fn()} onCancel={vi.fn()} />);

    const scan = screen.getByRole('button', { name: 'Scan code' });
    const manual = screen.getByRole('button', { name: 'Enter manually' });
    expect(scan.getAttribute('aria-pressed')).toBe('true');
    expect(manual.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(manual);
    expect(scan.getAttribute('aria-pressed')).toBe('false');
    expect(manual.getAttribute('aria-pressed')).toBe('true');
  });

  test('aborts an in-flight native exchange when the panel unmounts', async () => {
    let exchangeSignal: AbortSignal | undefined;
    setNativePairingExchangeTransport(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          exchangeSignal = signal;
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      response(
        {
          environmentId: 'environment-direct',
          offerId: 'offer-direct',
          proof: 'proof-direct',
          requestId: 'request-direct',
          expiresAt: Date.now() + 60_000,
        },
        202,
      ),
    );
    const { unmount } = render(
      <JoinDevicePairingPanel
        initialMode="direct"
        onPaired={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));
    expect(
      await screen.findByText('Waiting for approval on this Station…'),
    ).toBeTruthy();
    await waitFor(() => expect(exchangeSignal).toBeDefined());

    unmount();
    expect(exchangeSignal?.aborted).toBe(true);
  });

  /**
   * station#1711 — the release blocker. Root cause: the pending exchange was
   * component-local `useState`, discarded on every unmount. Approval is
   * asynchronous and human-paced — the operator goes to a terminal or
   * another device to approve — so closing this panel, navigating away, or
   * the app being backgrounded/killed left `offerId`/`proof`/`requestId`
   * unrecoverable. The host request then sat `confirmed` forever with
   * nothing left to exchange it: eight approved-but-deviceless requests on
   * desktop, one on mobile, all this one shape.
   *
   * UNMOUNTING IS THE POINT. A test that keeps the panel mounted across the
   * external confirm passes on today's (unfixed) code too and proves
   * nothing — this one drives request → unmount → external confirm →
   * remount → exchange, and asserts a device is registered (`onPaired`
   * fires) with no further user action after remount.
   */
  test('an approved request survives an unmount and still registers a device on remount (station#1711)', async () => {
    let confirmedByTheHost = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/.well-known/station/v1/pairing/access-request') {
        return response(
          {
            offerId: 'offer-1711',
            proof: 'proof-1711',
            requestId: 'request-1711',
            expiresAt: Date.now() + 5 * 60_000,
            environmentId: 'environment-1711',
          },
          202,
        );
      }
      if (path === '/.well-known/station/v1/pairing/exchange') {
        // Mirrors the real server: `request_not_confirmed` (409) until an
        // operator confirms the request out of band, exactly as it would
        // sit while this panel is unmounted below.
        if (!confirmedByTheHost) {
          return response({ error: 'request_not_confirmed' }, 409);
        }
        return response({
          environmentId: 'environment-1711',
          device: {
            id: 'device-1711',
            name: 'Pixel 10 Pro XL · Station',
            scope: 'station:interactive',
            createdAt: Date.now(),
            revokedAt: null,
          },
          credential: 'issued-credential-1711',
        });
      }
      throw new Error(`unexpected fetch to ${path}`);
    });

    const onPaired = vi.fn();
    const panelProps = {
      initialMode: 'direct' as const,
      directEndpoint: 'https://station.example.test',
      directLabel: 'Kontour',
      onPaired,
      onCancel: vi.fn(),
    };
    const { unmount } = render(<JoinDevicePairingPanel {...panelProps} />);

    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));
    expect(
      await screen.findByText('Waiting for approval on Kontour…'),
    ).toBeTruthy();

    // The point: unmount exactly as closing the panel, navigating away, or
    // the app being backgrounded/killed would.
    unmount();
    expect(onPaired).not.toHaveBeenCalled();

    // External confirm — the host approves this request while nothing from
    // this app is mounted anywhere to see it happen.
    confirmedByTheHost = true;

    // Remount with the same target. No click, no re-entered code: on
    // unfixed code `pending` starts `null` again and nothing resumes.
    render(<JoinDevicePairingPanel {...panelProps} />);

    // The restored panel picks the already-approved request straight back
    // up, without the user doing anything else.
    expect(
      await screen.findByText('Waiting for approval on Kontour…'),
    ).toBeTruthy();
    await waitFor(() => expect(onPaired).toHaveBeenCalledOnce(), {
      timeout: 5_000,
    });
    expect(onPaired).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'https://station.example.test',
        device: expect.objectContaining({ id: 'device-1711' }),
      }),
    );
  });

  /**
   * station#1711 review (HIGH) — `pendingExchangeStorageKey` used to be
   * origin-only, so a panel mounted in scan mode at the same origin as an
   * abandoned direct request-access flow computed the identical storage key
   * and restored a record it never created: showing "Waiting for approval…"
   * for a request the scan panel had nothing to do with, and deleting that
   * other flow's still-valid record if the user clicked "Stop waiting"
   * there. This mirrored exactly how `ConnectionManagerModalContent` mounts
   * the 'pair-device' panel — no `directEndpoint`, no explicit
   * `originIsStation` (so its default `true` applies) — which was the real
   * collision the finding named. `requestKind` is now part of the storage
   * key itself (structural fix, see `pendingExchangeStorageKey`), so a scan
   * panel here cannot read the direct record even in principle; this test
   * still pins the observable behavior (scan mode never shows or can delete
   * the other flow's request) as a regression guard.
   */
  test('does not restore a direct-flow record when mounted in scan mode, and cannot delete it (station#1711 review, HIGH)', async () => {
    const direct: PendingPairingExchange = {
      endpoint: window.location.origin,
      offerId: 'offer-cross-mode',
      proof: 'proof-cross-mode',
      requestId: 'request-cross-mode',
      expiresAt: Date.now() + 5 * 60_000,
      expectedEnvironmentId: 'environment-cross-mode',
      browserSession: true,
      requestKind: 'direct',
    };
    savePendingExchange(direct);

    render(
      <JoinDevicePairingPanel
        initialMode="scan"
        onPaired={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // Not restored: no "Waiting for approval" screen appears on mount alone.
    expect(screen.queryByText(/Waiting for approval/)).toBeNull();
    // ...and therefore no "Stop waiting" control exists that could delete the
    // other flow's record.
    expect(screen.queryByRole('button', { name: 'Stop waiting' })).toBeNull();
    // The direct flow's record is untouched — mounting (and rendering) the
    // scan panel never read-then-cleared it.
    expect(loadPendingExchange(window.location.origin, 'direct')).toEqual(
      direct,
    );
  });

  /**
   * Guards against fixing the above by breaking #1711: the direct flow must
   * still restore its own record via the page-origin fallback (no
   * `directEndpoint`, `originIsStation` left at its default), with no click
   * and no re-entered code, exactly like the `directEndpoint` case already
   * pinned above.
   */
  test('still restores its own record via the origin fallback (station#1711 origin path)', async () => {
    let confirmedByTheHost = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/.well-known/station/v1/pairing/exchange') {
        if (!confirmedByTheHost) {
          return response({ error: 'request_not_confirmed' }, 409);
        }
        return response({
          environmentId: 'environment-origin-restore',
          device: {
            id: 'device-origin-restore',
            name: 'This browser',
            scope: 'station:interactive',
            createdAt: Date.now(),
            revokedAt: null,
          },
          credential: 'issued-credential-origin-restore',
        });
      }
      throw new Error(`unexpected fetch to ${path}`);
    });

    const nextPending: PendingPairingExchange = {
      endpoint: window.location.origin,
      offerId: 'offer-origin-restore',
      proof: 'proof-origin-restore',
      requestId: 'request-origin-restore',
      expiresAt: Date.now() + 5 * 60_000,
      expectedEnvironmentId: 'environment-origin-restore',
      browserSession: true,
      requestKind: 'direct',
    };
    savePendingExchange(nextPending);

    const onPaired = vi.fn();
    render(
      <JoinDevicePairingPanel
        initialMode="direct"
        onPaired={onPaired}
        onCancel={vi.fn()}
      />,
    );

    expect(
      await screen.findByText('Waiting for approval on this Station…'),
    ).toBeTruthy();

    confirmedByTheHost = true;
    await waitFor(() => expect(onPaired).toHaveBeenCalledOnce(), {
      timeout: 5_000,
    });
    expect(onPaired).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: window.location.origin }),
    );
  });

  test('requests same-origin access without a code or reusable browser credential', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        response(
          {
            environmentId: 'environment-direct',
            offerId: 'offer-direct',
            proof: 'proof-direct',
            requestId: 'request-direct',
            expiresAt: Date.now() + 60_000,
          },
          202,
        ),
      )
      .mockResolvedValueOnce(
        response({
          environmentId: 'environment-direct',
          device: {
            id: 'device-direct',
            name: 'This browser',
            scope: 'station:interactive',
            createdAt: Date.now(),
            revokedAt: null,
          },
          delivery: 'browser-cookie',
        }),
      );
    const onPaired = vi.fn();
    render(
      <JoinDevicePairingPanel
        initialMode="direct"
        onPaired={onPaired}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText('Pairing code')).toBeNull();
    expect(screen.queryByLabelText('Station server address')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));

    expect(
      await screen.findByText('Waiting for approval on this Station…'),
    ).toBeTruthy();
    expect(
      screen.getByText('station environment access approve request-direct'),
    ).toBeTruthy();
    // station#1711 — a custom instance's STATION_HOME/STATION_PORT/--api-base
    // sentence is a documentation concern, not a modal concern; deleted from
    // this screen entirely.
    expect(screen.queryByText(/STATION_HOME/)).toBeNull();
    expect(screen.queryByText(/For a custom instance/)).toBeNull();
    expect(
      screen.getByText(/Run this on the Station or over SSH/),
    ).toBeTruthy();
    // The CLI fallback is closed by default — it is the fallback, not the
    // instruction.
    const disclosure = screen
      .getByText('Approve from the Station instead')
      .closest('details');
    expect(disclosure).not.toBeNull();
    expect((disclosure as HTMLDetailsElement).open).toBe(false);
    await waitFor(() => expect(onPaired).toHaveBeenCalledOnce(), {
      timeout: 2_000,
    });
    const requestCall = fetchSpy.mock.calls[0];
    expect(new URL(String(requestCall?.[0])).pathname).toBe(
      '/.well-known/station/v1/pairing/access-request',
    );
    expect(JSON.parse(String(requestCall?.[1]?.body))).toMatchObject({
      deviceName: 'This browser',
      clientInstanceId: expect.any(String),
    });
    expect(requestCall?.[1]).toMatchObject({ credentials: 'same-origin' });
    expect(onPaired).toHaveBeenCalledWith(
      expect.objectContaining({
        browserSession: true,
        credential: undefined,
        endpoint: window.location.origin,
      }),
    );
  });

  /**
   * station#1711 — the approve command gets a real Copy affordance instead
   * of relying on the user selecting wrapped monospace text on a phone.
   */
  test('copies the exact, full approve command via the Clipboard API', async () => {
    setNativePairingExchangeTransport(
      () => new Promise(() => {}), // never resolves — stay in `pending`
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      response(
        {
          environmentId: 'environment-direct',
          offerId: 'offer-direct',
          proof: 'proof-direct',
          requestId: 'request-copy-me',
          expiresAt: Date.now() + 60_000,
        },
        202,
      ),
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(
      <JoinDevicePairingPanel
        initialMode="direct"
        onPaired={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));
    await screen.findByText(
      'station environment access approve request-copy-me',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    // The exact full command, byte for byte — never a visually-elided slice.
    expect(writeText).toHaveBeenCalledWith(
      'station environment access approve request-copy-me',
    );
    expect(await screen.findByText('Copied')).toBeTruthy();
  });

  test('falls back to a selected, un-truncated textarea when no Clipboard API is available, never document.execCommand', async () => {
    setNativePairingExchangeTransport(() => new Promise(() => {}));
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      response(
        {
          environmentId: 'environment-direct',
          offerId: 'offer-direct',
          proof: 'proof-direct',
          requestId: 'request-fallback',
          expiresAt: Date.now() + 60_000,
        },
        202,
      ),
    );
    // Simulate a non-secure context: no Clipboard API at all.
    Object.assign(navigator, { clipboard: undefined });
    const execCommand = vi.fn();
    Object.assign(document, { execCommand });

    render(
      <JoinDevicePairingPanel
        initialMode="direct"
        onPaired={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));
    await screen.findByText(
      'station environment access approve request-fallback',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    const fallback = (await screen.findByLabelText(
      'Command to copy',
    )) as HTMLTextAreaElement;
    expect(fallback.value).toBe(
      'station environment access approve request-fallback',
    );
    expect(document.activeElement).toBe(fallback);
    expect(execCommand).not.toHaveBeenCalled();
  });

  test('native request-access collects a host address first and targets the entered host', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        response(
          {
            environmentId: 'environment-native',
            offerId: 'offer-native',
            proof: 'proof-native',
            requestId: 'request-native',
            expiresAt: Date.now() + 60_000,
          },
          202,
        ),
      )
      .mockResolvedValueOnce(
        response({
          environmentId: 'environment-native',
          device: {
            id: 'device-native',
            name: 'This browser',
            scope: 'station:interactive',
            createdAt: Date.now(),
            revokedAt: null,
          },
          credential: 'issued-native-credential',
        }),
      );
    const onPaired = vi.fn();
    render(
      <JoinDevicePairingPanel
        initialMode="direct"
        originIsStation={false}
        onPaired={onPaired}
        onCancel={vi.fn()}
      />,
    );

    // The host-address step is presented up front instead of failing after the
    // fact against a non-Station origin.
    const hostInput = screen.getByLabelText('Station server address');
    fireEvent.change(hostInput, {
      target: { value: 'https://remote.example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));

    await waitFor(() => expect(onPaired).toHaveBeenCalledOnce(), {
      timeout: 2_000,
    });
    const requestCall = fetchSpy.mock.calls[0];
    const requestUrl = new URL(String(requestCall?.[0]));
    expect(requestUrl.origin).toBe('https://remote.example.test');
    expect(requestUrl.pathname).toBe(
      '/.well-known/station/v1/pairing/access-request',
    );
    expect(JSON.parse(String(requestCall?.[1]?.body))).toMatchObject({
      deviceName: 'This browser',
      clientInstanceId: expect.any(String),
    });
    expect(onPaired).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'https://remote.example.test',
        browserSession: false,
        credential: 'issued-native-credential',
      }),
    );
  });

  test('waits for async local persistence before completing pairing', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        response(
          {
            environmentId: 'environment-native',
            offerId: 'offer-native',
            proof: 'proof-native',
            requestId: 'request-native',
            expiresAt: Date.now() + 60_000,
          },
          202,
        ),
      )
      .mockResolvedValueOnce(
        response({
          environmentId: 'environment-native',
          device: {
            id: 'device-native',
            name: 'This browser',
            scope: 'station:interactive',
            createdAt: Date.now(),
            revokedAt: null,
          },
          credential: 'issued-native-credential',
        }),
      );
    const persistence = deferred<void>();
    const onPaired = vi.fn(() => persistence.promise);
    render(
      <JoinDevicePairingPanel
        initialMode="direct"
        directEndpoint="https://remote.example.test"
        onPaired={onPaired}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));

    await waitFor(() => expect(onPaired).toHaveBeenCalledOnce(), {
      timeout: 2_000,
    });
    expect(
      screen.getByText('Waiting for approval on this Station…'),
    ).toBeTruthy();

    await act(async () => {
      persistence.resolve();
      await persistence.promise;
    });

    await waitFor(() =>
      expect(
        screen.queryByText('Waiting for approval on this Station…'),
      ).toBeNull(),
    );
    expect(screen.getByRole('button', { name: 'Request access' })).toBeTruthy();
  });

  test('reports async local persistence failure instead of waiting forever', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        response(
          {
            environmentId: 'environment-native',
            offerId: 'offer-native',
            proof: 'proof-native',
            requestId: 'request-native',
            expiresAt: Date.now() + 60_000,
          },
          202,
        ),
      )
      .mockResolvedValueOnce(
        response({
          environmentId: 'environment-native',
          device: {
            id: 'device-native',
            name: 'This browser',
            scope: 'station:interactive',
            createdAt: Date.now(),
            revokedAt: null,
          },
          credential: 'issued-native-credential',
        }),
      );
    const onPaired = vi.fn(async () => {
      throw new Error('vault write failed');
    });
    render(
      <JoinDevicePairingPanel
        initialMode="direct"
        directEndpoint="https://remote.example.test"
        onPaired={onPaired}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));

    expect(
      await screen.findByText(
        'This device was paired, but the Station could not be saved here.',
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText('Waiting for approval on this Station…'),
    ).toBeNull();
  });

  test('native request-access to an unreachable host keeps the existing error copy', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new TypeError('network unavailable'),
    );
    render(
      <JoinDevicePairingPanel
        initialMode="direct"
        originIsStation={false}
        onPaired={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Station server address'), {
      target: { value: 'https://remote.example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));

    expect(
      await screen.findByText(
        'This Station could not create an access request. Try again.',
      ),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain('network unavailable');
  });

  test('defaults the device name from userAgentData high-entropy values while staying editable', async () => {
    Object.defineProperty(window.navigator, 'userAgentData', {
      configurable: true,
      value: {
        brands: [
          { brand: 'Not.A/Brand', version: '8' },
          { brand: 'Chromium', version: '125' },
          { brand: 'Google Chrome', version: '125' },
        ],
        mobile: false,
        platform: 'macOS',
        getHighEntropyValues: async () => ({
          model: '',
          platform: 'macOS',
          brands: [{ brand: 'Google Chrome', version: '125' }],
        }),
      },
    });
    try {
      render(
        <JoinDevicePairingPanel
          initialMode="direct"
          onPaired={vi.fn()}
          onCancel={vi.fn()}
        />,
      );

      const input = (await screen.findByLabelText(
        'Device name',
      )) as HTMLInputElement;
      await waitFor(() => expect(input.value).toBe('Mac · Chrome'));

      fireEvent.change(input, { target: { value: 'My renamed device' } });
      expect(input.value).toBe('My renamed device');
    } finally {
      delete (window.navigator as { userAgentData?: unknown }).userAgentData;
    }
  });

  test('never overwrites a device name the user already edited before UA detection resolves', async () => {
    const deferredHighEntropy = deferred<{
      model: string;
      platform: string;
      brands: Array<{ brand: string; version: string }>;
    }>();
    Object.defineProperty(window.navigator, 'userAgentData', {
      configurable: true,
      value: {
        brands: [],
        mobile: false,
        platform: 'macOS',
        getHighEntropyValues: async () => deferredHighEntropy.promise,
      },
    });
    try {
      render(
        <JoinDevicePairingPanel
          initialMode="direct"
          onPaired={vi.fn()}
          onCancel={vi.fn()}
        />,
      );

      const input = (await screen.findByLabelText(
        'Device name',
      )) as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'Typed before detection' } });

      await act(async () => {
        deferredHighEntropy.resolve({
          model: '',
          platform: 'macOS',
          brands: [{ brand: 'Google Chrome', version: '125' }],
        });
        await deferredHighEntropy.promise;
        await Promise.resolve();
      });

      expect(input.value).toBe('Typed before detection');
    } finally {
      delete (window.navigator as { userAgentData?: unknown }).userAgentData;
    }
  });

  test('hands device-name authority to the user on focus before delayed UA detection resolves', async () => {
    const deferredHighEntropy = deferred<{
      model: string;
      platform: string;
      brands: Array<{ brand: string; version: string }>;
    }>();
    Object.defineProperty(window.navigator, 'userAgentData', {
      configurable: true,
      value: {
        brands: [],
        mobile: false,
        platform: 'macOS',
        getHighEntropyValues: async () => deferredHighEntropy.promise,
      },
    });
    try {
      render(
        <JoinDevicePairingPanel
          initialMode="direct"
          onPaired={vi.fn()}
          onCancel={vi.fn()}
        />,
      );

      const input = (await screen.findByLabelText(
        'Device name',
      )) as HTMLInputElement;
      fireEvent.focus(input);

      await act(async () => {
        deferredHighEntropy.resolve({
          model: '',
          platform: 'macOS',
          brands: [{ brand: 'HeadlessChrome', version: '151' }],
        });
        await deferredHighEntropy.promise;
        await Promise.resolve();
      });

      expect(input.value).toBe('This browser');
      fireEvent.change(input, { target: { value: 'Phone E2E' } });
      expect(input.value).toBe('Phone E2E');
    } finally {
      delete (window.navigator as { userAgentData?: unknown }).userAgentData;
    }
  });

  test('stops polling and explains when the Station denies direct access', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        response(
          {
            environmentId: 'environment-denied',
            offerId: 'offer-denied',
            proof: 'proof-denied',
            requestId: 'request-denied',
            expiresAt: Date.now() + 60_000,
          },
          202,
        ),
      )
      .mockResolvedValueOnce(response({ error: 'request_denied' }, 403));
    const onPaired = vi.fn();
    render(
      <JoinDevicePairingPanel
        initialMode="direct"
        onPaired={onPaired}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));

    expect(
      await screen.findByText('The Station declined this access request.'),
    ).toBeTruthy();
    expect(onPaired).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  test('explains a server-expired direct request without generic pairing advice', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        response(
          {
            environmentId: 'environment-expired',
            offerId: 'offer-expired',
            proof: 'proof-expired',
            requestId: 'request-expired',
            expiresAt: Date.now() + 60_000,
          },
          202,
        ),
      )
      .mockResolvedValueOnce(response({ error: 'offer_expired' }, 410));
    render(
      <JoinDevicePairingPanel
        initialMode="direct"
        onPaired={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));

    expect(
      // station#3849's shared expiry copy, which names the Station and the
      // recovery instead of a bare "Try again."
      await screen.findByText(
        'This access request expired before this Station approved it. Request access again.',
      ),
    ).toBeTruthy();
  });

  test('shows request expiry and lets an owner deny from the host inbox', async () => {
    let denied = false;
    const request = {
      requestId: 'request-host-deny',
      offerId: 'offer-host-deny',
      deviceName: 'Unknown browser',
      scope: 'station:interactive',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      source: 'same-origin',
      status: 'pending',
    };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (
          path === `/api/pairing/requests/${request.requestId}` &&
          init?.method === 'DELETE'
        ) {
          denied = true;
          return response({ ...request, status: 'denied' });
        }
        if (path === '/api/pairing/requests') {
          return response({ requests: denied ? [] : [request] });
        }
        if (path === '/api/pairing/devices') return response({ devices: [] });
        return response({ error: 'unexpected' }, 500);
      });

    render(
      <HostDevicePairingPanel
        apiBase="https://station.example.test"
        publicEndpoint="https://station.public.test"
        getCredential={() => 'operator-credential'}
        onCancel={vi.fn()}
      />,
    );

    expect(await screen.findByText('Unknown browser')).toBeTruthy();
    expect(
      screen.getByText('Requested from this Station address'),
    ).toBeTruthy();
    expect(screen.getByText(/Expires in/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await waitFor(() =>
      expect(screen.queryByText('Unknown browser')).toBeNull(),
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      new URL(
        'https://station.example.test/api/pairing/requests/request-host-deny',
      ),
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          Authorization: 'Bearer operator-credential',
        }),
      }),
    );
  });

  test('names the host CLI when this Station refuses the approval (station#1490)', async () => {
    const request = {
      requestId: 'request-refused',
      offerId: 'offer-refused',
      deviceName: 'Second browser',
      scope: 'station:interactive',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      source: 'same-origin',
      status: 'pending',
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (
        path === '/api/pairing/requests/request-refused/confirm' &&
        init?.method === 'POST'
      ) {
        // What a same-machine approval gets from a session presenting no
        // credential: the guard refuses, and this copy is the only place the
        // operator is told what to do instead.
        return response({ error: 'approval_requires_operator' }, 403);
      }
      if (path === '/api/pairing/requests')
        return response({ requests: [request] });
      if (path === '/api/pairing/devices') return response({ devices: [] });
      return response({ error: 'unexpected' }, 500);
    });

    render(
      <HostDevicePairingPanel
        apiBase="https://station.example.test"
        publicEndpoint="https://station.public.test"
        getCredential={() => undefined}
        onCancel={vi.fn()}
      />,
    );

    expect(await screen.findByText('Second browser')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    // `--force` matches the CLI's own guidance: without it a non-interactive
    // shell refuses, and the operator is left staring at a second error.
    expect(
      await screen.findByText(
        /station environment access approve request-refused --force/,
      ),
    ).toBeTruthy();
    // The request must stay in the inbox — the refusal is not a removal.
    expect(screen.getByText('Second browser')).toBeTruthy();
  });

  test('shows server-verified tailnet provenance in the host inbox', async () => {
    const request = {
      requestId: 'request-tailnet',
      offerId: 'offer-tailnet',
      deviceName: 'Laptop browser',
      scope: 'station:interactive',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      source: 'tailnet',
      requester: {
        provider: 'tailscale-serve',
        login: 'brian@example.test',
        displayName: 'Brian',
      },
      status: 'pending',
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/pairing/requests')
        return response({ requests: [request] });
      if (path === '/api/pairing/devices') return response({ devices: [] });
      return response({ error: 'unexpected' }, 500);
    });

    render(
      <HostDevicePairingPanel
        apiBase="https://station.example.test"
        publicEndpoint="https://station.public.test"
        getCredential={() => 'operator-credential'}
        onCancel={vi.fn()}
      />,
    );

    expect(await screen.findByText('Laptop browser')).toBeTruthy();
    expect(screen.getByText('Verified by Tailscale · Brian')).toBeTruthy();
    expect(screen.getByText('brian@example.test')).toBeTruthy();
  });

  function directPairingFetch(
    onExchange: (
      attempt: number,
      signal?: AbortSignal | null,
    ) => Response | Promise<Response>,
  ) {
    let attempt = 0;
    return vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (!path.endsWith('/exchange')) {
          return response(
            {
              environmentId: 'environment-direct',
              offerId: 'offer-direct',
              proof: 'proof-direct',
              requestId: 'request-direct',
              expiresAt: Date.now() + 300_000,
            },
            202,
          );
        }
        attempt += 1;
        return onExchange(attempt, init?.signal);
      });
  }

  const PAIRED_RESPONSE = () =>
    response({
      environmentId: 'environment-direct',
      device: {
        id: 'device-direct',
        name: 'Pixel 10 Pro XL',
        scope: 'station:interactive',
        createdAt: Date.now(),
        revokedAt: null,
      },
      delivery: 'browser-cookie',
    });

  function renderDirectJoin(onPaired = vi.fn()) {
    const view = render(
      <JoinDevicePairingPanel
        initialMode="direct"
        onPaired={onPaired}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));
    return { view, onPaired };
  }

  async function tick(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  /**
   * Backgrounding the app is not a pairing failure. Android suspends the
   * webview, the in-flight exchange dies with a network error carrying no HTTP
   * status, and the panel used to discard the pending request outright — so the
   * host could approve and the phone would still come back to "Pairing failed.
   * Check the code and try again." with nothing left to resume.
   */
  test('keeps the request alive across a dropped connection and pairs on retry', async () => {
    vi.useFakeTimers();
    directPairingFetch((attempt) => {
      // A suspended webview cannot complete a request: fetch rejects, and the
      // rejection carries no status at all.
      if (attempt === 1) throw new TypeError('Failed to fetch');
      return PAIRED_RESPONSE();
    });
    const { view, onPaired } = renderDirectJoin();

    // The exchange timer is only scheduled once the access request resolves,
    // so reaching the first exchange takes two hops.
    await tick(600);
    await tick(600);
    expect(
      screen.queryByText('Pairing failed. Check the code and try again.'),
    ).toBeNull();
    expect(screen.getByText('Waiting to reach this Station…')).toBeTruthy();

    await tick(1_000);
    expect(onPaired).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  test('returning to the foreground retries without waiting out the backoff', async () => {
    vi.useFakeTimers();
    let exchanges = 0;
    directPairingFetch((attempt) => {
      exchanges = attempt;
      if (attempt === 1) throw new TypeError('Failed to fetch');
      return PAIRED_RESPONSE();
    });
    const { view, onPaired } = renderDirectJoin();
    await tick(600);
    await tick(600);
    expect(exchanges).toBe(1);

    // Long enough to clear the minimum gap between attempts, still well short
    // of the retry the failure scheduled.
    await act(async () => {
      vi.setSystemTime(Date.now() + 30_000);
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(onPaired).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  /**
   * The Station allows 90 exchanges per five minutes. Treating the rate limit
   * as fatal would strand a pairing the host is perfectly willing to approve —
   * the same dead end this polling exists to avoid.
   */
  test('backs off a rate limit instead of failing the pairing', async () => {
    vi.useFakeTimers();
    directPairingFetch((attempt) =>
      attempt === 1
        ? response({ error: 'rate_limited' }, 429)
        : PAIRED_RESPONSE(),
    );
    const { view, onPaired } = renderDirectJoin();
    await tick(600);
    await tick(600);
    expect(
      screen.queryByText('Pairing failed. Check the code and try again.'),
    ).toBeNull();

    await tick(11_000);
    expect(onPaired).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  /**
   * A burst of focus/visibility events must not become a burst of requests —
   * that is what would trip the rate limit above.
   */
  test('does not start a second exchange while one is in flight', async () => {
    vi.useFakeTimers();
    const held = deferred<Response>();
    let exchanges = 0;
    directPairingFetch((attempt) => {
      exchanges = attempt;
      return held.promise;
    });
    const { view } = renderDirectJoin();
    await tick(600);
    await tick(600);
    expect(exchanges).toBe(1);

    await act(async () => {
      for (let i = 0; i < 8; i += 1) {
        window.dispatchEvent(new Event('focus'));
        window.dispatchEvent(new Event('online'));
      }
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(exchanges).toBe(1);

    await act(async () => {
      held.resolve(PAIRED_RESPONSE());
      await held.promise;
    });
    view.unmount();
  });

  /**
   * Retrying a transport failure must not become retrying everything: a fault
   * in our own handling still has to surface rather than wait out the clock.
   */
  /**
   * A dropped connection leaves fetch pending with nothing to reject it, so
   * without a request timeout the panel would wait on an answer that never
   * comes.
   */
  test('times out a request that never answers and retries it', async () => {
    vi.useFakeTimers();
    let exchanges = 0;
    directPairingFetch((attempt, signal) => {
      exchanges = attempt;
      // Model a dropped connection the way fetch does: pending until aborted.
      if (attempt === 1) {
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () =>
            reject(signal.reason ?? new Error('aborted')),
          );
        });
      }
      return PAIRED_RESPONSE();
    });
    const { view, onPaired } = renderDirectJoin();
    await tick(600);
    await tick(600);
    expect(exchanges).toBe(1);

    // Past the 20s request timeout, plus the retry it schedules.
    await tick(22_000);
    expect(onPaired).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  /**
   * The concurrency guard alone is not enough: non-overlapping requests can
   * still exceed what the Station will accept. It allows 90 exchanges per five
   * minutes, and a device held in a focus/resume loop must stay inside that
   * budget or the rate limiter ends a pairing the host would have approved.
   */
  test('stays inside the server request budget under a storm of foreground events', async () => {
    vi.useFakeTimers();
    let exchanges = 0;
    directPairingFetch((attempt) => {
      exchanges = attempt;
      // The host has not approved yet — the ordinary waiting case.
      return response({ error: 'request_pending' }, 409);
    });
    const { view } = renderDirectJoin();
    await tick(600);
    await tick(600);

    // Five minutes of a device relentlessly regaining focus. The cadence is
    // deliberately longer than any retry delay the panel schedules: events
    // faster than that merely keep pushing the timer back, so they are the
    // easy case, not the worst one.
    for (let elapsed = 0; elapsed < 300_000; elapsed += 1_000) {
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        window.dispatchEvent(new Event('online'));
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(1_000);
      });
    }
    expect(exchanges).toBeLessThanOrEqual(90);
    view.unmount();
  });

  test('a foreground event cannot shorten the rate-limit backoff', async () => {
    vi.useFakeTimers();
    let exchanges = 0;
    directPairingFetch((attempt) => {
      exchanges = attempt;
      return response({ error: 'rate_limited' }, 429);
    });
    const { view } = renderDirectJoin();
    await tick(600);
    await tick(600);
    expect(exchanges).toBe(1);

    // Resume repeatedly inside the 10s backoff, at a cadence longer than the
    // panel's own retry delay so a foreground event genuinely gets the chance
    // to fire an attempt early.
    for (let elapsed = 0; elapsed < 9_000; elapsed += 1_000) {
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        await vi.advanceTimersByTimeAsync(1_000);
      });
    }
    expect(exchanges).toBe(1);
    view.unmount();
  });

  test('stops blaming the connection once the Station answers', async () => {
    vi.useFakeTimers();
    directPairingFetch((attempt) => {
      if (attempt === 1) throw new TypeError('Failed to fetch');
      // Reachable again, just not approved yet.
      return response({ error: 'request_pending' }, 409);
    });
    const { view } = renderDirectJoin();
    await tick(600);
    await tick(600);
    expect(screen.getByText('Waiting to reach this Station…')).toBeTruthy();

    await tick(1_000);
    expect(screen.queryByText('Waiting to reach this Station…')).toBeNull();
    expect(
      screen.getByText('Waiting for approval on this Station…'),
    ).toBeTruthy();
    view.unmount();
  });

  /**
   * A fault in the caller's own handling is not a reason to keep polling a
   * request the Station has already spent — and must not vanish silently.
   */
  test('reports a failure to store the connection instead of polling on', async () => {
    vi.useFakeTimers();
    let exchanges = 0;
    directPairingFetch((attempt) => {
      exchanges = attempt;
      return PAIRED_RESPONSE();
    });
    const onPaired = vi.fn(() => {
      throw new Error('storage unavailable');
    });
    const { view } = renderDirectJoin(onPaired);
    await tick(600);
    await tick(600);
    expect(
      screen.getByText(
        'This device was paired, but the Station could not be saved here.',
      ),
    ).toBeTruthy();

    await tick(30_000);
    expect(exchanges).toBe(1);
    view.unmount();
  });

  test('still fails loudly on a malformed success response', async () => {
    vi.useFakeTimers();
    directPairingFetch(
      () =>
        new Response('not json', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const { view } = renderDirectJoin();
    await tick(600);
    await tick(600);
    expect(
      screen.getByText('Pairing failed. Check the code and try again.'),
    ).toBeTruthy();
    view.unmount();
  });

  test('still reports a genuine server-side failure', async () => {
    vi.useFakeTimers();
    directPairingFetch(() => response({ error: 'invalid_offer' }, 400));
    const { view } = renderDirectJoin();
    await tick(600);
    await tick(600);
    expect(
      screen.getByText('Pairing failed. Check the code and try again.'),
    ).toBeTruthy();
    view.unmount();
  });

  test('ignores an older refresh that completes after a newer inbox snapshot', async () => {
    vi.useFakeTimers();
    const staleRequests = deferred<Response>();
    let requestReads = 0;
    const oldRequest = {
      requestId: 'request-old',
      offerId: 'offer-old',
      deviceName: 'Old request',
      scope: 'station:interactive',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      source: 'same-origin',
      status: 'pending',
    };
    const newRequest = {
      ...oldRequest,
      requestId: 'request-new',
      offerId: 'offer-new',
      deviceName: 'New request',
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/pairing/requests') {
        requestReads += 1;
        return requestReads === 1
          ? staleRequests.promise
          : response({ requests: [newRequest] });
      }
      if (path === '/api/pairing/devices') return response({ devices: [] });
      return response({ error: 'unexpected' }, 500);
    });

    const view = render(
      <HostDevicePairingPanel
        apiBase="https://station.example.test"
        publicEndpoint="https://station.public.test"
        getCredential={() => 'operator-credential'}
        onCancel={vi.fn()}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByText('New request')).toBeTruthy();

    await act(async () => {
      staleRequests.resolve(response({ requests: [oldRequest] }));
      await staleRequests.promise;
      await Promise.resolve();
    });
    expect(screen.queryByText('Old request')).toBeNull();
    expect(screen.getByText('New request')).toBeTruthy();
    view.unmount();
  });

  test('tracks simultaneous host actions independently per request', async () => {
    const firstAction = deferred<Response>();
    const secondAction = deferred<Response>();
    const requests = ['First request', 'Second request'].map(
      (deviceName, index) => ({
        requestId: `request-${index + 1}`,
        offerId: `offer-${index + 1}`,
        deviceName,
        scope: 'station:interactive',
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        source: 'same-origin',
        status: 'pending',
      }),
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/pairing/requests') return response({ requests });
      if (path === '/api/pairing/devices') return response({ devices: [] });
      if (init?.method === 'DELETE' && path.endsWith('/request-1')) {
        return firstAction.promise;
      }
      if (init?.method === 'DELETE' && path.endsWith('/request-2')) {
        return secondAction.promise;
      }
      return response({ error: 'unexpected' }, 500);
    });

    render(
      <HostDevicePairingPanel
        apiBase="https://station.example.test"
        publicEndpoint="https://station.public.test"
        getCredential={() => 'operator-credential'}
        onCancel={vi.fn()}
      />,
    );
    expect(await screen.findByText('First request')).toBeTruthy();
    const initialButtons = screen.getAllByRole('button', { name: 'Deny' });
    fireEvent.click(initialButtons[0]!);
    fireEvent.click(initialButtons[1]!);
    expect(
      screen
        .getAllByRole('button', { name: 'Deny' })
        .every((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true);

    await act(async () => {
      firstAction.resolve(response({ ...requests[0], status: 'denied' }));
      await firstAction.promise;
    });
    await waitFor(() => {
      const buttons = screen.getAllByRole('button', { name: 'Deny' });
      expect((buttons[0] as HTMLButtonElement).disabled).toBe(false);
      expect((buttons[1] as HTMLButtonElement).disabled).toBe(true);
    });

    await act(async () => {
      secondAction.resolve(response({ ...requests[1], status: 'denied' }));
      await secondAction.promise;
    });
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('button', { name: 'Deny' })
          .every((button) => !(button as HTMLButtonElement).disabled),
      ).toBe(true),
    );
  });

  test('manual device flow exchanges only after a request and never renders the credential', async () => {
    const credential = 'issued-device-credential-that-must-not-render';
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        response({
          requestId: 'request-1',
          offerId: 'offer-1',
          deviceName: 'This browser',
          scope: 'station:interactive',
          createdAt: Date.now(),
          status: 'pending',
        }),
      )
      .mockResolvedValueOnce(
        response({
          environmentId: 'environment-1',
          device: {
            id: 'device-1',
            name: 'This browser',
            scope: 'station:interactive',
            createdAt: Date.now(),
            revokedAt: null,
          },
          credential,
        }),
      );
    const onPaired = vi.fn();
    render(<JoinDevicePairingPanel onPaired={onPaired} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Enter manually' }));
    fireEvent.change(screen.getByLabelText('Station server address'), {
      target: { value: 'https://station.example.test' },
    });
    fireEvent.change(screen.getByLabelText('Pairing code'), {
      target: { value: 'PAIRME2345' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));

    expect(
      // station#3849: the shared map distinguishes the code wait from the
      // direct one, which this panel used to word identically.
      await screen.findByText(
        'Waiting for the code to be approved on this Station…',
      ),
    ).toBeTruthy();
    await waitFor(() => expect(onPaired).toHaveBeenCalledOnce(), {
      timeout: 2_000,
    });
    expect(onPaired).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'https://station.example.test',
        credential,
      }),
    );
    expect(document.body.textContent).not.toContain(credential);
  });

  test('a bare host address is paired over an https endpoint', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        response({
          requestId: 'request-bare',
          offerId: 'offer-bare',
          deviceName: 'This browser',
          scope: 'station:interactive',
          createdAt: Date.now(),
          status: 'pending',
        }),
      )
      .mockResolvedValueOnce(
        response({
          environmentId: 'environment-bare',
          device: {
            id: 'device-bare',
            name: 'This browser',
            scope: 'station:interactive',
            createdAt: Date.now(),
            revokedAt: null,
          },
          credential: 'bare-credential',
        }),
      );
    const onPaired = vi.fn();
    render(<JoinDevicePairingPanel onPaired={onPaired} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Enter manually' }));
    fireEvent.change(screen.getByLabelText('Station server address'), {
      target: { value: 'station.bare.test' },
    });
    fireEvent.change(screen.getByLabelText('Pairing code'), {
      target: { value: 'PAIRME2345' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));

    await waitFor(() => expect(onPaired).toHaveBeenCalledOnce(), {
      timeout: 2_000,
    });
    expect(onPaired).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'https://station.bare.test' }),
    );
    const requestUrl = String(vi.mocked(globalThis.fetch).mock.calls[0]?.[0]);
    expect(requestUrl.startsWith('https://station.bare.test/')).toBe(true);
  });

  // station#3158 — the scan and manual-entry paths both used to answer every
  // host refusal with one sentence ("invalid, expired, or already used" /
  // "server address or manual code is not valid"), so the two commonest
  // refusals — which have opposite remedies — read identically on the screen.
  async function scanAndRequest(status: number, code: string) {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      response({ error: code }, status),
    );
    render(
      <JoinDevicePairingPanel
        initialPairingPayload={encodeDevicePairingPayload({
          protocolVersion: 1,
          environmentId: 'environment-refused',
          offerId: 'offer-refused',
          challenge: 'challenge-refused',
          manualCode: 'ABCDE12345',
          endpoint: 'https://station.example.ts.net',
          scope: 'orchestration:read',
          expiresAt: Date.now() + 60_000,
        })}
        onPaired={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));
    return (await screen.findByRole('alert')).textContent ?? '';
  }

  test('a scanned code the Station says expired tells the user to get a new one', async () => {
    const message = await scanAndRequest(410, 'offer_expired');

    expect(message).toContain('expired');
    expect(message).toContain('Create a new code on the Station');
    // The remedy for an expired code is not the remedy for a claimed one, so
    // the message must not hedge across both.
    expect(message).not.toContain('already been claimed');
  });

  test('a scanned code another device already claimed says so, not that it expired', async () => {
    const message = await scanAndRequest(409, 'offer_unavailable');

    expect(message).toContain('already been claimed by another device');
    expect(message).not.toContain('expired');
  });

  test('manual entry reports the Station’s own refusal instead of blaming the address', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      response({ error: 'offer_expired' }, 410),
    );
    render(<JoinDevicePairingPanel onPaired={vi.fn()} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Enter manually' }));
    fireEvent.change(screen.getByLabelText('Station server address'), {
      target: { value: 'https://station.example.test' },
    });
    fireEvent.change(screen.getByLabelText('Pairing code'), {
      target: { value: 'PAIRME2345' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));

    const message = (await screen.findByRole('alert')).textContent ?? '';
    expect(message).toContain('expired');
    // The address parsed and the code was well-formed; neither is at fault.
    expect(message).not.toContain('address');
  });

  test('an unparseable address is blamed on the address, and nothing is sent', async () => {
    // The other half of the test above, and the one the hoisted parse exists
    // for. Deleting the early-parse block kept every test green while a
    // genuinely malformed address reported "This Station refused the pairing
    // request" — a false statement about a Station that was never contacted
    // (station#3158 review).
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<JoinDevicePairingPanel onPaired={vi.fn()} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Enter manually' }));
    fireEvent.change(screen.getByLabelText('Station server address'), {
      target: { value: 'not a url at all' },
    });
    fireEvent.change(screen.getByLabelText('Pairing code'), {
      target: { value: 'PAIRME2345' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'The server address is not valid.',
    );
    // Nothing was contacted, so nothing may be claimed about a Station.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('manual entry nudges away from raw http but not from https', async () => {
    render(<JoinDevicePairingPanel onPaired={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Enter manually' }));
    const address = screen.getByLabelText('Station server address');
    const hint = /Connecting over http to a raw address/i;

    fireEvent.change(address, { target: { value: 'http://192.168.1.9:3141' } });
    expect(await screen.findByText(hint)).toBeTruthy();

    fireEvent.change(address, {
      target: { value: 'https://station.foo.ts.net' },
    });
    await waitFor(() => expect(screen.queryByText(hint)).toBeNull());
  });

  test('same-origin device flow asks the server for an HttpOnly browser session', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        response({
          requestId: 'request-cookie',
          offerId: 'offer-cookie',
          deviceName: 'This browser',
          scope: 'station:interactive',
          createdAt: Date.now(),
          status: 'pending',
        }),
      )
      .mockResolvedValueOnce(
        response({
          environmentId: 'environment-cookie',
          device: {
            id: 'device-cookie',
            name: 'This browser',
            scope: 'station:interactive',
            createdAt: Date.now(),
            revokedAt: null,
          },
          delivery: 'browser-cookie',
        }),
      );
    const onPaired = vi.fn();
    render(<JoinDevicePairingPanel onPaired={onPaired} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Enter manually' }));
    fireEvent.change(screen.getByLabelText('Station server address'), {
      target: { value: window.location.origin },
    });
    fireEvent.change(screen.getByLabelText('Pairing code'), {
      target: { value: 'PAIRME2345' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));

    await waitFor(() => expect(onPaired).toHaveBeenCalledOnce(), {
      timeout: 2_000,
    });
    expect(onPaired).toHaveBeenCalledWith(
      expect.objectContaining({
        browserSession: true,
        credential: undefined,
        endpoint: window.location.origin,
      }),
    );
    const exchange = vi.mocked(globalThis.fetch).mock.calls[1];
    expect(JSON.parse(String(exchange?.[1]?.body))).toMatchObject({
      delivery: 'browser-cookie',
    });
    expect(exchange?.[1]).toMatchObject({ credentials: 'same-origin' });
  });

  test('host creates a short-lived offer with manual fallback and no credential input', async () => {
    const offer = {
      protocolVersion: 1,
      environmentId: 'environment-1',
      offerId: 'offer-1',
      challenge: 'challenge-1',
      manualCode: 'PAIRME2345',
      endpoint: 'https://station.example.test',
      scope: 'station:interactive',
      expiresAt: Date.now() + 60_000,
    };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === '/api/pairing/requests') return response({ requests: [] });
        if (path === '/api/pairing/devices') return response({ devices: [] });
        if (path === '/api/pairing/offers' && init?.method === 'POST') {
          return response(offer, 201);
        }
        return response({ error: 'unexpected' }, 500);
      });

    render(
      <HostDevicePairingPanel
        apiBase="https://station.example.test"
        publicEndpoint="https://station.public.test"
        getCredential={() => 'operator-credential'}
        onCancel={vi.fn()}
      />,
    );
    expect(
      (screen.getByLabelText('Pairing endpoint') as HTMLInputElement).value,
    ).toBe('https://station.public.test');
    fireEvent.click(
      screen.getByRole('button', { name: 'Create pairing code' }),
    );

    expect(await screen.findByText('PAIRME2345')).toBeTruthy();
    expect(screen.queryByLabelText(/credential/i)).toBeNull();
    const offerCall = fetchSpy.mock.calls.find(
      ([input]) => new URL(String(input)).pathname === '/api/pairing/offers',
    );
    expect(JSON.parse(String(offerCall?.[1]?.body))).toEqual({
      endpoint: 'https://station.public.test',
      // Standard is the default preset (station#1098 R3).
      scope: pairingScopePresetString('standard'),
    });
    expect(
      (screen.getByLabelText('Pairing client channel') as HTMLSelectElement)
        .value,
    ).toBe('stable');
    fireEvent.change(screen.getByLabelText('Pairing client channel'), {
      target: { value: 'beta' },
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    fireEvent.click(screen.getByRole('button', { name: 'Copy pairing link' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        expect.stringMatching(
          /^station-beta:\/\/pair\?linkVersion=1&clientChannel=beta&payload=/,
        ),
      ),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      new URL('https://station.example.test/api/pairing/offers'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer operator-credential',
        }),
      }),
    );
  });

  test('selecting the Read-only preset sends exactly the read-only scope (station#1098 AC2)', async () => {
    const offer = {
      protocolVersion: 1,
      environmentId: 'environment-1',
      offerId: 'offer-1',
      challenge: 'challenge-1',
      manualCode: 'PAIRME2345',
      endpoint: 'https://station.example.test',
      scope: 'orchestration:read',
      expiresAt: Date.now() + 60_000,
    };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === '/api/pairing/requests') return response({ requests: [] });
        if (path === '/api/pairing/devices') return response({ devices: [] });
        if (path === '/api/pairing/offers' && init?.method === 'POST') {
          return response(offer, 201);
        }
        return response({ error: 'unexpected' }, 500);
      });

    render(
      <HostDevicePairingPanel
        apiBase="https://station.example.test"
        publicEndpoint="https://station.public.test"
        getCredential={() => 'operator-credential'}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('radio', { name: /Read-only/ }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Create pairing code' }),
    );

    expect(await screen.findByText('PAIRME2345')).toBeTruthy();
    const offerCall = fetchSpy.mock.calls.find(
      ([input]) => new URL(String(input)).pathname === '/api/pairing/offers',
    );
    expect(JSON.parse(String(offerCall?.[1]?.body))).toEqual({
      endpoint: 'https://station.public.test',
      scope: 'orchestration:read',
    });
    // The scope is visible before the operator ever creates the grant.
    expect(screen.getByText(/Read-only/)).toBeTruthy();
  });

  test.each([
    [
      401,
      { error: { code: 'authentication_required' } },
      {},
      "This device's access to this Station needs review. Reconnect it, then try again.",
    ],
    [
      403,
      { error: { code: 'origin_forbidden' } },
      {},
      'This Station does not allow pairing from the current app address. Update its trusted app address, then try again.',
    ],
    [
      429,
      { error: { code: 'rate_limited' } },
      { 'Retry-After': '37' },
      'Too many pairing attempts. Try again in 37 seconds.',
    ],
    [
      429,
      { error: { code: 'rate_limited' } },
      { 'Retry-After': '999999999999' },
      'Too many pairing attempts. Wait a moment, then try again.',
    ],
    [
      400,
      { error: 'invalid_request' },
      {},
      'Use a valid HTTPS address that the other device can reach.',
    ],
    [
      422,
      { error: 'validation_failed' },
      {},
      'Use a valid HTTPS address that the other device can reach.',
    ],
  ])(
    'explains pairing offer failure %s without exposing server internals',
    async (status, body, headers, expected) => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === '/api/pairing/requests') {
          return response({ requests: [] });
        }
        if (path === '/api/pairing/devices') {
          return response({ devices: [] });
        }
        if (path === '/api/pairing/offers' && init?.method === 'POST') {
          return new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json', ...headers },
          });
        }
        return response({ error: 'unexpected' }, 500);
      });

      render(
        <HostDevicePairingPanel
          apiBase="https://station.example.test"
          publicEndpoint="https://station.public.test"
          getCredential={() => 'operator-credential'}
          onCancel={vi.fn()}
        />,
      );
      fireEvent.click(
        screen.getByRole('button', { name: 'Create pairing code' }),
      );

      expect((await screen.findByRole('alert')).textContent).toBe(expected);
      expect(screen.getByText(/other device receives/i)).toBeTruthy();
    },
  );

  test.each([
    [
      'a rejected request',
      () => Promise.reject(new TypeError('network unavailable')),
    ],
    [
      'a malformed success response',
      () =>
        Promise.resolve(
          new Response('{not-json', {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
    ],
  ])(
    'handles %s without exposing transport details',
    async (_label, createResponse) => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === '/api/pairing/requests') {
          return response({ requests: [] });
        }
        if (path === '/api/pairing/devices') {
          return response({ devices: [] });
        }
        if (path === '/api/pairing/offers' && init?.method === 'POST') {
          return createResponse();
        }
        return response({ error: 'unexpected' }, 500);
      });

      render(
        <HostDevicePairingPanel
          apiBase="https://station.example.test"
          publicEndpoint="https://station.public.test"
          getCredential={() => 'operator-credential'}
          onCancel={vi.fn()}
        />,
      );
      fireEvent.click(
        screen.getByRole('button', { name: 'Create pairing code' }),
      );

      expect((await screen.findByRole('alert')).textContent).toBe(
        'This Station could not create a pairing code. Check the connection, then try again.',
      );
      expect(document.body.textContent).not.toContain('network unavailable');
      expect(document.body.textContent).not.toContain('not-json');
    },
  );
});
