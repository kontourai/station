import type { StationProfileCredentialRef } from '@kontourai/station-contracts';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import { ConnectionStore } from '../core/ConnectionStore';
import { defaultCredentialStorage, defaultStorage } from '../core/storage';
import type {
  ConnectionCredentialProvider,
  InjectedConnection,
  SavedConnection,
  StationHandshakeIdentity,
  StorageAdapter,
} from '../core/types';

const FALLBACK_URL =
  typeof window !== 'undefined'
    ? window.location.origin
    : 'http://localhost:3141';
const LEGACY_KEY = 'project-station-api-base';
const DEFAULT_STORAGE_KEY = 'station-connect-connections';
export const DEFAULT_CONNECTION_CREDENTIAL_KEY = `${DEFAULT_STORAGE_KEY}-credentials`;

/**
 * Inline fallback native-shell detector (station#1286). `packages/connect` is
 * platform-blind by design, so hosts are expected to pass `nativeShell`
 * explicitly (e.g. `src-ui`'s `ApiBaseProvider` passes `PlatformProfile.isTauri`,
 * which already awaits a capability report). This mirrors
 * `src-ui/src/platform/native/index.ts`'s `hasTauriRuntime()` so a caller that
 * omits the prop (tests, out-of-tree hosts) still gets the correct answer from
 * Tauri's official runtime marker rather than silently defaulting to `false`.
 */
function detectNativeShell(): boolean {
  return (
    typeof window !== 'undefined' &&
    // ES2020-safe (this package targets ES2020; `Object.hasOwn` is ES2022 and
    // breaks `build:connect` -> the desktop/Android bundles). This also avoids
    // invoking a potentially replaced prototype builtin on the host object.
    Object.getOwnPropertyDescriptor(window, '__TAURI_INTERNALS__') !== undefined
  );
}

interface ConnectionsContextType {
  connections: SavedConnection[];
  activeConnection: SavedConnection | null;
  /** Active URL — backward-compat alias for activeConnection.url */
  apiBase: string;
  /**
   * True when the page itself is served by a native shell (e.g. Tauri's
   * `tauri://localhost`) rather than a real web origin — station#1286. Used
   * by `useConnectionStatus` to classify `clientProtocol` as `'native:'`
   * instead of asserting `'https:'` from a non-`http:` window protocol.
   */
  nativeShell: boolean;
  addConnection: (name: string, url: string) => SavedConnection;
  removeConnection: (id: string) => void;
  updateConnection: (
    id: string,
    changes: Partial<Pick<SavedConnection, 'name' | 'url' | 'sshForward'>>,
  ) => void;
  reconcileHandshake: (
    id: string,
    handshake: StationHandshakeIdentity,
  ) => SavedConnection | null;
  commitVerifiedPairing?: (input: {
    connectionId: string;
    name: string;
    endpoint: string;
    handshake: StationHandshakeIdentity;
    clientInstanceId: string;
    credential?: string;
    credentialHandle?: string;
    nextCredentialRef?: StationProfileCredentialRef;
  }) => Promise<string | undefined>;
  /** Explicit host action that promotes one shared Station to the CLI default. */
  makeDefaultProfile?: (connectionId: string) => Promise<void>;
  setCredential: (id: string, credential: string) => void;
  markDeviceSession: (id: string) => void;
  removeCredential: (id: string) => void;
  /**
   * Records that a credential was rejected. Returns the transition when the
   * page serializes store writes across documents (Web Locks), so a caller
   * that must not resolve before the state it reports — the SDK's response
   * boundary — can await it. Synchronous hosts return nothing, because the
   * transition has already happened by the time this returns.
   */
  markCredentialRequired: (
    id: string,
    rejectedCredential?: string,
    generation?: number,
  ) => void | Promise<void>;
  getConnectionCredential: (id: string) => string | undefined;
  /**
   * How many times this connection has GAINED a credential able to
   * authenticate it (see `ConnectionStore.credentialAuthorityGeneration`).
   * Consumers that park a probe on a terminal auth failure watch THIS rather
   * than the credential value: a browser device session is `undefined` before
   * and after pairing, so a value comparison never sees re-pairing happen.
   */
  credentialAuthorityGeneration: (id: string) => number;
  commitEndpointCandidate: (id: string) => SavedConnection | null;
  failEndpointCandidate: (id: string) => void;
  recordEndpointSuccess: (
    id: string,
    url: string,
    at?: number,
    bootId?: string,
  ) => void;
  /**
   * Everything a request must be judged against, read from the LIVE store in
   * ONE call at the moment the request is about to be issued: which connection
   * it belongs to, which credential generation it is authenticated against,
   * the credential itself, and the address it is going to.
   *
   * Atomic on purpose. Combining a live connection with a render-captured
   * `apiBase` leaves a window — between a synchronous connection switch and
   * React committing the new context — in which the NEW connection's
   * credential is attached to a request for the OLD connection's origin. The
   * store's origin check stops that from causing a false recovery, but it
   * cannot un-send the credential.
   */
  captureCredentialEvidence: () => RequestCredentialEvidence | null;
  /** Checks a prior evidence record against the live store, never React state. */
  isCredentialEvidenceCurrent: (evidence: RequestCredentialEvidence) => boolean;
  /**
   * Retires the stale evidence a rejected credential left behind, from an
   * accepted AUTHENTICATED response. `generation` and `url` must be the ones
   * captured when the request STARTED (see `captureCredentialEvidence`); the
   * store drops the acceptance if either has been overtaken. It is a no-op
   * when there is nothing stale, so a caller may fire it per accepted request.
   */
  recordAuthenticatedSuccess: (
    id: string,
    url: string,
    generation: number,
    at?: number,
  ) => void | Promise<void>;
  recordEndpointFailure: (
    id: string,
    reason: NonNullable<SavedConnection['lastError']>['reason'],
    at?: number,
    detail?: string,
  ) => void;
  selectEndpoint: (id: string, endpointId: string) => SavedConnection | null;
  credentialProvider: ConnectionCredentialProvider;
  /**
   * Selects a connection after any host-owned credential projection has
   * completed. Native hosts use this to make a transient profile choice
   * available to the credential provider before callers start a health probe.
   */
  setActiveConnection: (id: string) => Promise<void>;
  /** Convenience: upsert a connection by URL and activate it */
  setApiBase: (url: string) => void;
  resetToDefault: () => void;
  isCustom: boolean;
}

