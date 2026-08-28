/**
 * archive#3601/archive#3602 — the response boundary is ordered after
 * the state it reports, in a browser that HAS the Web Locks API too.
 *
 * `ConnectionStore` serializes its shared-storage writes under a Web Lock, so
 * a credential transition is applied inside a lock callback rather than in the
 * calling tick. The user-visible contract the recovery suite pins — the
 * banner is gone the moment the accepted response resolves — therefore held
 * only where the store happened to be synchronous, which in this repo is every
 * test environment: jsdom has no `navigator.locks`.
 *
 * This file installs a Web-Locks-shaped manager on `navigator` BEFORE the
 * provider builds its store, so the production default (`navigator.locks`) is
 * what the real store picks up, and then asserts the same contract with no
 * `waitFor` and no extra flush.
 */
// @vitest-environment jsdom

import { useConnections } from '@kontourai/station-connect';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  useAgentConnectionsQuery: () => ({ data: [] }),
  useConfigQuery: () => ({ data: undefined }),
  useUpdateConfigMutation: () => ({ mutate: () => {}, isPending: false }),
}));

// The real store and the real provider; only the heavy connection-manager
// dialog (which this suite never opens) is substituted.
vi.mock('@kontourai/station-connect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-connect')>()),
  ConnectionManagerModal: () => null,
}));

import { authenticatedFetch } from '@kontourai/station-sdk';
import { BannerHost } from '../../components/notifications/BannerHost';
import { OnboardingGate } from '../../components/OnboardingGate';
import { ApiBaseProvider } from '../ApiBaseContext';

const BANNER = /Request access to reconnect/i;

type ConnectionsApi = ReturnType<typeof useConnections>;

let connections: ConnectionsApi | undefined;

function ConnectionsProbe() {
  connections = useConnections();
  return null;
}

/**
 * A Web-Locks-shaped manager: one queue per lock NAME, callbacks resolved on
 * the microtask queue. Installed on `navigator` so `ConnectionStore` finds it
 * exactly where it looks for the real one.
 */
function installLockManager() {
  const queues = new Map<string, Promise<unknown>>();
  const manager = {
    request(name: string, callback: () => void | Promise<void>) {
      const queue = queues.get(name) ?? Promise.resolve();
// Deferred to a MACROTASK, not a microtask: `act` drains microtasks, so
// a microtask-only lock would let the transition land whether or not the
// SDK awaited it, and this file would assert nothing.
      const run = queue
        .then(() => new Promise((resolve) => setTimeout(resolve, 0)))
        .then(() => callback());
      queues.set(
        name,
        run.then(
          () => undefined,
          () => undefined,
        ),
      );
      return run;
    },
  };
  Object.defineProperty(window.navigator, 'locks', {
    value: manager,
    configurable: true,
    writable: true,
  });
  return manager;
}

const lockManager = installLockManager();

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

describe('with Web Locks installed, the banner follows the awaited response', () => {
  afterEach(() => {
    connections = undefined;
    vi.unstubAllGlobals();
  });

  it('raises and retires the banner within the tick the response resolves in', async () => {
    const origin = window.location.origin;
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
// The store the provider built must be the one using the installed manager.
    expect(window.navigator.locks).toBe(lockManager);
    const active = connections?.activeConnection;
    if (!active) throw new Error('no active connection to base the test on');
    await act(async () => {
      connections?.markDeviceSession(active.id);
    });
    expect(screen.queryByText(BANNER)).toBeNull();

    fetchByPath();
    await act(async () => {
      await authenticatedFetch(`${origin}/api/boot`);
    });
// No `waitFor`: the 401 does not resolve before the rejection it reports.
    expect(screen.queryByRole('alert')?.textContent ?? 'NO BANNER').toMatch(
      BANNER,
    );

    fetchByPath({ '/api/': async () => new Response('{"success":true}') });
    await act(async () => {
      await authenticatedFetch(`${origin}/api/settings`);
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(BANNER)).toBeNull();
  });
});
