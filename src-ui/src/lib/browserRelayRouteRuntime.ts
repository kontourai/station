import type { SavedConnection } from '@kontourai/station-connect';
import { openDeviceConnectionTrustStore } from '@kontourai/station-connect/connection-trust';
import {
  BrowserRoutingGrantCustody,
  createBrowserPionConnection,
  createSelfHostedApplicationTransport,
  SelfHostedBrokerBrowserClient,
} from '@kontourai/station-connect/self-hosted-browser';

type RouteBinding = {
  connectionId: string;
  selectionEpoch: number;
  route: NonNullable<SavedConnection['brokerRoute']>;
  applicationOrigin: string;
  transport: typeof fetch;
  isCurrent(): boolean;
  close(): void;
};

let prepared: RouteBinding | null = null;
let preparing: { controller: AbortController; selectionEpoch: number } | null =
  null;

function sameRoute(
  left: NonNullable<SavedConnection['brokerRoute']>,
  right: NonNullable<SavedConnection['brokerRoute']>,
) {
  return (
    left.brokerOrigin === right.brokerOrigin &&
    left.scope.stationId === right.scope.stationId &&
    left.scope.enrollmentId === right.scope.enrollmentId &&
    left.scope.routingGeneration === right.scope.routingGeneration &&
    left.scope.browserOrigin === right.scope.browserOrigin
  );
}

/** Broker preparation has no direct-HTTP fallback and never persists a bearer. */
export async function prepareBrowserRelayRoute(
  connection: SavedConnection,
  selectionEpoch: number,
  isSelectionCurrent: () => boolean = () => true,
): Promise<void> {
  const route = connection.brokerRoute;
  if (!route) return;
  // A failed replacement must leave the previously selected route usable.
  // Retire only an older *pending* attempt; the successful candidate takes
  // ownership after its trust, grant and peer checks have all passed.
  preparing?.controller.abort(new Error('Station broker route superseded'));
  preparing = null;
  if (route.scope.browserOrigin !== window.location.origin)
    throw new Error(
      'This Station route belongs to a different browser origin.',
    );
  const lifetime = new AbortController();
  preparing = { controller: lifetime, selectionEpoch };
  const trustStore = await openDeviceConnectionTrustStore();
  const custody = new BrowserRoutingGrantCustody();
  let owner: ReturnType<typeof createBrowserPionConnection> | null = null;
  let transport: ReturnType<
    typeof createSelfHostedApplicationTransport
  > | null = null;
  try {
    lifetime.signal.throwIfAborted();
    const trustRecord = await trustStore.read(route.scope.stationId);
    if (
      trustRecord?.status !== 'approved' ||
      trustRecord.trust.enrollmentId !== route.scope.enrollmentId
    )
      throw new Error(
        'Approve this Station signing key before using its broker route.',
      );
    const restored = await custody.restore({
      brokerOrigin: route.brokerOrigin,
      scope: route.scope,
      trustRecord,
      trustStore,
    });
    lifetime.signal.throwIfAborted();
    if (!restored)
      throw new Error('This browser has no current routing grant.');
    const broker = new SelfHostedBrokerBrowserClient({
      brokerOrigin: route.brokerOrigin,
      browserOrigin: window.location.origin,
      scope: route.scope,
      credentials: custody,
    });
    owner = createBrowserPionConnection({
      broker,
      applicationOrigin: connection.url,
      trustRecord,
      trustStore,
      // Host candidates support the free same-network pilot. A remote route
      // needs an operator-supplied ICE configuration before it is offered.
      ice: {
        capture: () => ({
          configuration: { iceServers: [] },
          isCurrent: () => true,
        }),
      },
    });
    const snapshot = await owner.connect(lifetime.signal);
    lifetime.signal.throwIfAborted();
    transport = createSelfHostedApplicationTransport({
      owner,
      snapshot,
      applicationOrigin: connection.url,
      signal: lifetime.signal,
    });
    const currentOwner = owner;
    const currentTransport = transport;
    if (!isSelectionCurrent())
      throw new Error('Station route selection was superseded');
    const next: RouteBinding = {
      connectionId: connection.id,
      selectionEpoch,
      route,
      applicationOrigin: connection.url,
      // The application adapter accepts fetch inputs at runtime; its public
      // target interface narrows the input to Request for channel fixtures.
      transport: currentTransport.transport as unknown as typeof fetch,
      isCurrent: () =>
        !lifetime.signal.aborted &&
        prepared?.transport === currentTransport.transport &&
        currentTransport.transportBindingIsCurrent(),
      close: () => {
        lifetime.abort(new Error('Station broker route retired'));
        currentTransport.close();
        currentOwner.close();
        custody.invalidate();
        trustStore.close();
      },
    };
    if (!isSelectionCurrent())
      throw new Error('Station route selection was superseded');
    const previous = prepared;
    prepared = next;
    previous?.close();
    if (preparing?.controller === lifetime) preparing = null;
  } catch (error) {
    lifetime.abort(error);
    transport?.close();
    owner?.close();
    custody.invalidate();
    trustStore.close();
    if (preparing?.controller === lifetime) preparing = null;
    throw error;
  }
}

export function retireBrowserRelayRoute(
  connectionId?: string,
  selectionEpoch?: number,
): void {
  if (
    preparing &&
    (selectionEpoch === undefined ||
      preparing.selectionEpoch === selectionEpoch)
  ) {
    preparing.controller.abort(new Error('Station broker route retired'));
    preparing = null;
  }
  if (
    prepared &&
    (!connectionId || prepared.connectionId === connectionId) &&
    (selectionEpoch === undefined || prepared.selectionEpoch === selectionEpoch)
  ) {
    const old = prepared;
    prepared = null;
    old.close();
  }
}

export function captureBrowserRelayRoute(
  connectionId: string,
  applicationOrigin: string,
  route: NonNullable<SavedConnection['brokerRoute']>,
): Pick<RouteBinding, 'transport' | 'isCurrent'> | null {
  const current = prepared;
  return current &&
    current.connectionId === connectionId &&
    current.applicationOrigin === applicationOrigin &&
    sameRoute(current.route, route) &&
    current.isCurrent()
    ? current
    : null;
}
