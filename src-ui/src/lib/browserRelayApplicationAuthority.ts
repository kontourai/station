import type { SavedConnection } from '@kontourai/station-connect';
import type { ApplicationSessionContinuation } from '@kontourai/station-contracts/application-session';
import type { RelayEnrollmentActivatedResponse } from '@kontourai/station-contracts/relay-enrollment';
import type { SelfHostedBrokerScopeV1 } from '@kontourai/station-contracts/self-hosted-broker';
import {
  ApplicationSessionClient,
  type ApplicationSessionKey,
  createApplicationSessionKey,
  restoreApplicationSessionKey,
} from '@kontourai/station-sdk/application-session';
import type { ClientCredential } from '@kontourai/station-sdk/client';
import {
  beginBrowserRelayAccountScopeChange,
  browserRelayAccountScopeKey,
  getBrowserRelayAccountScope,
  publishBrowserRelayAccountScope,
} from './browserRelayAccountScope';
import { captureBrowserRelayRoute } from './browserRelayRouteBinding';

const DATABASE = 'station-browser-relay-application-authority-v1';
const STORE = 'authorities';
const OPAQUE = /^[A-Za-z0-9_-]{43}$/;

function authorityError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

export type BrowserRelayAuthorityInput = {
  connectionId: string;
  applicationOrigin: string;
  route: NonNullable<SavedConnection['brokerRoute']>;
  /** A Station-approved Device credential or Station-issued cookie alias. */
  bearer: { kind: 'device' | 'alias'; credential: string };
  key: ApplicationSessionKey;
  continuation: ApplicationSessionContinuation;
};

type AuthorityIdentity = {
  authorityInstanceId: string | null;
  scopeVersion: number;
};
type ActiveAuthorityRecord = Omit<BrowserRelayAuthorityInput, 'key'> & {
  version: 1;
  status: 'active';
  authorityInstanceId: string;
  scopeVersion: number;
  key: {
    privateKey: CryptoKey;
    publicKey: ApplicationSessionKey['publicKey'];
  };
  clientOrigin: string;
  installedAt: number;
};
type StagedAuthorityRecord = Omit<BrowserRelayAuthorityInput, 'key'> & {
  version: 1;
  status: 'staged';
  stageId: string;
  key: ActiveAuthorityRecord['key'];
  clientOrigin: string;
  installedAt: number;
  expiresAt: string;
};
type EmptyAuthorityRecord = {
  version: 1;
  status: 'empty';
  authorityInstanceId: null;
  scopeVersion: number;
};
type DeviceOnlyAuthorityRecord = Omit<
  ActiveAuthorityRecord,
  'continuation' | 'key' | 'status'
> & { status: 'device-only' };
type AuthorityRecord =
  | ActiveAuthorityRecord
  | StagedAuthorityRecord
  | DeviceOnlyAuthorityRecord
  | EmptyAuthorityRecord;

export interface BrowserRelayAuthorityStorage {
  read(key: string, signal?: AbortSignal): Promise<unknown | null>;
  compareAndSwap(
    key: string,
    expected: AuthorityIdentity | null,
    next: AuthorityRecord | null,
    signal?: AbortSignal,
  ): Promise<boolean>;
  activateStaged(input: {
    activeKey: string;
    stageKey: string;
    expectedActive: AuthorityIdentity | null;
    expectedStage: AuthorityIdentity | null;
    active: ActiveAuthorityRecord;
    stageTombstone: EmptyAuthorityRecord;
    signal?: AbortSignal;
  }): Promise<boolean>;
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Relay authority operation aborted.', 'AbortError');
}

function routeKey(
  connectionId: string,
  applicationOrigin: string,
  route: NonNullable<SavedConnection['brokerRoute']>,
  clientOrigin: string,
) {
  return browserRelayAccountScopeKey({
    connectionId,
    applicationOrigin,
    route,
    clientOrigin,
  });
}

function sameScope(
  left: SelfHostedBrokerScopeV1,
  right: SelfHostedBrokerScopeV1,
) {
  return (
    left.stationId === right.stationId &&
    left.enrollmentId === right.enrollmentId &&
    left.routingGeneration === right.routingGeneration &&
    left.browserOrigin === right.browserOrigin
  );
}

function assertOrigin(value: string, name: string) {
  const parsed = new URL(value);
  if (
    parsed.origin !== value ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.protocol !== 'https:' &&
      !(
        parsed.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
      ))
  )
    throw new Error(`${name} must be a canonical secure origin.`);
  return parsed.origin;
}

