/**
 *asserted on the thing a user can see.
 *
 * A rejected credential leaves TWO pieces of stale evidence behind —
 * `lastError` (recorded by the health probe) and `credentialState: 'required'`
 * (set by the 401 through `onUnauthorized`) — and the "Request access to
 * reconnect" banner is rendered from the SECOND one. An earlier revision of
 * this fix cleared only `lastError`, producing the exact contradiction it was
 * written to remove: header chip "Connected · Default" beside a banner asking
 * for access.
 *
 * So this renders the REAL banner owner — `OnboardingGate` and `BannerHost` —
 * over the REAL `ConnectionStore` and the REAL SDK transport, and asserts on
 * the banner. A previous revision duplicated the gate's
 * `credentialState === 'required'` expression instead, which pinned the
 * implementation it was meant to check. Only the
 * peripheral modules `OnboardingGate` needs are mocked; nothing on the path
 * from an HTTP response to the banner is.
 *
 * The ordering rules and the exact recovered credential state are asserted
 * where they are decided, at the store:
 * `packages/connect/src/__tests__/ConnectionStore.authenticated-recovery.test.ts`.
 * This file covers the visible half, including the ordering case a user would
 * experience as being locked out with no banner and no way back.
 */
// @vitest-environment jsdom

import { useConnections } from '@kontourai/station-connect';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigate = vi.fn();

vi.mock('../../hooks/useSystemStatus', () => ({
  useSystemStatus: () => ({
    data: null,
    isLoading: false,
    isPending: false,
    isError: false,
    failureReason: null,
    refetch: vi.fn(),
  }),
}));
vi.mock('../../hooks/useInvalidateCachesOnConnectionSwitch', () => ({
  useInvalidateCachesOnConnectionSwitch: () => {},
}));
vi.mock('../../components/UsageTelemetryDisclosure', () => ({
  UsageTelemetryDisclosure: () => null,
}));
vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));
vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate, pathname: '/' }),
}));
vi.mock('../../components/PendingPairingReconciler', () => ({
  PendingPairingReconciler: () => null,
}));
vi.mock('../../lib/serverHealth', () => ({
  checkServerHealth: vi.fn(),
  checkServerHealthDetailed: vi.fn(),
}));
vi.mock('../../platform/useBundledServerStatus', () => ({
  useBundledServerStatus: () => null,
  restartBundledServer: vi.fn(),
}));
vi.mock('../../platform/PlatformProfileContext', async () => {
  const { credentialRecoveryPlatformProfileContext } = await import(
    './fixtures/credentialRecoveryPlatformProfileContext'
  );
  return credentialRecoveryPlatformProfileContext;
});

// The transport, `setClientCredentialResolver` and the credential callbacks
// are the subject here, so the SDK is kept REAL; only the React query hooks
// `OnboardingGate` reaches for are substituted, so this suite does not have to
// host a live query graph.
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  useForceRefetchSystemStatus: () => vi.fn(),
  useEngineConnectionsQuery: () => ({ data: [] }),
  useConfigQuery: () => ({ data: undefined }),
  useUpdateConfigMutation: () => ({ mutate: () => {}, isPending: false }),
}));

// The real store and the real provider; only the heavy connection-manager
// dialog (which this suite never opens) is substituted.
vi.mock('@kontourai/station-connect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-connect')>()),
  ConnectionManagerModal: () => null,
}));

import {
  authenticatedFetch,
  fetchEventStreamResumeCapability,
} from '@kontourai/station-sdk';
import { BannerHost } from '../../components/notifications/BannerHost';
import { OnboardingGate } from '../../components/OnboardingGate';
import { ApiBaseProvider } from '../ApiBaseContext';

const BANNER = /Request access to reconnect/i;

type ConnectionsApi = ReturnType<typeof useConnections>;

/** Captures the live connections API so a test can state its own baseline. */
let connections: ConnectionsApi | undefined;

function ConnectionsProbe() {
  connections = useConnections();
  return null;
}

