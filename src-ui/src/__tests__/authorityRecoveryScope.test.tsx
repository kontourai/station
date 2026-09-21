/**
 * #481 recovery composition — REAL SDK dispatch/body guards across a
 * same-origin authority change.
 *
 * The companion suite (`authorityRecoveryComposition`) proves key
 * partitioning with a wire double at the SDK seam. A double cannot prove
 * the join this slice adds: the render-captured `requestScope` threaded
 * through the REAL `getJson`/`mutateJson`, which verify the capture
 * against the live credential-resolver settlement before dispatch AND
 * around every owned body read. So this file doubles ONLY the wire
 * (`global fetch`, deferred per-URL) and runs production code everywhere
 * else: the real `ApiBaseProvider` (real `ConnectionStore`, real
 * credential bridge → real resolver), the real `RecoveryQueryBoundary`,
 * the real `useRecoveryConfig`, and the real disclosure decision.
 *
 * Covered:
 *  1. A deferred old config body resolving AFTER a same-origin
 *     credential rotation never populates the current recovery view,
 *     and the stale entry schedules no further wire dispatch.
 *  2. A disclosure decision initiated for A (receipt write) across the
 *     same rotation fails closed: nothing is acknowledged under B, and
 *     the retry targets the current authority and lands there.
 *
 * Each test states its own baseline through the public connections API
 * on unique origins and removes its rows afterwards.
 *
 * @vitest-environment jsdom
 */

import { useConnections } from '@kontourai/station-connect';
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  recoveryDisclosureKey,
  resetUsageTelemetryDisclosureDismissal,
  UsageTelemetryDisclosure,
} from '../components/UsageTelemetryDisclosure';
import { ApiBaseProvider } from '../contexts/ApiBaseContext';
import {
  RecoveryQueryBoundary,
  useRecoveryScope,
} from '../contexts/RecoveryQueryBoundary';
import { recoveryConfigKey, useRecoveryConfig } from '../hooks/useRecoveryConfig';

vi.mock('../platform/useBundledServerStatus', () => ({
  useBundledServerStatus: () => null,
  restartBundledServer: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const okResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200 });

interface Harness {
  plan: Map<string, () => Promise<Response>>;
  fetchLog: { url: string; method: string }[];
  configSnapshots: string[];
  scopes: { apiBase: string; identityKey: string }[];
  recoveryClient: QueryClient | undefined;
  cacheDump: string[];
}

function createHarness(): Harness {
  return {
    plan: new Map(),
    fetchLog: [],
    configSnapshots: [],
    scopes: [],
    recoveryClient: undefined,
    cacheDump: [],
  };
}

let harness: Harness;
let client: QueryClient;

function installFetchDouble(active: Harness): void {
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    active.fetchLog.push({ url, method: init?.method ?? 'GET' });
    // Longest-prefix match so per-URL plans win over shared fallbacks.
    const plans = [...active.plan.entries()].sort(
      ([a], [b]) => b.length - a.length,
    );
    for (const [prefix, behavior] of plans) {
      if (url.startsWith(prefix)) return behavior();
    }
    throw new Error(`no fetch plan for ${init?.method ?? 'GET'} ${url}`);
  });
}

type ConnectionsApi = ReturnType<typeof useConnections>;
let connections: ConnectionsApi | undefined;

function ConnectionsProbe() {
  connections = useConnections();
  return null;
}

function ScopeProbe() {
  const scope = useRecoveryScope();
  harness.scopes.push({
    apiBase: scope.apiBase,
    identityKey: scope.identityKey,
  });
  return null;
}

function CacheProbe() {
  const queryClient = useQueryClient();
  // The boundary owns its inner client (production parity: in main.tsx
  // it sits under the bootstrap provider the same way). Assertions on
  // recovery entries must read THIS client, not the outer test client.
  harness.recoveryClient = queryClient;
  harness.cacheDump = queryClient
    .getQueryCache()
    .getAll()
    .map((q) => JSON.stringify(q.queryKey));
  return null;
}

function ConfigObserver() {
  const config = useRecoveryConfig();
  // Name the failure in the snapshot so a guard trip is diagnosable from
  // the DOM instead of a bare "error".
  const snapshot = config.data
    ? JSON.stringify(config.data)
    : `${config.status}:${config.error?.name ?? ''}:${config.error?.message ?? ''}`;
  harness.configSnapshots.push(snapshot);
  return <div data-testid="recovery-config" data-config={snapshot} />;
}

let homeCounter = 5000;
const homeUrl = (tag: string): string => {
  homeCounter += 1;
  return `http://${tag}-${homeCounter}.scope.test:3141`;
};
const createdHomeIds: string[] = [];