async function publicKeyThumbprint(key: ApplicationSessionKey) {
  const value = JSON.stringify({
    crv: key.publicKey.crv,
    kty: key.publicKey.kty,
    x: key.publicKey.x,
    y: key.publicKey.y,
  });
  return btoa(
    String.fromCharCode(
      ...new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
      ),
    ),
  )
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function transaction<T>(
  mode: IDBTransactionMode,
  apply: (store: IDBObjectStore) => IDBRequest<T> | undefined,
  signal?: AbortSignal,
): Promise<T | undefined> {
  try {
    throwIfAborted(signal);
  } catch (error) {
    return Promise.reject(error);
  }
  if (!globalThis.isSecureContext || !globalThis.indexedDB)
    return Promise.reject(
      new Error('Relay application authority storage is unavailable.'),
    );
  return new Promise((resolve, reject) => {
    let open: IDBOpenDBRequest;
    try {
      open = indexedDB.open(DATABASE, 1);
    } catch {
      reject(new Error('Relay application authority storage is unavailable.'));
      return;
    }
    const abortOpen = () => reject(signal?.reason);
    signal?.addEventListener('abort', abortOpen, { once: true });
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE))
        open.result.createObjectStore(STORE);
    };
    open.onerror = open.onblocked = () => {
      signal?.removeEventListener('abort', abortOpen);
      reject(
        signal?.aborted
          ? signal.reason
          : new Error('Relay application authority storage is unavailable.'),
      );
    };
    open.onsuccess = () => {
      signal?.removeEventListener('abort', abortOpen);
      const db = open.result;
      if (signal?.aborted) {
        db.close();
        reject(signal.reason);
        return;
      }
      db.onversionchange = () => db.close();
      let tx: IDBTransaction;
      try {
        tx = db.transaction(
          STORE,
          mode,
          mode === 'readwrite' ? { durability: 'strict' } : undefined,
        );
      } catch {
        db.close();
        reject(
          new Error('Relay application authority storage is unavailable.'),
        );
        return;
      }
      if (mode === 'readwrite' && tx.durability !== 'strict') {
        tx.abort();
        db.close();
        reject(
          new Error('Relay application authority storage is unavailable.'),
        );
        return;
      }
      let result: T | undefined;
      let failed = false;
      const abortTransaction = () => {
        failed = true;
        try {
          tx.abort();
        } catch {
          /* already settled */
        }
        reject(signal?.reason);
      };
      signal?.addEventListener('abort', abortTransaction, { once: true });
      tx.onerror = () => {
        if (!failed)
          reject(
            signal?.aborted
              ? signal.reason
              : new Error('Relay application authority storage failed.'),
          );
        failed = true;
      };
      tx.onabort = () => {
        signal?.removeEventListener('abort', abortTransaction);
        db.close();
        if (!failed)
          reject(new Error('Relay application authority storage failed.'));
        failed = true;
      };
      tx.oncomplete = () => {
        signal?.removeEventListener('abort', abortTransaction);
        db.close();
        resolve(result);
      };
      try {
        const request = apply(tx.objectStore(STORE));
        if (request) {
          request.onsuccess = () => {
            result = request.result;
          };
          request.onerror = () => {
            failed = true;
            reject(new Error('Relay application authority storage failed.'));
            tx.abort();
          };
        }
      } catch {
        failed = true;
        reject(new Error('Relay application authority storage failed.'));
        tx.abort();
      }
    };
  });
}

class IndexedDbBrowserRelayAuthorityStorage
  implements BrowserRelayAuthorityStorage
{
  async read(key: string, signal?: AbortSignal) {
    return (
      (await transaction<unknown>(
        'readonly',
        (store) => store.get(key),
        signal,
      )) ?? null
    );
  }
  async compareAndSwap(
    key: string,
    expected: AuthorityIdentity | null,
    next: AuthorityRecord | null,
    signal?: AbortSignal,
  ) {
    return atomicAuthorityUpdate((store) => {
      const request = store.get(key);
      let matched = false;
      request.onsuccess = () => {
        if (!sameIdentity(identityOf(request.result), expected)) return;
        matched = true;
        if (next) store.put(next, key);
        else store.delete(key);
      };
      return { request, result: () => matched };
    }, signal);
  }
  async activateStaged(input: {
    activeKey: string;
    stageKey: string;
    expectedActive: AuthorityIdentity | null;
    expectedStage: AuthorityIdentity | null;
    active: ActiveAuthorityRecord;
    stageTombstone: EmptyAuthorityRecord;
    signal?: AbortSignal;
  }) {
    return atomicAuthorityUpdate((store) => {
      const activeRequest = store.get(input.activeKey);
      const stageRequest = store.get(input.stageKey);
      let active: unknown;
      let staged: unknown;
      let reads = 0;
      let matched = false;
      const finish = () => {
        reads += 1;
        if (reads !== 2) return;
        if (
          !sameIdentity(identityOf(active), input.expectedActive) ||
          !sameIdentity(identityOf(staged), input.expectedStage)
        )
          return;
        matched = true;
        store.put(input.active, input.activeKey);
        store.put(input.stageTombstone, input.stageKey);
      };
      activeRequest.onsuccess = () => {
        active = activeRequest.result;
        finish();
      };
      stageRequest.onsuccess = () => {
        staged = stageRequest.result;
        finish();
      };
      return { request: null, result: () => matched };
    }, input.signal);
  }
}

