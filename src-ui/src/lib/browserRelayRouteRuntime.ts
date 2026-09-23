import type { SavedConnection } from '@kontourai/station-connect';
import { openDeviceConnectionTrustStore } from '@kontourai/station-connect/connection-trust';
import {
  BrowserRoutingGrantCustody,
  createBrowserPionConnection,
  createSelfHostedApplicationTransport,
  SelfHostedBrokerBrowserClient,
} from '@kontourai/station-connect/self-hosted-browser';
import {
  beginBrowserRelayPreparation,
  browserRelayBindingIsPublished,
  finishBrowserRelayPreparation,
  publishBrowserRelayBinding,
  type RouteBinding,
  retireBrowserRelayRoute,
} from './browserRelayRouteBinding';

/** Broker preparation has no direct-HTTP fallback and never persists a bearer. */
export async function prepareBrowserRelayRoute(
  connection: SavedConnection,
  selectionEpoch: number,
  isSelectionCurrent: () => boolean = () => true,
): Promise<void> {
  const route = connection.brokerRoute;
  if (!route) return;
  if (route.scope.browserOrigin !== window.location.origin)
    throw new Error(
      'This Station route belongs to a different browser origin.',
    );
  // A failed candidate leaves the selected route usable.
  const lifetime = beginBrowserRelayPreparation(selectionEpoch);
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
        browserRelayBindingIsPublished(
          currentTransport.transport as unknown as typeof fetch,
        ) &&
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
    publishBrowserRelayBinding(next);
    finishBrowserRelayPreparation(lifetime);
    const { hydrateBrowserRelayApplicationAuthorityScope } = await import(
      './browserRelayApplicationAuthority'
    );
    await hydrateBrowserRelayApplicationAuthorityScope({
      connectionId: connection.id,
      applicationOrigin: connection.url,
      route,
    });
    if (!isSelectionCurrent())
      throw new Error('Station route selection was superseded');
  } catch (error) {
    lifetime.abort(error);
    retireBrowserRelayRoute(connection.id, selectionEpoch);
    transport?.close();
    owner?.close();
    custody.invalidate();
    trustStore.close();
    finishBrowserRelayPreparation(lifetime);
    throw error;
  }
}