/** One atomic live read of what a request is being issued against. */
export interface RequestCredentialEvidence {
  connectionId: string;
  /** Runtime-local selection epoch; distinct from credential authority gains. */
  activationEpoch: string;
  generation: number;
  authorityGeneration: number;
  credentialState: SavedConnection['credentialState'];
  credential: string | undefined;
  origin: string;
}

const ConnectionsContext = createContext<ConnectionsContextType | undefined>(
  undefined,
);

function makeDefaultStore(
  defaultUrl: string,
  seedDefault: boolean,
  credentialStorage: StorageAdapter = defaultCredentialStorage,
  storage: StorageAdapter = defaultStorage,
): ConnectionStore {
  const legacyCredentials = defaultStorage.get(
    DEFAULT_CONNECTION_CREDENTIAL_KEY,
  );
  if (storage === defaultStorage && legacyCredentials) {
    if (!credentialStorage.get(DEFAULT_CONNECTION_CREDENTIAL_KEY)) {
      credentialStorage.set(
        DEFAULT_CONNECTION_CREDENTIAL_KEY,
        legacyCredentials,
      );
    }
    defaultStorage.remove(DEFAULT_CONNECTION_CREDENTIAL_KEY);
  }
  const store = new ConnectionStore({
    storage,
    credentialStorage,
    storageKey: DEFAULT_STORAGE_KEY,
  });

  // Migrate legacy single-URL key (kept even when default seeding is off).
  store.migrate(LEGACY_KEY);

  // Origin default seeding is suppressed on hosts that inject their own base
  // (e.g. the desktop bundled server), but legacy migration above still runs.
  if (!seedDefault) return store;

  // Ensure there is always at least one (default) connection
  if (store.getAll().length === 0) {
    const connection = store.add('Default', defaultUrl);
    store.setSelectedEndpointKind(connection.id, 'same-origin');
  } else {
    // Sync the "Default" connection URL when the server port changes at runtime
    const def = store.getAll().find((c) => c.name === 'Default');
    if (def && def.url !== defaultUrl) {
      store.update(def.id, { url: defaultUrl });
    }
    const sameOrigin = store
      .getAll()
      .find((connection) =>
        connection.endpoints.some((endpoint) => endpoint.url === defaultUrl),
      );
    if (sameOrigin) store.setSelectedEndpointKind(sameOrigin.id, 'same-origin');
  }

  return store;
}

// Module-level singleton; created lazily so that the consuming app can pass
// defaultUrl via the provider before any store reads happen.
let _sharedStore: ConnectionStore | null = null;