async function addHome(tag: string): Promise<{ id: string; url: string }> {
  const url = homeUrl(tag);
  let id = '';
  await act(async () => {
    id = connections?.addConnection(`Home-${tag}`, url).id ?? '';
  });
  if (!id) throw new Error(`no connection for ${url}`);
  createdHomeIds.push(id);
  return { id, url };
}

async function switchTo(id: string): Promise<void> {
  await act(async () => {
    await connections?.setActiveConnection(id);
  });
}

function renderScopeTree(node: React.ReactNode) {
  client = new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
      },
    },
  });
  return render(
    <ApiBaseProvider>
      <ConnectionsProbe />
      <QueryClientProvider client={client}>
        <RecoveryQueryBoundary>
          <ScopeProbe />
          <CacheProbe />
          {node}
        </RecoveryQueryBoundary>
      </QueryClientProvider>
    </ApiBaseProvider>,
  );
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await act(async () => {
    connections?.resetToDefault();
    for (const id of createdHomeIds.splice(0)) {
      connections?.removeCredential(id);
      connections?.removeConnection(id);
    }
  });
  connections = undefined;
  resetUsageTelemetryDisclosureDismissal();
});

const configEnvelope = (telemetryEnabled: boolean) => ({
  success: true,
  data: { telemetryEnabled },
});

const DISCLOSURE_BODY = {
  acknowledged: false,
  inventoryRevision: 'rev-scope',
  endpointConfigured: false,
  telemetryEnabled: true,
  enabledSource: 'config',
  events: {
    station_started: {
      description: 'Station completed startup.',
      properties: { platform: { domain: ['linux'] } },
    },
  },
};

const disclosureEnvelope = (body: unknown) => ({ data: body });

