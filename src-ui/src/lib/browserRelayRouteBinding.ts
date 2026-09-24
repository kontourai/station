import type { SavedConnection } from '@kontourai/station-connect';

export type RouteBinding = {
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

export function beginBrowserRelayPreparation(selectionEpoch: number) {
  preparing?.controller.abort(new Error('Station broker route superseded'));
  const controller = new AbortController();
  preparing = { controller, selectionEpoch };
  return controller;
}

export function finishBrowserRelayPreparation(controller: AbortController) {
  if (preparing?.controller === controller) preparing = null;
}

export function browserRelayBindingIsPublished(transport: typeof fetch) {
  return prepared?.transport === transport;
}

/** Called only after trust, grant, peer and live selection checks pass. */
export function publishBrowserRelayBinding(next: RouteBinding) {
  const previous = prepared;
  prepared = next;
  previous?.close();
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