async function renderShell() {
  render(
    <ApiBaseProvider>
      <ConnectionsProbe />
      <OnboardingGate>
        <div>App</div>
        <BannerHost />
      </OnboardingGate>
    </ApiBaseProvider>,
  );
  await screen.findByText('App');
  // `ConnectionsProvider` keeps ONE module-level store, and neither
  // `vi.resetModules` nor unmounting clears it — a mocked module's factory
  // result is cached across a registry reset, so a second test in this file
  // would silently inherit the first one's recovered connection and its 401
  // would be unobservable. Rather than fight that, every test states its own
  // baseline through the store's public API: a connection whose device session
  // is currently good, which is what a freshly bootstrapped browser has.
  const active = connections?.activeConnection;
  if (!active) throw new Error('no active connection to base the test on');
  await act(async () => {
    connections?.markDeviceSession(active.id);
  });
  expect(screen.queryByText(BANNER)).toBeNull();
}

/**
 * A `fetch` routed by path. Anything not named is rejected, so a background
 * request cannot consume a response this test meant for a specific call.
 */
function fetchByPath(routes: Record<string, () => Promise<Response>> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      for (const [path, respond] of Object.entries(routes)) {
        if (url.includes(path)) return respond();
      }
      return new Response('{"error":{"code":"authentication_required"}}', {
        status: 401,
      });
    }),
  );
}