export function ConnectionsProvider({
  children,
  store,
  defaultUrl = FALLBACK_URL,
  seedDefault = true,
  injectedConnection = null,
  credentialStorage,
  connectionStorage,
  connectionStorageRevision,
  commitVerifiedPairing,
  makeDefaultProfile,
  prepareActiveConnection,
  nativeShell,
}: {
  children: React.ReactNode;
  store?: ConnectionStore;
  /**
   * Where pairing credentials are kept. Defaults to the web vault
   * (sessionStorage); native shells pass a persistent one, or the credential
   * is discarded on every app launch and the user re-pairs each time.
   */
  credentialStorage?: StorageAdapter;
  /**
   * Native-host-owned saved Station metadata. Desktop injects a hydrated
   * adapter for the shared file; web keeps device-local browser storage.
   */
  connectionStorage?: StorageAdapter;
  /**
   * Monotonically changes when a host-owned storage adapter has accepted an
   * external update. This republishes the existing ConnectionStore without
   * remounting its children.
   */
  connectionStorageRevision?: number;
  /** Host-owned atomic persistence for a verified native pairing. */
  commitVerifiedPairing?: ConnectionsContextType['commitVerifiedPairing'];
  /** Host-owned explicit shared-default mutation. Never called by selection. */
  makeDefaultProfile?: ConnectionsContextType['makeDefaultProfile'];
  /**
   * Optional host-owned preparation for a transient active-connection choice.
   * It must not persist a CLI/shared default. The provider awaits it before
   * publishing the active connection to callers that may immediately probe.
   */
  prepareActiveConnection?: (connectionId: string) => Promise<void>;
  /** Default URL for the initial connection when no persisted data exists */
  defaultUrl?: string;
  /**
   * When false, origin default seeding is skipped (legacy migration still
   * runs). Hosts that inject their own base pass false. Default true.
   */
  seedDefault?: boolean;
  /**
   * Host-supplied, never-persisted connection (bundled-server loopback or CLI
   * base). Composed into the connection list and resolved as active when no
   * saved connection is explicitly active.
   */
  injectedConnection?: InjectedConnection | null;
  /**
   * Explicit native-shell signal (station#1286) — e.g. `src-ui` passes
   * `PlatformProfile.isTauri`. Optional so this platform-blind package still
   * works for a caller that doesn't have a resolved platform profile handy
   * (tests, out-of-tree hosts); falls back to an inline Tauri-runtime-marker
   * check in that case, mirroring `src-ui/src/platform/native/index.ts`.
   */
  nativeShell?: boolean;
}) {
  if (!store) {
    if (!_sharedStore) {
      _sharedStore = makeDefaultStore(
        defaultUrl,
        seedDefault,
        credentialStorage,
        connectionStorage,
      );
    }
    store = _sharedStore;
  }

  const resolvedStore = store;
  const activation = useRef({
    activeConnectionId: resolvedStore.getActive()?.id ?? null,
    instanceId: crypto.randomUUID(),
    sequence: 0,
  });
  const advanceActivation = useCallback(() => {
    const activeConnectionId = resolvedStore.getActive()?.id ?? null;
    if (activation.current.activeConnectionId !== activeConnectionId) {
      activation.current.activeConnectionId = activeConnectionId;
      activation.current.sequence += 1;
    }
    return `${activation.current.instanceId}:${activation.current.sequence}`;
  }, [resolvedStore]);

  // Keep the injected slot in sync with the host-supplied value. A new URL for
  // the same source updates it in place (server restart → no reload).
  // setInjectedConnection is idempotent (it only notifies on a real change), so
  // depending on the whole prop is safe even for non-memoized callers.
  useEffect(() => {
    resolvedStore.setInjectedConnection(injectedConnection ?? null);
  }, [resolvedStore, injectedConnection]);

  useEffect(() => {
    if (connectionStorageRevision !== undefined) resolvedStore.reload();
  }, [resolvedStore, connectionStorageRevision]);

  // Connection profiles are shared by every tab on this origin, so another
  // tab's rejection or pairing is a change to THIS tab's subject (#3600).
  useEffect(() => resolvedStore.observeStorageEvents(), [resolvedStore]);

  const getAll = useCallback(() => resolvedStore.getAll(), [resolvedStore]);
  const getActive = useCallback(
    () => resolvedStore.getActive(),
    [resolvedStore],
  );
  const subscribe = useCallback(
    (cb: () => void) =>
      resolvedStore.subscribe(() => {
        advanceActivation();
        cb();
      }),
    [advanceActivation, resolvedStore],
  );

  const connections = useSyncExternalStore(subscribe, getAll);
  const activeConnection = useSyncExternalStore(subscribe, getActive);

  const value = useMemo<ConnectionsContextType>(
    () => ({
      connections,
      activeConnection,
      apiBase: activeConnection?.url ?? defaultUrl,
      nativeShell: nativeShell ?? detectNativeShell(),
      addConnection: (name, url) => resolvedStore.add(name, url),
      removeConnection: (id) => resolvedStore.remove(id),
      updateConnection: (id, changes) => resolvedStore.update(id, changes),
      reconcileHandshake: (id, handshake) =>
        resolvedStore.reconcileHandshake(id, handshake),
      ...(commitVerifiedPairing ? { commitVerifiedPairing } : {}),
      ...(makeDefaultProfile ? { makeDefaultProfile } : {}),
      setCredential: (id, credential) =>
        resolvedStore.setCredential(id, credential),
      markDeviceSession: (id) => resolvedStore.markDeviceSession(id),
      removeCredential: (id) => resolvedStore.removeCredential(id),
      markCredentialRequired: (id, rejectedCredential, generation) =>
        resolvedStore.markCredentialRequired(
          id,
          rejectedCredential,
          generation,
        ),
      getConnectionCredential: (id) =>
        resolvedStore.getCredential(id) ?? undefined,
      credentialAuthorityGeneration: (id) =>
        resolvedStore.credentialAuthorityGeneration(id),
      commitEndpointCandidate: (id) =>
        resolvedStore.commitEndpointCandidate(id),
      failEndpointCandidate: (id) => resolvedStore.failEndpointCandidate(id),
      recordEndpointSuccess: (id, url, at, bootId) =>
        resolvedStore.recordEndpointSuccess(id, url, at, bootId),
      captureCredentialEvidence: () => {
        const active = resolvedStore.getActive();
        if (!active) return null;
        return {
          connectionId: active.id,
          activationEpoch: advanceActivation(),
          generation: resolvedStore.credentialGeneration(active.id),
          authorityGeneration: resolvedStore.credentialAuthorityGeneration(
            active.id,
          ),
          credentialState: active.credentialState,
          credential: resolvedStore.getCredential(active.id) ?? undefined,
          // Byte-for-byte the expression `apiBase` is derived from, read here
          // so the address belongs to the same live snapshot as the credential
          // rather than to whatever React last rendered.
          origin: active.url ?? defaultUrl,
        };
      },
      isCredentialEvidenceCurrent: (evidence) => {
        const active = resolvedStore.getActive();
        return Boolean(
          active &&
            active.id === evidence.connectionId &&
            advanceActivation() === evidence.activationEpoch &&
            (active.url ?? defaultUrl) === evidence.origin &&
            resolvedStore.credentialAuthorityGeneration(active.id) ===
              evidence.authorityGeneration &&
            active.credentialState === evidence.credentialState,
        );
      },
      recordAuthenticatedSuccess: (id, url, generation, at) =>
        resolvedStore.recordAuthenticatedSuccess(id, url, generation, at),
      recordEndpointFailure: (id, reason, at, detail) =>
        resolvedStore.recordEndpointFailure(id, reason, at, detail),
      selectEndpoint: (id, endpointId) =>
        resolvedStore.selectEndpoint(id, endpointId),
      credentialProvider: {
        getCredential: () => {
          const active = resolvedStore.getActive();
          return active
            ? (resolvedStore.getCredential(active.id) ?? undefined)
            : undefined;
        },
        getProtocolVersion: () =>
          resolvedStore.getActive()?.authProtocolVersion ?? undefined,
      },
      setActiveConnection: async (id) => {
        await prepareActiveConnection?.(id);
        resolvedStore.setActive(id);
      },
      setApiBase: (url) => {
        const existing = resolvedStore.getAll().find((c) => c.url === url);
        if (existing) {
          resolvedStore.setActive(existing.id);
        } else {
          // #198: `ConnectionStore.add()` only auto-activates a *brand new*
          // connection when no connection was previously active — since
          // `makeDefaultStore` always seeds an active "Default" connection,
          // typing a first custom URL in Settings would silently add it
          // without switching to it. Explicitly activate so an explicit
          // override always wins, matching this hook's documented contract.
          const conn = resolvedStore.add('', url);
          resolvedStore.setActive(conn.id);
        }
      },
      resetToDefault: () => {
        const existing = resolvedStore
          .getAll()
          .find((c) => c.url === defaultUrl);
        if (existing) {
          resolvedStore.setActive(existing.id);
        } else {
          const conn = resolvedStore.add('Default', defaultUrl);
          resolvedStore.setActive(conn.id);
        }
      },
      isCustom: (activeConnection?.url ?? defaultUrl) !== defaultUrl,
    }),
    [
      connections,
      activeConnection,
      resolvedStore,
      defaultUrl,
      nativeShell,
      commitVerifiedPairing,
      makeDefaultProfile,
      prepareActiveConnection,
      advanceActivation,
    ],
  );

  return (
    <ConnectionsContext.Provider value={value}>
      {children}
    </ConnectionsContext.Provider>
  );
}

export function useConnections(): ConnectionsContextType {
  const ctx = useContext(ConnectionsContext);
  if (!ctx) {
    throw new Error('useConnections must be used within a ConnectionsProvider');
  }
  return ctx;
}