function identityOf(value: unknown): AuthorityIdentity | null | undefined {
  if (value === null || value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('Relay authority record is invalid.');
  if (value.status === 'active')
    return {
      authorityInstanceId: value.authorityInstanceId,
      scopeVersion: value.scopeVersion,
    };
  if (value.status === 'device-only')
    return {
      authorityInstanceId: value.authorityInstanceId,
      scopeVersion: value.scopeVersion,
    };
  if (value.status === 'empty')
    return {
      authorityInstanceId: null,
      scopeVersion: value.scopeVersion,
    };
  if (value.status === 'staged')
    return { authorityInstanceId: value.stageId, scopeVersion: 0 };
  throw new Error('Relay authority record is invalid.');
}

function sameIdentity(
  left: AuthorityIdentity | null | undefined,
  right: AuthorityIdentity | null,
) {
  if (left === undefined) return right === null;
  if (left === null) return right === null;
  if (right === null) return false;
  return (
    left.authorityInstanceId === right.authorityInstanceId &&
    left.scopeVersion === right.scopeVersion
  );
}

function atomicAuthorityUpdate(
  configure: (store: IDBObjectStore) => {
    request: IDBRequest<unknown> | null;
    result(): boolean;
  },
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    throwIfAborted(signal);
  } catch (error) {
    return Promise.reject(error);
  }
  if (!globalThis.isSecureContext || !globalThis.indexedDB)
    return Promise.reject(
      new Error('Relay application authority storage is unavailable.'),
    );
  return new Promise((resolve, reject) => {
    let open: IDBOpenDBRequest;
    try {
      open = indexedDB.open(DATABASE, 1);
    } catch {
      reject(new Error('Relay application authority storage is unavailable.'));
      return;
    }
    const abortOpen = () => reject(signal?.reason);
    signal?.addEventListener('abort', abortOpen, { once: true });
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE))
        open.result.createObjectStore(STORE);
    };
    open.onerror = open.onblocked = () => {
      signal?.removeEventListener('abort', abortOpen);
      reject(
        signal?.aborted
          ? signal.reason
          : new Error('Relay application authority storage is unavailable.'),
      );
    };
    open.onsuccess = () => {
      signal?.removeEventListener('abort', abortOpen);
      const db = open.result;
      if (signal?.aborted) {
        db.close();
        reject(signal.reason);
        return;
      }
      db.onversionchange = () => db.close();
      let tx: IDBTransaction;
      try {
        tx = db.transaction(STORE, 'readwrite', { durability: 'strict' });
      } catch {
        db.close();
        reject(
          new Error('Relay application authority storage is unavailable.'),
        );
        return;
      }
      if (tx.durability !== 'strict') {
        tx.abort();
        db.close();
        reject(
          new Error('Relay application authority storage is unavailable.'),
        );
        return;
      }
      let configured: ReturnType<typeof configure>;
      let failed = false;
      const abortTransaction = () => {
        failed = true;
        try {
          tx.abort();
        } catch {
          /* already settled */
        }
        reject(signal?.reason);
      };
      signal?.addEventListener('abort', abortTransaction, { once: true });
      tx.onerror = () => {
        if (!failed)
          reject(
            signal?.aborted
              ? signal.reason
              : new Error('Relay application authority storage failed.'),
          );
        failed = true;
      };
      tx.onabort = () => {
        signal?.removeEventListener('abort', abortTransaction);
        db.close();
        if (!failed)
          reject(new Error('Relay application authority storage failed.'));
        failed = true;
      };
      tx.oncomplete = () => {
        signal?.removeEventListener('abort', abortTransaction);
        db.close();
        resolve(configured.result());
      };
      try {
        configured = configure(tx.objectStore(STORE));
        configured.request?.addEventListener('error', () => {
          failed = true;
          reject(new Error('Relay application authority storage failed.'));
          tx.abort();
        });
      } catch {
        failed = true;
        reject(new Error('Relay application authority storage failed.'));
        tx.abort();
      }
    };
  });
}

const defaultStorage = new IndexedDbBrowserRelayAuthorityStorage();
function isRecord(value: unknown): value is AuthorityRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    (record.status === 'active' ||
      record.status === 'device-only' ||
      record.status === 'staged' ||
      record.status === 'empty')
  );
}

function isActiveRecord(value: unknown): value is ActiveAuthorityRecord {
  return isRecord(value) && value.status === 'active';
}

function recordScopeVersion(value: unknown) {
  return isRecord(value) && value.status !== 'staged' ? value.scopeVersion : 0;
}

function emptyRecord(scopeVersion: number): EmptyAuthorityRecord {
  return {
    version: 1,
    status: 'empty',
    authorityInstanceId: null,
    scopeVersion,
  };
}

function expectedIdentity(value: unknown): AuthorityIdentity | null {
  return value === null || value === undefined ? null : identityOf(value)!;
}

function readyScope(key: string, value: unknown, fallbackVersion: number) {
  const version = Math.max(recordScopeVersion(value), fallbackVersion);
  publishBrowserRelayAccountScope(
    key,
    isActiveRecord(value) ? value.continuation.authorityKey : null,
    version,
    'ready',
  );
}

/** Hydrates only active records; an inert staged record is never promoted after reload. */
export async function hydrateBrowserRelayApplicationAuthorityScope(
  input: AuthorityRouteInput,
  storage: BrowserRelayAuthorityStorage = defaultStorage,
) {
  const clientOrigin = window.location.origin;
  const key = routeKey(
    input.connectionId,
    input.applicationOrigin,
    input.route,
    clientOrigin,
  );
  const binding = captureBrowserRelayRoute(
    input.connectionId,
    input.applicationOrigin,
    input.route,
  );
  if (!binding?.isCurrent()) return null;
  const value = await storage.read(key);
  if (isActiveRecord(value)) {
    const valid =
      value.connectionId === input.connectionId &&
      value.applicationOrigin === input.applicationOrigin &&
      value.clientOrigin === clientOrigin &&
      value.route.brokerOrigin === input.route.brokerOrigin &&
      sameScope(value.route.scope, input.route.scope) &&
      Number.isFinite(Date.parse(value.continuation.expiresAt)) &&
      Date.parse(value.continuation.expiresAt) > Date.now() &&
      binding.isCurrent();
    if (valid) {
      const signer = restoreApplicationSessionKey(
        value.key.privateKey,
        value.key.publicKey,
      );
      if (
        (await publicKeyThumbprint(signer)) ===
          value.continuation.keyThumbprint &&
        binding.isCurrent()
      ) {
        readyScope(key, value, value.scopeVersion);
        return getBrowserRelayAccountScope(key);
      }
    }
  }
  if (binding.isCurrent()) readyScope(key, value, recordScopeVersion(value));
  return getBrowserRelayAccountScope(key);
}