describe('the reconnect banner is retired by an authenticated 2xx — and only by a current one', () => {
  beforeEach(() => {
    navigate.mockClear();
  });

  afterEach(() => {
    connections = undefined;
    vi.unstubAllGlobals();
  });

  it('shows the banner on a 401 and removes it on the next authenticated 2xx, within one render', async () => {
    const origin = window.location.origin;
    await renderShell();

    fetchByPath();
    await act(async () => {
      await authenticatedFetch(`${origin}/api/boot`);
    });
    expect((await screen.findByRole('alert')).textContent).toMatch(BANNER);

    // The cookie the bootstrap exchange installed is now present, and the very
    // next protected request is accepted. Nothing else happens — no health
    // probe, no reload, no navigation. `act` flushes the store update and the
    // effects it causes, so asserting straight after it is the "within one
    // render" claim rather than an eventual-consistency one: no `waitFor`.
    fetchByPath({ '/api/': async () => new Response('{"success":true}') });
    await act(async () => {
      await authenticatedFetch(`${origin}/api/settings`);
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(BANNER)).toBeNull();
  });

  it('keeps the banner when a 2xx that was issued BEFORE the 401 lands after it', async () => {
    // The lockout ordering. Request A is accepted but slow; request B meets a
    // revoked credential and raises the banner; A then lands and — before the
    // credential-generation guard — erased it. The user was left with no
    // banner, no "Request access", and a session that no longer works.
    const origin = window.location.origin;
    await renderShell();

    let releaseSlowSuccess: (() => void) | undefined;
    const slowSuccess = new Promise<void>((resolve) => {
      releaseSlowSuccess = resolve;
    });
    fetchByPath({
      '/api/projects': async () => {
        await slowSuccess;
        return new Response('{"success":true}');
      },
    });

    // A starts first and is still in flight.
    const slowRequest = authenticatedFetch(`${origin}/api/projects`);
    // B starts, is rejected, and raises the banner.
    await act(async () => {
      await authenticatedFetch(`${origin}/api/boot`);
    });
    expect((await screen.findByRole('alert')).textContent).toMatch(BANNER);

    // A finally lands, carrying a 200 that predates the rejection.
    await act(async () => {
      releaseSlowSuccess?.();
      await slowRequest;
    });

    expect(
      screen.queryByRole('alert')?.textContent ??
        'NO BANNER — the connection was falsely recovered',
    ).toMatch(BANNER);
  });

  it('does not let a 401 from before a pairing undo that pairing', async () => {
    // The damaging shape the SDK's response-time credential re-resolve caused:
    // a request leaves while the connection is unauthorized, the user completes
    // pairing, and the old request's 401 then lands bound to the NEW device
    // session — which `markCredentialRequired` deletes, putting the banner back
    // and undoing the pairing the user just finished. Both credential values
    // are `undefined` for a device session, so the store's equality guard
    // cannot tell the two apart; only the request-time generation can.
    //
    // This drives the REAL resolver: `ApiBaseProvider` installs it, the SDK
    // reports through it, and the store decides. The store's own
    // stale-unauthorized test hand-supplies the old credential and therefore
    // assumes what this test checks.
    const origin = window.location.origin;
    await renderShell();
    const id = connections?.activeConnection?.id as string;

    // The connection is currently unauthorized and the banner is up.
    fetchByPath();
    await act(async () => {
      await authenticatedFetch(`${origin}/api/boot`);
    });
    expect((await screen.findByRole('alert')).textContent).toMatch(BANNER);

    // Request A leaves now, carrying the unauthorized evidence.
    let releaseA: (() => void) | undefined;
    const aInFlight = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    fetchByPath({
      '/api/projects': async () => {
        await aInFlight;
        return new Response('{"error":{"code":"authentication_required"}}', {
          status: 401,
        });
      },
    });
    const requestA = authenticatedFetch(`${origin}/api/projects`);

    // The user completes pairing while A is still in flight.
    await act(async () => {
      connections?.markDeviceSession(id);
    });
    expect(screen.queryByRole('alert')).toBeNull();
    const generationAfterPairing = connections?.activeConnection;
    expect(generationAfterPairing?.credentialState).toBe('device-session');

    // A's 401 lands. It is about a session that no longer exists.
    await act(async () => {
      releaseA?.();
      await requestA;
    });

    expect(
      connections?.activeConnection?.credentialState,
      'a 401 from before the pairing deleted the paired device session',
    ).toBe('device-session');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not let a 401 from before a credential replacement delete the new credential', async () => {
    // The same shape with a saved bearer rather than a device session. Here the
    // equality guard alone would have held, so this pins that the generation
    // guard did not break the case that already worked.
    const origin = window.location.origin;
    await renderShell();
    const id = connections?.activeConnection?.id as string;

    let releaseA: (() => void) | undefined;
    const aInFlight = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    fetchByPath({
      '/api/projects': async () => {
        await aInFlight;
        return new Response('{}', { status: 401 });
      },
    });
    const requestA = authenticatedFetch(`${origin}/api/projects`);

    await act(async () => {
      connections?.setCredential(id, 'a-bearer-not-for-production');
    });

    await act(async () => {
      releaseA?.();
      await requestA;
    });

    expect(
      connections?.getConnectionCredential(id),
      'a 401 from before the replacement deleted the new credential',
    ).toBe('a-bearer-not-for-production');
    expect(connections?.activeConnection?.credentialState).toBe('saved');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('captures the credential and the address it is sent to as one live snapshot', async () => {
    // Between a synchronous connection switch and React committing the new
    // context, a resolver that mixed a LIVE credential with a RENDER-captured
    // `apiBase` would attach the new connection's credential to a request for
    // the old connection's origin. The store's origin check stops that from
    // causing a false recovery; it cannot un-send the credential.
    await renderShell();
    const before = connections;
    const renderedApiBase = before?.apiBase;

    // Switch synchronously, WITHOUT letting React commit.
    before?.setApiBase('https://switched.example.test');

    const evidence = before?.captureCredentialEvidence();
    expect(
      before?.apiBase,
      'the render capture was expected to still be stale here',
    ).toBe(renderedApiBase);
    // The live read is the switched connection, address and all; the render
    // is still the previous one. Before this was one call, the resolver
    // combined exactly these two rows.
    const renderedConnectionId = before?.activeConnection?.id;
    expect(renderedConnectionId).toBeTruthy();
    expect(evidence?.origin).toBe('https://switched.example.test');
    expect(evidence?.connectionId).toBeTruthy();
    expect(evidence?.connectionId).not.toBe(renderedConnectionId);

    // Put it back so the shared store does not leak into the next test.
    await act(async () => {
      before?.setApiBase(renderedApiBase as string);
    });
  });

  it('keeps the banner when only a deliberately PUBLIC endpoint answers 200', async () => {
    const origin = window.location.origin;
    await renderShell();

    fetchByPath();
    await act(async () => {
      await authenticatedFetch(`${origin}/api/boot`);
    });
    expect((await screen.findByRole('alert')).textContent).toMatch(BANNER);

    // The real production `authentication: 'omit'` caller: same origin, 200,
    // and deliberately unauthenticated. It says nothing about our credentials.
    fetchByPath({
      '/.well-known/station/v1': async () =>
        new Response('{"capabilities":{"eventStreamResume":true}}'),
    });
    await act(async () => {
      await fetchEventStreamResumeCapability(origin);
    });

    expect(
      screen.queryByRole('alert')?.textContent ??
        'NO BANNER — the connection was falsely recovered',
    ).toMatch(BANNER);
  });
});
