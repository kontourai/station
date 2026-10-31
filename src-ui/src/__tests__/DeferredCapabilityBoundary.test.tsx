/** @vitest-environment jsdom */

import {
  _setApiBase,
  useScheduledConversationTargetCapability,
} from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { lazy } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DeferredCapabilityBoundary } from '../components/DeferredCapabilityBoundary';
import {
  StationDetailsHost,
  WorkspaceStationState,
} from '../components/notifications/StationConditions';
import { openStationDetails } from '../components/notifications/stationDetailsEvents';
import {
  BANNER_IDS,
  BANNER_PRIORITY,
  bannerStore,
} from '../contexts/banner-store';
import { toastStore } from '../contexts/ToastContext';
import { EXTENSIONS_UNAVAILABLE_LABEL } from '../core/pluginRegistryCopy';

const connection = vi.hoisted(() => ({
  status: 'connected' as 'connected' | 'connecting' | 'error',
}));

vi.mock('@kontourai/station-connect', () => ({
  useConnectionStatus: () => ({ status: connection.status }),
  useConnections: () => ({
    apiBase: 'https://station.test',
    activeConnection: {
      id: 'station',
      name: 'Studio Station',
      url: 'https://station.test',
    },
  }),
}));

const copy = {
  failureTitle: 'Connection recovery is unavailable',
  failure: 'Station could not start connection recovery.',
};

function BrokenCapability(): never {
  throw new Error('broken deferred capability');
}