async function installActiveAliasAuthority(
  input: BrowserRelayAuthorityInput,
  storage: BrowserRelayAuthorityStorage,
) {
  if (input.bearer.kind !== 'alias')
    throw new Error('Fresh Device grants require staged Station activation.');
  const selected = captureBrowserRelayRoute(
    input.connectionId,
    input.applicationOrigin,
    input.route,
  );
  if (!selected?.isCurrent())
    throw new Error('The selected encrypted Station route is not current.');
  const { clientOrigin, applicationOrigin } = validateAuthorityShape(input);
  await validateAuthorityKey(input);
  if (!routeCurrent(input, selected.transport))
    throw authorityError(
      'station_relay_route_stale',
      'The selected encrypted Station route is not current.',
    );
  const key = routeKey(
    input.connectionId,
    applicationOrigin,
    input.route,
    clientOrigin,
  );
  const transitionVersion = beginBrowserRelayAccountScopeChange(key);
  try {
    const previous = await storage.read(key);
    if (!routeCurrent(input, selected.transport)) {
      readyScope(key, previous, transitionVersion);
      throw authorityError(
        'station_relay_route_stale',
        'The selected encrypted Station route is not current.',
      );
    }
    const record: ActiveAuthorityRecord = {
      ...input,
      version: 1,
      status: 'active',
      authorityInstanceId: crypto.randomUUID(),
      scopeVersion:
        Math.max(recordScopeVersion(previous), transitionVersion) + 1,
      key: { privateKey: input.key.privateKey, publicKey: input.key.publicKey },
      clientOrigin,
      applicationOrigin,
      installedAt: Date.now(),
    };
    if (
      !(await storage.compareAndSwap(key, expectedIdentity(previous), record))
    ) {
      const latest = await storage.read(key);
      readyScope(key, latest, transitionVersion);
      throw new Error(
        'Relay authority changed while cookie adoption was committing.',
      );
    }
    const latest = await storage.read(key);
    if (
      !isActiveRecord(latest) ||
      latest.authorityInstanceId !== record.authorityInstanceId ||
      !routeCurrent(input, selected.transport)
    ) {
      if (
        isActiveRecord(latest) &&
        latest.authorityInstanceId === record.authorityInstanceId
      ) {
        const rollback = isActiveRecord(previous)
          ? { ...previous, scopeVersion: record.scopeVersion + 1 }
          : emptyRecord(record.scopeVersion + 1);
        await storage.compareAndSwap(key, identityOf(latest)!, rollback);
      }
      const restored = await storage.read(key);
      readyScope(key, restored, record.scopeVersion + 1);
      throw authorityError(
        'station_relay_route_stale',
        'The selected route changed while cookie authority was committing.',
      );
    }
    readyScope(key, latest, latest.scopeVersion);
    return {
      authorityKey: latest.continuation.authorityKey,
      deviceId: latest.continuation.deviceId,
    };
  } catch (error) {
    const latest = await storage.read(key).catch(() => undefined);
    if (latest !== undefined) readyScope(key, latest, transitionVersion);
    throw error;
  }
}

/** Immediate installation is reserved for the cookie-adoption flow, which returns an already active alias. */
export async function installBrowserRelayApplicationAuthority(
  input: BrowserRelayAuthorityInput,
  storage: BrowserRelayAuthorityStorage = defaultStorage,
) {
  return installActiveAliasAuthority(input, storage);
}

function routeCurrent(
  input: Pick<
    BrowserRelayAuthorityInput,
    'connectionId' | 'applicationOrigin' | 'route'
  >,
  transport: typeof fetch,
  additionalCurrent?: () => boolean,
) {
  const binding = captureBrowserRelayRoute(
    input.connectionId,
    input.applicationOrigin,
    input.route,
  );
  return Boolean(
    binding &&
      binding.transport === transport &&
      binding.isCurrent() &&
      (!additionalCurrent || additionalCurrent()),
  );
}

function validateAuthorityShape(input: BrowserRelayAuthorityInput) {
  const clientOrigin = assertOrigin(window.location.origin, 'Browser origin');
  const applicationOrigin = assertOrigin(
    input.applicationOrigin,
    'Station origin',
  );
  if (
    !input.connectionId ||
    !OPAQUE.test(input.bearer.credential) ||
    input.key.privateKey.extractable ||
    input.continuation.version !== 'station.application-session/v1' ||
    !OPAQUE.test(input.continuation.credential) ||
    !OPAQUE.test(input.continuation.nonce) ||
    input.continuation.stationId !== input.route.scope.stationId ||
    input.continuation.deviceId.trim().length === 0 ||
    input.continuation.requestOrigin !== applicationOrigin ||
    input.continuation.clientOrigin !== clientOrigin ||
    !Number.isFinite(Date.parse(input.continuation.expiresAt)) ||
    Date.parse(input.continuation.expiresAt) <= Date.now()
  )
    throw new Error(
      'Relay application authority does not match this Station route.',
    );
  return { clientOrigin, applicationOrigin };
}

async function validateAuthorityKey(input: BrowserRelayAuthorityInput) {
  if (
    input.continuation.keyThumbprint !== (await publicKeyThumbprint(input.key))
  )
    throw new Error(
      'Relay application authority key does not match its continuation.',
    );
}