describe('recovery request authority (real SDK guards)', () => {
  it('a deferred old body resolving after rotation is never committed and schedules no redispatch', async () => {
    // Proven by fault-injection to rest on cancellation + key partition,
    // NOT on the body guard alone: a boundary-cancelled read never
    // commits even unguarded (its retryer is discarded), so removing the
    // read's `requestScope` still passes this test. The guard is
    // defense-in-depth for reads — and load-bearing for WRITES, which
    // `cancelQueries` does not touch (proven by the next test, which
    // fails with the ack's scope removed).
    harness = createHarness();
    installFetchDouble(harness);
    const { unmount } = renderScopeTree(<ConfigObserver />);
    const { id: idA, url: urlA } = await addHome('scopebody');
    // The plan always serves the CURRENT deferred payload, building a
    // FRESH Response per dispatch: several dispatches can share one
    // payload (initial + boundary reset-refetch), and a shared Response
    // body reads exactly once.
    let currentPayload = deferred<unknown>();
    harness.plan.set('', async () => okResponse(await currentPayload.promise));
    await switchTo(idA);
    await waitFor(() =>
      expect(
        screen.getByTestId('recovery-config').getAttribute('data-config'),
      ).toContain('pending'),
    );
    const scopeAKey = harness.scopes.at(-1)?.identityKey;
    expect(scopeAKey).toBeTruthy();

    // Same-origin rotation with the A read still in flight, then a NEW
    // body for the refetch. The boundary cancels the in-flight read;
    // this double ignores abort signals (the signal-ignoring completion
    // class), so the late body still reaches the query pipeline — where
    // the cancelled retryer discards it AND the guarded decode would
    // fail it. Either layer alone keeps it out of every entry.
    const oldPayload = currentPayload;
    currentPayload = deferred<unknown>();
    await act(async () => {
      connections?.setCredential(idA, 'rotated-credential');
    });
    await waitFor(() =>
      expect(harness.scopes.at(-1)?.identityKey).not.toBe(scopeAKey),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId('recovery-config').getAttribute('data-config'),
      ).toContain('pending'),
    );
    const mark = harness.configSnapshots.length;
    const dispatchesAtRotation = harness.fetchLog.length;
    expect(dispatchesAtRotation).toBeGreaterThanOrEqual(2);

    // The stale body resolves late. The guarded decode must fail it:
    // even its OWN entry never commits the old bytes (a signal-only
    // world would store them), and any retry fails the pre-dispatch
    // check before a new wire dispatch. (React Query's default first
    // retry delay is ~1s, so hold past it.)
    await act(async () => {
      oldPayload.resolve({
        success: true,
        data: { home: idA, rotation: 0 },
      });
      await new Promise((resolve) => setTimeout(resolve, 1500));
    });
    expect(harness.fetchLog.length).toBe(dispatchesAtRotation);
    expect(
      harness.recoveryClient
        ?.getQueryState(recoveryConfigKey(urlA, scopeAKey!))?.data,
    ).toBeUndefined();
    for (const snapshot of harness.configSnapshots.slice(mark)) {
      expect(snapshot).not.toContain('"rotation":0');
    }

    // The new body populates under the new identity.
    await act(async () => {
      currentPayload.resolve({
        success: true,
        data: { home: idA, rotation: 1 },
      });
    });
    await waitFor(() =>
      expect(
        screen.getByTestId('recovery-config').getAttribute('data-config'),
      ).toContain('"rotation":1'),
    );
    unmount();
  });

  it('a decision initiated for A cannot acknowledge B after a rotation; the retry lands on the current authority', async () => {
    harness = createHarness();
    installFetchDouble(harness);
    const { unmount } = renderScopeTree(<UsageTelemetryDisclosure />);
    const { id: idA, url: urlA } = await addHome('scopewrite');
    // One fallback routing by path serves every origin in this tree:
    // the inventory + config reads resolve immediately, the receipt
    // write waits on the deferred the test controls.
    // Fresh Response per dispatch (a shared body reads exactly once);
    // the receipt waits on the deferred payload the test controls.
    const ackPayload = deferred<unknown>();
    harness.plan.set('', async () => {
      const last = harness.fetchLog.at(-1);
      if (last?.url.endsWith('/disclosure/acknowledgements')) {
        return okResponse(await ackPayload.promise);
      }
      if (last?.url.endsWith('/config/app')) {
        return okResponse(configEnvelope(true));
      }
      return okResponse(disclosureEnvelope(DISCLOSURE_BODY));
    });
    await switchTo(idA);
    await waitFor(() =>
      expect(screen.getByText('Keep usage telemetry on')).not.toBeNull(),
    );
    const scopeAKey = harness.scopes.at(-1)?.identityKey;
    expect(scopeAKey).toBeTruthy();

    // "Keep" with the state already durable is receipt-only: one POST
    // captured against A's authority.
    fireEvent.click(screen.getByText('Keep usage telemetry on'));
    await waitFor(() =>
      expect(
        harness.fetchLog.filter((entry) =>
          entry.url.endsWith('/disclosure/acknowledgements'),
        ).length,
      ).toBe(1),
    );

    // Rotate before the receipt lands.
    await act(async () => {
      connections?.setCredential(idA, 'rotated-credential');
    });
    await waitFor(() =>
      expect(harness.scopes.at(-1)?.identityKey).not.toBe(scopeAKey),
    );
    const scopeBKey = harness.scopes.at(-1)?.identityKey;
    expect(scopeBKey).toBeTruthy();

    // The A-captured receipt resolves late: the guarded decode fails
    // instead of acknowledging under B.
    await act(async () => {
      ackPayload.resolve(
        disclosureEnvelope({ ...DISCLOSURE_BODY, acknowledged: true }),
      );
    });
    await waitFor(() =>
      expect(
        screen.getByText('The disclosure acknowledgement could not be saved.'),
      ).not.toBeNull(),
    );
    // No retarget, no retry storm: exactly one receipt dispatch, and
    // neither authority's entry holds the acknowledgement.
    expect(
      harness.fetchLog.filter((entry) =>
        entry.url.endsWith('/disclosure/acknowledgements'),
      ).length,
    ).toBe(1);
    // B's entry holds its own fresh unacknowledged inventory — A's late
    // receipt did not mark it — and A's entry never received the ack at
    // all (without the decode guard it would hold acknowledged:true).
    expect(
      harness.recoveryClient?.getQueryData(
        recoveryDisclosureKey(urlA, scopeBKey!),
      ),
    ).toMatchObject({ acknowledged: false });
    expect(
      harness.recoveryClient?.getQueryData(
        recoveryDisclosureKey(urlA, scopeAKey!),
      ),
    ).toBeUndefined();
    expect(screen.getByText('Try again')).not.toBeNull();

    // The retry is a NEW intent against the current authority: it
    // dispatches once more and the acknowledgement lands on B's entry.
    fireEvent.click(screen.getByText('Try again'));
    await waitFor(() =>
      expect(
        harness.fetchLog.filter((entry) =>
          entry.url.endsWith('/disclosure/acknowledgements'),
        ).length,
      ).toBe(2),
    );
    await waitFor(() =>
      expect(screen.getByText('You acknowledged this inventory.')).not.toBeNull(),
    );
    expect(
      harness.recoveryClient?.getQueryData(
        recoveryDisclosureKey(urlA, scopeBKey!),
      ),
    ).toMatchObject({ acknowledged: true });
    unmount();
  });
});