describe('DeferredCapabilityBoundary', () => {
  afterEach(() => {
    cleanup();
    connection.status = 'connected';
    bannerStore.reset();
    toastStore.clear();
    vi.restoreAllMocks();
  });

  test('a host capability change refreshes without an extension reload notice', async () => {
    let supported = false;
    _setApiBase('http://station.test');
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            schemaVersion: 1,
            environmentId: '00000000-0000-4000-8000-000000000000',
            authentication: { scheme: 'bearer', protocolVersion: 1 },
            transports: { http: 1, sse: 1, websocket: 1 },
            compatibility: {
              serverVersion: '0.1.11',
              protocolVersion: 3,
              minClientProtocol: 1,
              capabilities: {
                remoteAuth: 1,
                devicePairing: 1,
                environmentProof: 1,
              },
            },
            capabilities: {
              sessionEventWindow: true,
              scheduledConversationTarget: supported,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    function Capability() {
      const query = useScheduledConversationTargetCapability();
      return <span>{String(query.data)}</span>;
    }
    try {
      render(
        <QueryClientProvider client={client}>
          <DeferredCapabilityBoundary
            id="capability-change"
            copy={copy}
            failurePresentation="notification"
          >
            <Capability />
          </DeferredCapabilityBoundary>
        </QueryClientProvider>,
      );
      await waitFor(() => expect(screen.getByText('false')).toBeTruthy());
      supported = true;
      await act(async () => {
        await client.invalidateQueries({
          queryKey: ['scheduler', 'conversation-target-capability'],
        });
      });
      await waitFor(() => expect(screen.getByText('true')).toBeTruthy());
      expect(toastStore.getSnapshot()).toEqual([]);
    } finally {
      cleanup();
      client.clear();
      vi.unstubAllGlobals();
      _setApiBase('');
    }
  });

  test('keeps loading silent while the shell stays mounted', () => {
    const Never = lazy(() => new Promise<never>(() => {}));

    render(
      <>
        <main>Usable Station workspace</main>
        <DeferredCapabilityBoundary id="connection-recovery" copy={copy}>
          <Never />
        </DeferredCapabilityBoundary>
        <WorkspaceStationState />
        <StationDetailsHost />
      </>,
    );

    expect(screen.getByText('Usable Station workspace')).toBeTruthy();
    expect(bannerStore.getSnapshot()).toEqual([]);
    // An empty store is not silence: a Suspense fallback rendering its own
    // notice bypasses the store entirely, which is exactly the hand-rolled
    // surface this issue retired. Assert nothing is announced at all.
    expect(
      document.querySelector('[data-deferred-capability-pending]'),
    ).not.toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('keeps the shell mounted and exposes capability repair through Station details', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <>
        <main>Usable Station workspace</main>
        <DeferredCapabilityBoundary id="connection-recovery" copy={copy}>
          <BrokenCapability />
        </DeferredCapabilityBoundary>
        <WorkspaceStationState />
        <StationDetailsHost />
      </>,
    );

    expect(screen.getByText('Usable Station workspace')).toBeTruthy();
    await waitFor(() => expect(bannerStore.getSnapshot()).toHaveLength(1));
    expect(bannerStore.getSnapshot()[0]).toMatchObject({
      id: `${BANNER_IDS.deferredCapability}:connection-recovery`,
      priority: BANNER_PRIORITY.capabilityFailure,
      tone: 'error',
      badge: copy.failureTitle,
      message: copy.failure,
      dismissible: false,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review Station' }));
    expect(
      within(screen.getByRole('dialog', { name: 'Station details' })).getByRole(
        'button',
        { name: 'Reload Station' },
      ),
    ).toBeTruthy();
  });

  test('reports a rejected import as persistent capability failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const Failing = lazy(() => Promise.reject(new Error('chunk unavailable')));

    render(
      <>
        <main>Usable Station workspace</main>
        <DeferredCapabilityBoundary id="connection-recovery" copy={copy}>
          <Failing />
        </DeferredCapabilityBoundary>
        <WorkspaceStationState />
        <StationDetailsHost />
      </>,
    );

    await waitFor(() => expect(bannerStore.getSnapshot()).toHaveLength(1));
    expect(bannerStore.getSnapshot()[0]?.message).toBe(copy.failure);
    expect(screen.getByText('Usable Station workspace')).toBeTruthy();
  });

  test('keeps an outage-caused import failure quiet and retries it automatically after reconnect', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    connection.status = 'error';
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('host unavailable'))
      .mockResolvedValueOnce({
        default: () => <div>Recovered capability</div>,
      });

    const view = render(
      <>
        <DeferredCapabilityBoundary
          id="connection-recovery"
          copy={copy}
          load={load}
        />
        <WorkspaceStationState />
        <StationDetailsHost />
      </>,
    );

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    await act(async () => undefined);
    expect(bannerStore.getSnapshot()).toEqual([]);

    connection.status = 'connected';
    view.rerender(
      <>
        <DeferredCapabilityBoundary
          id="connection-recovery"
          copy={copy}
          load={load}
        />
        <WorkspaceStationState />
        <StationDetailsHost />
      </>,
    );

    expect(await screen.findByText('Recovered capability')).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
    expect(bannerStore.getSnapshot()).toEqual([]);
  });

  test('keeps a genuine import failure loud when the connection is healthy', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const load = vi.fn().mockRejectedValue(new Error('broken bundle'));

    render(
      <>
        <DeferredCapabilityBoundary
          id="connection-recovery"
          copy={copy}
          load={load}
        />
        <WorkspaceStationState />
        <StationDetailsHost />
      </>,
    );

    await waitFor(() => expect(bannerStore.getSnapshot()).toHaveLength(1));
    expect(bannerStore.getSnapshot()[0]?.badge).toBe(copy.failureTitle);
    fireEvent.click(screen.getByRole('button', { name: 'Review Station' }));
    expect(
      within(screen.getByRole('dialog', { name: 'Station details' })).getByRole(
        'button',
        { name: 'Reload Station' },
      ),
    ).toBeTruthy();
  });

  test('keeps independent capability failures readable and repairable in Station details', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const extensionCopy = {
      failureTitle: EXTENSIONS_UNAVAILABLE_LABEL,
      failure: 'Station could not start the extension registry.',
    };

    render(
      <>
        <DeferredCapabilityBoundary id="connection-recovery" copy={copy}>
          <BrokenCapability />
        </DeferredCapabilityBoundary>
        <DeferredCapabilityBoundary
          id="extension-registry"
          copy={extensionCopy}
        >
          <BrokenCapability />
        </DeferredCapabilityBoundary>
        <WorkspaceStationState />
        <StationDetailsHost />
      </>,
    );

    await waitFor(() => expect(bannerStore.getSnapshot()).toHaveLength(2));
    expect(bannerStore.getSnapshot().map((banner) => banner.id)).toEqual([
      `${BANNER_IDS.deferredCapability}:connection-recovery`,
      `${BANNER_IDS.deferredCapability}:extension-registry`,
    ]);
    act(openStationDetails);
    const details = screen.getByRole('dialog', { name: 'Station details' });
    expect(within(details).getByText(copy.failure)).toBeTruthy();
    expect(within(details).getByText(extensionCopy.failure)).toBeTruthy();
    expect(
      within(details).getAllByRole('button', { name: 'Reload Station' }),
    ).toHaveLength(2);
  });

  test('an extension bootstrap failure can notify without occupying the global banner', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <DeferredCapabilityBoundary
        id="extension-registry"
        failurePresentation="notification"
        copy={{
          failureTitle: EXTENSIONS_UNAVAILABLE_LABEL,
          failure: 'Extensions could not start.',
        }}
      >
        <BrokenCapability />
      </DeferredCapabilityBoundary>,
    );
    await waitFor(() => expect(toastStore.getSnapshot()).toHaveLength(1));
    expect(toastStore.getSnapshot()[0]?.message).toContain(
      EXTENSIONS_UNAVAILABLE_LABEL,
    );
    expect(toastStore.getSnapshot()[0]?.actions?.[0]?.label).toBe(
      'Reload Station',
    );
    expect(bannerStore.getSnapshot()).toHaveLength(0);
  });

  test('dismisses its failure banner on unmount', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = render(
      <DeferredCapabilityBoundary id="connection-recovery" copy={copy}>
        <BrokenCapability />
      </DeferredCapabilityBoundary>,
    );

    await waitFor(() => expect(bannerStore.getSnapshot()).toHaveLength(1));
    view.unmount();
    expect(bannerStore.getSnapshot()).toEqual([]);
  });
});