type AuthorityRouteInput = Pick<
  BrowserRelayAuthorityInput,
  'connectionId' | 'applicationOrigin' | 'route'
>;

/** Persist a fresh Device bundle inertly; it cannot authenticate requests until the Station activates it. */
export async function stageBrowserRelayApplicationAuthority(
  input: BrowserRelayAuthorityInput & { stageId: string; signal?: AbortSignal },
  storage: BrowserRelayAuthorityStorage = defaultStorage,
) {
  throwIfAborted(input.signal);
  if (!OPAQUE.test(input.stageId))
    throw new Error('Relay enrollment stage ID is invalid.');
  const selected = captureBrowserRelayRoute(
    input.connectionId,
    input.applicationOrigin,
    input.route,
  );
  if (!selected?.isCurrent())
    throw new Error('The selected encrypted Station route is not current.');
  const { clientOrigin, applicationOrigin } = validateAuthorityShape(input);
  await validateAuthorityKey(input);
  throwIfAborted(input.signal);
  if (!routeCurrent(input, selected.transport))
    throw authorityError(
      'station_relay_route_stale',
      'The selected encrypted Station route is not current.',
    );
  const activeKey = routeKey(
    input.connectionId,
    applicationOrigin,
    input.route,
    clientOrigin,
  );
  const stageKey = `${activeKey}::stage:${input.stageId}`;
  const staged: StagedAuthorityRecord = {
    connectionId: input.connectionId,
    applicationOrigin,
    route: input.route,
    bearer: input.bearer,
    continuation: input.continuation,
    key: { privateKey: input.key.privateKey, publicKey: input.key.publicKey },
    version: 1,
    status: 'staged',
    stageId: input.stageId,
    clientOrigin,
    installedAt: Date.now(),
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
  let priorStage = await storage.read(stageKey, input.signal);
  throwIfAborted(input.signal);
  let expectedStage = expectedIdentity(priorStage);
  if (
    isRecord(priorStage) &&
    priorStage.status === 'staged' &&
    (!Number.isFinite(Date.parse(priorStage.expiresAt)) ||
      Date.parse(priorStage.expiresAt) <= Date.now())
  ) {
    const expired = emptyRecord(recordScopeVersion(priorStage) + 1);
    if (
      !(await storage.compareAndSwap(
        stageKey,
        identityOf(priorStage)!,
        expired,
        input.signal,
      ))
    )
      throw new Error('Expired relay enrollment stage changed before cleanup.');
    priorStage = expired;
    expectedStage = identityOf(expired)!;
  }
  const existingStage =
    isRecord(priorStage) && priorStage.status === 'staged' ? priorStage : null;
  if (existingStage && Date.parse(existingStage.expiresAt) > Date.now()) {
    const sameBundle =
      existingStage.connectionId === input.connectionId &&
      existingStage.applicationOrigin === applicationOrigin &&
      existingStage.route.brokerOrigin === input.route.brokerOrigin &&
      sameScope(existingStage.route.scope, input.route.scope) &&
      existingStage.bearer.kind === input.bearer.kind &&
      existingStage.bearer.credential === input.bearer.credential &&
      existingStage.continuation.authorityKey ===
        input.continuation.authorityKey &&
      existingStage.continuation.credential === input.continuation.credential &&
      existingStage.continuation.keyThumbprint ===
        input.continuation.keyThumbprint &&
      existingStage.key.publicKey.x === input.key.publicKey.x &&
      existingStage.key.publicKey.y === input.key.publicKey.y;
    if (!sameBundle)
      throw new Error(
        'Relay enrollment stage already exists with different authority.',
      );
    return { stageId: input.stageId };
  }
  if (
    !(await storage.compareAndSwap(
      stageKey,
      expectedStage,
      staged,
      input.signal,
    ))
  )
    throw new Error('Relay enrollment stage already exists.');
  try {
    throwIfAborted(input.signal);
    const restored = await storage.read(stageKey, input.signal);
    throwIfAborted(input.signal);
    if (
      !isRecord(restored) ||
      restored.status !== 'staged' ||
      restored.stageId !== input.stageId ||
      !restored.key ||
      restored.key.privateKey.extractable ||
      !routeCurrent(input, selected.transport)
    )
      throw authorityError(
        'station_relay_stage_stale',
        'Relay enrollment stage could not be retained for the current route.',
      );
    restoreApplicationSessionKey(
      restored.key.privateKey,
      restored.key.publicKey,
    );
    return { stageId: input.stageId };
  } catch (error) {
    const current = await storage.read(stageKey);
    if (
      isRecord(current) &&
      current.status === 'staged' &&
      current.stageId === input.stageId
    )
      await storage.compareAndSwap(
        stageKey,
        identityOf(current)!,
        emptyRecord(recordScopeVersion(current) + 1),
      );
    throw error;
  }
}

/** Activate an exact staged grant only after Station returns its typed signed-activation receipt. */
export async function publishBrowserRelayApplicationAuthority(
  input: AuthorityRouteInput & {
    stageId: string;
    activationReceipt: RelayEnrollmentActivatedResponse;
    isRouteCurrent(): boolean;
    signal?: AbortSignal;
  },
  storage: BrowserRelayAuthorityStorage = defaultStorage,
) {
  throwIfAborted(input.signal);
  const clientOrigin = assertOrigin(window.location.origin, 'Browser origin');
  const key = routeKey(
    input.connectionId,
    input.applicationOrigin,
    input.route,
    clientOrigin,
  );
  const stageKey = `${key}::stage:${input.stageId}`;
  const transitionVersion = beginBrowserRelayAccountScopeChange(key);
  const selected = captureBrowserRelayRoute(
    input.connectionId,
    input.applicationOrigin,
    input.route,
  );
  const selectedTransport = selected?.transport;
  const stillSelected = () =>
    Boolean(
      selectedTransport &&
        routeCurrent(input, selectedTransport, input.isRouteCurrent),
    );
  try {
    const [stagedValue, activeValue] = await Promise.all([
      storage.read(stageKey, input.signal),
      storage.read(key, input.signal),
    ]);
    throwIfAborted(input.signal);
    if (
      !isRecord(stagedValue) ||
      stagedValue.status !== 'staged' ||
      stagedValue.stageId !== input.stageId ||
      !Number.isFinite(Date.parse(stagedValue.expiresAt)) ||
      Date.parse(stagedValue.expiresAt) <= Date.now() ||
      stagedValue.continuation.deviceId !== input.activationReceipt.deviceId ||
      input.stageId !== input.activationReceipt.enrollmentId ||
      input.activationReceipt.version !== 'station.relay-enrollment/v1' ||
      input.activationReceipt.state !== 'active' ||
      !OPAQUE.test(input.activationReceipt.receiptDigest) ||
      !Number.isFinite(Date.parse(input.activationReceipt.receiptExpiresAt)) ||
      Date.parse(input.activationReceipt.receiptExpiresAt) <= Date.now() ||
      !stillSelected()
    ) {
      readyScope(key, activeValue, transitionVersion);
      throw authorityError(
        'station_relay_activation_invalid',
        'Relay activation receipt does not match the staged Device authority.',
      );
    }
    const activeVersion =
      Math.max(recordScopeVersion(activeValue), transitionVersion) + 1;
    const active: ActiveAuthorityRecord = {
      connectionId: stagedValue.connectionId,
      applicationOrigin: stagedValue.applicationOrigin,
      route: stagedValue.route,
      bearer: stagedValue.bearer,
      continuation: stagedValue.continuation,
      key: stagedValue.key,
      clientOrigin: stagedValue.clientOrigin,
      installedAt: Date.now(),
      version: 1,
      status: 'active',
      authorityInstanceId: input.stageId,
      scopeVersion: activeVersion,
    };
    const committed = await storage.activateStaged({
      activeKey: key,
      stageKey,
      expectedActive: expectedIdentity(activeValue),
      expectedStage: expectedIdentity(stagedValue),
      active,
      stageTombstone: emptyRecord(1),
      signal: input.signal,
    });
    if (!committed) {
      const latest = await storage.read(key);
      readyScope(key, latest, transitionVersion);
      throw new Error(
        'Relay authority changed while activation was committing.',
      );
    }
    const promoted = await storage.read(key, input.signal);
    try {
      throwIfAborted(input.signal);
    } catch (error) {
      if (
        isActiveRecord(promoted) &&
        promoted.authorityInstanceId === input.stageId
      ) {
        const rollback = isActiveRecord(activeValue)
          ? { ...activeValue, scopeVersion: promoted.scopeVersion + 1 }
          : emptyRecord(promoted.scopeVersion + 1);
        await storage.compareAndSwap(key, identityOf(promoted)!, rollback);
      }
      const latest = await storage.read(key);
      readyScope(key, latest, transitionVersion);
      throw error;
    }
    if (
      !isActiveRecord(promoted) ||
      promoted.authorityInstanceId !== input.stageId ||
      !stillSelected()
    ) {
      const latest = await storage.read(key);
      if (
        isActiveRecord(latest) &&
        latest.authorityInstanceId === input.stageId
      ) {
        const rollback = isActiveRecord(activeValue)
          ? { ...activeValue, scopeVersion: activeVersion + 1 }
          : emptyRecord(activeVersion + 1);
        await storage.compareAndSwap(key, identityOf(latest)!, rollback);
      }
      const afterRollback = await storage.read(key);
      readyScope(key, afterRollback, activeVersion + 1);
      throw authorityError(
        'station_relay_route_stale',
        'The selected route changed while activation was committing.',
      );
    }
    restoreApplicationSessionKey(
      promoted.key.privateKey,
      promoted.key.publicKey,
    );
    readyScope(key, promoted, promoted.scopeVersion);
    return {
      authorityKey: promoted.continuation.authorityKey,
      deviceId: promoted.continuation.deviceId,
    };
  } catch (error) {
    const current = await storage.read(key).catch(() => undefined);
    if (current !== undefined) readyScope(key, current, transitionVersion);
    throw error;
  }
}

/** Remove only one enrollment's staged or just-promoted record, using instance CAS. */
export async function removeProvisionalBrowserRelayApplicationAuthority(
  input: AuthorityRouteInput & { stageId: string },
  storage: BrowserRelayAuthorityStorage = defaultStorage,
) {
  const clientOrigin = window.location.origin;
  const key = routeKey(
    input.connectionId,
    input.applicationOrigin,
    input.route,
    clientOrigin,
  );
  const stageKey = `${key}::stage:${input.stageId}`;
  const staged = await storage.read(stageKey);
  if (
    isRecord(staged) &&
    staged.status === 'staged' &&
    staged.stageId === input.stageId
  ) {
    await storage.compareAndSwap(
      stageKey,
      identityOf(staged)!,
      emptyRecord(recordScopeVersion(staged) + 1),
    );
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const active = await storage.read(key);
    if (!isActiveRecord(active) || active.authorityInstanceId !== input.stageId)
      break;
    const next = emptyRecord(active.scopeVersion + 1);
    if (await storage.compareAndSwap(key, identityOf(active)!, next)) {
      readyScope(key, next, next.scopeVersion);
      return;
    }
  }
}

export async function removeBrowserRelayApplicationAuthority(
  input: AuthorityRouteInput,
  storage: BrowserRelayAuthorityStorage = defaultStorage,
) {
  const key = routeKey(
    input.connectionId,
    input.applicationOrigin,
    input.route,
    window.location.origin,
  );
  const transitionVersion = beginBrowserRelayAccountScopeChange(key);
  const current = await storage.read(key);
  if (!isActiveRecord(current)) {
    readyScope(key, current, transitionVersion);
    return;
  }
  const next = emptyRecord(
    Math.max(current.scopeVersion, transitionVersion) + 1,
  );
  try {
    if (await storage.compareAndSwap(key, identityOf(current)!, next)) {
      readyScope(key, next, next.scopeVersion);
      return;
    }
    const latest = await storage.read(key);
    readyScope(key, latest, transitionVersion);
  } catch (error) {
    const latest = await storage.read(key).catch(() => undefined);
    if (latest !== undefined) readyScope(key, latest, transitionVersion);
    throw error;
  }
}

async function clearBrowserRelayAccountContinuation(
  input: AuthorityRouteInput,
  storage: BrowserRelayAuthorityStorage,
  expected: AuthorityIdentity,
  expectedAuthorityKey: string,
) {
  const key = routeKey(
    input.connectionId,
    input.applicationOrigin,
    input.route,
    window.location.origin,
  );
  const current = await storage.read(key);
  if (
    !isActiveRecord(current) ||
    !sameIdentity(identityOf(current), expected) ||
    current.continuation.authorityKey !== expectedAuthorityKey
  )
    return;
  const transitionVersion = beginBrowserRelayAccountScopeChange(key);
  const {
    continuation: _continuation,
    key: _key,
    ...deviceAuthority
  } = current;
  const next: DeviceOnlyAuthorityRecord = {
    ...deviceAuthority,
    status: 'device-only',
    scopeVersion: Math.max(current.scopeVersion, transitionVersion) + 1,
  };
  try {
    if (await storage.compareAndSwap(key, expected, next)) {
      readyScope(key, next, next.scopeVersion);
      return;
    }
    const latest = await storage.read(key);
    readyScope(key, latest, transitionVersion);
  } catch (error) {
    const latest = await storage.read(key).catch(() => undefined);
    if (latest !== undefined) readyScope(key, latest, transitionVersion);
    throw error;
  }
}

async function removeCapturedAuthority(
  input: AuthorityRouteInput,
  storage: BrowserRelayAuthorityStorage,
  expected: AuthorityIdentity,
  expectedAuthorityKey: string,
) {
  const key = routeKey(
    input.connectionId,
    input.applicationOrigin,
    input.route,
    window.location.origin,
  );
  const current = await storage.read(key);
  if (
    !isActiveRecord(current) ||
    !sameIdentity(identityOf(current), expected) ||
    current.continuation.authorityKey !== expectedAuthorityKey
  )
    return;
  const transitionVersion = beginBrowserRelayAccountScopeChange(key);
  const next = emptyRecord(
    Math.max(current.scopeVersion, transitionVersion) + 1,
  );
  try {
    if (await storage.compareAndSwap(key, expected, next)) {
      readyScope(key, next, next.scopeVersion);
      return;
    }
    const latest = await storage.read(key);
    readyScope(key, latest, transitionVersion);
  } catch (error) {
    const latest = await storage.read(key).catch(() => undefined);
    if (latest !== undefined) readyScope(key, latest, transitionVersion);
    throw error;
  }
}

/** Build the SDK credential adapter used only while this exact relay selection remains live. */
export async function createBrowserRelayApplicationCredential(input: {
  connectionId: string;
  applicationOrigin: string;
  route: NonNullable<SavedConnection['brokerRoute']>;
  transport: typeof fetch;
  routeIsCurrent(): boolean;
  storage?: BrowserRelayAuthorityStorage;
}): Promise<ClientCredential> {
  const storage = input.storage ?? defaultStorage;
  const clientOrigin = window.location.origin;
  const key = routeKey(
    input.connectionId,
    input.applicationOrigin,
    input.route,
    clientOrigin,
  );
  let capturedIdentity: AuthorityIdentity | null = null;
  let authorityQualifier = '';
  const load = async (expected?: AuthorityIdentity) => {
    if (!input.routeIsCurrent())
      throw authorityError(
        'station_relay_route_stale',
        'Selected encrypted Station route is stale.',
      );
    const value = await storage.read(key);
    if (
      !isActiveRecord(value) ||
      value.connectionId !== input.connectionId ||
      value.applicationOrigin !== input.applicationOrigin ||
      value.clientOrigin !== clientOrigin ||
      value.route.brokerOrigin !== input.route.brokerOrigin ||
      !sameScope(value.route.scope, input.route.scope) ||
      (value.bearer.kind !== 'device' && value.bearer.kind !== 'alias') ||
      !OPAQUE.test(value.bearer.credential) ||
      value.continuation.stationId !== input.route.scope.stationId ||
      !OPAQUE.test(value.continuation.credential) ||
      !OPAQUE.test(value.continuation.nonce) ||
      value.continuation.deviceId.length === 0 ||
      value.continuation.requestOrigin !== input.applicationOrigin ||
      value.continuation.clientOrigin !== clientOrigin ||
      !Number.isFinite(Date.parse(value.continuation.expiresAt)) ||
      Date.parse(value.continuation.expiresAt) <= Date.now() ||
      (expected && !sameIdentity(identityOf(value), expected)) ||
      !input.routeIsCurrent()
    )
      throw authorityError(
        'station_application_authority_required',
        'Approved Device and account continuation authority is unavailable or stale.',
      );
    const continuation = value.continuation;
    const privateKey = value.key.privateKey;
    const publicKey = value.key.publicKey;
    const signer = restoreApplicationSessionKey(privateKey, publicKey);
    if ((await publicKeyThumbprint(signer)) !== continuation.keyThumbprint)
      throw authorityError(
        'station_application_authority_invalid',
        'Account continuation signing key does not match its authority.',
      );
    if (!input.routeIsCurrent())
      throw authorityError(
        'station_relay_route_stale',
        'Selected encrypted Station route is stale.',
      );
    return { value, signer, identity: identityOf(value)!, continuation };
  };
  const initial = await load();
  capturedIdentity = initial.identity;
  readyScope(key, initial.value, initial.value.scopeVersion);
  const scopeSnapshot = getBrowserRelayAccountScope(key);
  // Scope versions also fence failed local transitions. The persisted record
  // version is a CAS identity, not necessarily the current UI invalidation
  // epoch; request and query scopes must use the same published qualifier.
  if (
    scopeSnapshot?.state !== 'ready' ||
    scopeSnapshot.authorityKey !== initial.continuation.authorityKey
  )
    throw authorityError(
      'station_application_authority_required',
      'Relay account scope is not ready for this Station.',
    );
  authorityQualifier = scopeSnapshot.scopeKey;
  const authorityIsCurrent = () =>
    input.routeIsCurrent() &&
    scopeSnapshot?.state === 'ready' &&
    getBrowserRelayAccountScope(key) === scopeSnapshot &&
    scopeSnapshot.authorityKey === initial.continuation.authorityKey;
  return {
    origin: input.applicationOrigin,
    credential: initial.value.bearer.credential,
    requestAuthority: {
      apiBase: input.applicationOrigin,
      authorityKey: authorityQualifier,
      isCurrent: authorityIsCurrent,
    },
    transportBindingIsCurrent: authorityIsCurrent,
    onUnauthorized: () =>
      removeCapturedAuthority(
        input,
        storage,
        capturedIdentity!,
        initial.continuation.authorityKey,
      ),
    onAccountUnauthorized: () =>
      clearBrowserRelayAccountContinuation(
        input,
        storage,
        capturedIdentity!,
        initial.continuation.authorityKey,
      ),
    transport: async (request, init) => {
      const { value, signer } = await load(capturedIdentity!);
      const url = request instanceof Request ? request.url : request.toString();
      if (new URL(url).origin !== input.applicationOrigin)
        throw new Error(
          'Relay application authority cannot move to another Station.',
        );
      if (!authorityIsCurrent())
        throw new Error('Selected encrypted Station route is stale.');
      const session = new ApplicationSessionClient(
        input.applicationOrigin,
        input.route.scope.stationId,
        clientOrigin,
        {},
        signer,
      );
      const proofHeaders = await session.headers(value.continuation!, {
        method:
          init?.method ?? (request instanceof Request ? request.method : 'GET'),
        url,
      });
      await load(capturedIdentity!);
      if (!authorityIsCurrent())
        throw new Error('Relay application authority changed before dispatch.');
      const headers = new Headers(
        init?.headers ??
          (request instanceof Request ? request.headers : undefined),
      );
      const authorization = headers.get('Authorization');
      if (
        authorization &&
        authorization !== `Bearer ${value.bearer.credential}`
      )
        throw new Error(
          'Relay request credential does not match its approved Device authority.',
        );
      headers.set('Authorization', `Bearer ${value.bearer.credential}`);
      for (const [name, value] of Object.entries(proofHeaders))
        headers.set(name, value);
      const response = await input.transport(request, { ...init, headers });
      if (!authorityIsCurrent())
        throw new Error(
          'Relay application authority changed during the request.',
        );
      return response;
    },
  };
}

/** Same-origin HTTPS cookie adoption; relayed cross-origin pages are rejected by the SDK contract. */
export async function adoptBrowserRelayCookies(input: {
  connectionId: string;
  applicationOrigin: string;
  route: NonNullable<SavedConnection['brokerRoute']>;
  storage?: BrowserRelayAuthorityStorage;
}) {
  const origin = assertOrigin(input.applicationOrigin, 'Station origin');
  if (
    origin !== window.location.origin ||
    new URL(origin).protocol !== 'https:'
  )
    throw new Error(
      'Cookie adoption requires the browser to be on the Station HTTPS origin.',
    );
  const key = await createApplicationSessionKey();
  const client = new ApplicationSessionClient(
    origin,
    input.route.scope.stationId,
    window.location.origin,
    {},
    key,
  );
  const adoption = await client.adoptCookies();
  await installBrowserRelayApplicationAuthority(
    {
      ...input,
      bearer: { kind: 'alias', credential: adoption.aliasCredential },
      key,
      continuation: adoption.continuation,
    },
    input.storage,
  );
  return { aliasId: adoption.aliasId, aliasExpiresAt: adoption.aliasExpiresAt };
}
