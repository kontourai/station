import type { SavedConnection } from '@kontourai/station-connect';

export type BrowserRelayAccountScopeSnapshot = {
  readonly state: 'pending' | 'ready';
  readonly authorityKey: string | null;
  readonly version: number;
  readonly scopeKey: string;
};

const snapshots = new Map<string, BrowserRelayAccountScopeSnapshot>();
const listeners = new Set<() => void>();
const PAGE_INSTANCE = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const CHANNEL_NAME = 'station-browser-relay-account-scope-v1';
const STORAGE_EVENT_KEY = 'station-browser-relay-account-scope-event-v1';
let channel: BroadcastChannel | null = null;

function sameScope(
  left: NonNullable<SavedConnection['brokerRoute']>['scope'],
  right: NonNullable<SavedConnection['brokerRoute']>['scope'],
) {
  return (
    left.stationId === right.stationId &&
    left.enrollmentId === right.enrollmentId &&
    left.routingGeneration === right.routingGeneration &&
    left.browserOrigin === right.browserOrigin
  );
}

/** Stable route identity shared by the light React scope and async credential custody. */
export function browserRelayAccountScopeKey(input: {
  connectionId: string;
  applicationOrigin: string;
  route: NonNullable<SavedConnection['brokerRoute']>;
  clientOrigin: string;
}) {
  const scope = input.route.scope;
  return JSON.stringify([
    input.connectionId,
    new URL(input.applicationOrigin).origin,
    input.route.brokerOrigin,
    scope.stationId,
    scope.enrollmentId,
    scope.routingGeneration,
    scope.browserOrigin,
    input.clientOrigin,
  ]);
}

function snapshotKey(value: unknown): value is {
  route: string;
  authorityKey: string | null;
  version: number;
  state: 'pending' | 'ready';
} {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.route === 'string' &&
    (record.authorityKey === null || typeof record.authorityKey === 'string') &&
    Number.isSafeInteger(record.version) &&
    (record.state === 'pending' || record.state === 'ready')
  );
}

function announce(
  routeKey: string,
  snapshot: BrowserRelayAccountScopeSnapshot,
) {
  const message = {
    route: routeKey,
    authorityKey: snapshot.authorityKey,
    version: snapshot.version,
    state: snapshot.state,
  };
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      channel ??= new BroadcastChannel(CHANNEL_NAME);
      channel.postMessage(message);
    }
  } catch {
    // Storage events below remain an independent signal where available.
  }
  try {
    window.localStorage.setItem(STORAGE_EVENT_KEY, JSON.stringify(message));
    window.localStorage.removeItem(STORAGE_EVENT_KEY);
  } catch {
    // A same-tab subscription still observes the published snapshot.
  }
}

function receive(value: unknown) {
  if (!snapshotKey(value)) return;
  publishBrowserRelayAccountScope(
    value.route,
    value.authorityKey,
    value.version,
    value.state,
    false,
  );
}

if (typeof window !== 'undefined') {
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(CHANNEL_NAME);
      channel.addEventListener('message', (event) => receive(event.data));
    }
    window.addEventListener('storage', (event) => {
      if (event.key !== STORAGE_EVENT_KEY || !event.newValue) return;
      try {
        receive(JSON.parse(event.newValue));
      } catch {
        // Ignore unrelated or malformed cross-tab notifications.
      }
    });
  } catch {
    channel = null;
  }
}

export function subscribeBrowserRelayAccountScope(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getBrowserRelayAccountScope(
  scopeKey: string | null,
): BrowserRelayAccountScopeSnapshot | null {
  return scopeKey ? (snapshots.get(scopeKey) ?? null) : null;
}

export function beginBrowserRelayAccountScopeChange(scopeKey: string) {
  const previous = snapshots.get(scopeKey);
  const version = (previous?.version ?? 0) + 1;
  publishBrowserRelayAccountScope(scopeKey, null, version, 'pending');
  return version;
}

export function publishBrowserRelayAccountScope(
  scopeKey: string,
  authorityKey: string | null,
  version: number,
  state: 'pending' | 'ready' = 'ready',
  shouldAnnounce = true,
) {
  if (!Number.isSafeInteger(version) || version < 0) return;
  const previous = snapshots.get(scopeKey);
  if (previous && version < previous.version) return;
  if (
    previous &&
    version === previous.version &&
    previous.state === 'ready' &&
    state === 'pending'
  )
    return;
  const scopeKeyValue =
    state === 'pending'
      ? `pending:${PAGE_INSTANCE}:${version}`
      : authorityKey
        ? `account:${authorityKey}:v${version}`
        : `no-account:${PAGE_INSTANCE}:${version}`;
  if (
    previous?.state === state &&
    previous.authorityKey === authorityKey &&
    previous.version === version &&
    previous.scopeKey === scopeKeyValue
  )
    return;
  const next = Object.freeze({
    state,
    authorityKey,
    version,
    scopeKey: scopeKeyValue,
  });
  snapshots.set(scopeKey, next);
  for (const listener of listeners) listener();
  if (shouldAnnounce) announce(scopeKey, next);
}

/** Verifies that UI scope and saved-route scope still refer to the same Station. */
export function browserRelayAccountScopeMatches(
  left: NonNullable<SavedConnection['brokerRoute']> | undefined,
  right: NonNullable<SavedConnection['brokerRoute']> | undefined,
) {
  return Boolean(
    left &&
      right &&
      left.brokerOrigin === right.brokerOrigin &&
      sameScope(left.scope, right.scope),
  );
}
