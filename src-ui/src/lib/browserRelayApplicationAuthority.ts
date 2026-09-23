import type { SavedConnection } from '@kontourai/station-connect';
import type { ApplicationSessionContinuation } from '@kontourai/station-contracts/application-session';
import type { SelfHostedBrokerScopeV1 } from '@kontourai/station-contracts/self-hosted-broker';
import {
  ApplicationSessionClient,
  type ApplicationSessionKey,
  createApplicationSessionKey,
  restoreApplicationSessionKey,
} from '@kontourai/station-sdk/application-session';
import type { ClientCredential } from '@kontourai/station-sdk/client';
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

type AuthorityRecord = Omit<
  BrowserRelayAuthorityInput,
  'key' | 'continuation'
> & {
  key?: {
    privateKey: CryptoKey;
    publicKey: ApplicationSessionKey['publicKey'];
  };
  continuation?: ApplicationSessionContinuation;
  version: 1;
  clientOrigin: string;
  installedAt: number;
};

export interface BrowserRelayAuthorityStorage {
  read(key: string): Promise<unknown | null>;
  write(key: string, record: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

function routeKey(
  connectionId: string,
  applicationOrigin: string,
  route: NonNullable<SavedConnection['brokerRoute']>,
  clientOrigin: string,
) {
  const scope = route.scope;
  return JSON.stringify([
    connectionId,
    new URL(applicationOrigin).origin,
    route.brokerOrigin,
    scope.stationId,
    scope.enrollmentId,
    scope.routingGeneration,
    scope.browserOrigin,
    clientOrigin,
  ]);
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
): Promise<T | undefined> {
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
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE))
        open.result.createObjectStore(STORE);
    };
    open.onerror = open.onblocked = () =>
      reject(new Error('Relay application authority storage is unavailable.'));
    open.onsuccess = () => {
      const db = open.result;
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
      tx.onerror = tx.onabort = () => {
        if (!failed)
          reject(new Error('Relay application authority storage failed.'));
        failed = true;
      };
      tx.oncomplete = () => {
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
  async read(key: string) {
    return (
      (await transaction<unknown>('readonly', (store) => store.get(key))) ??
      null
    );
  }
  async write(key: string, record: unknown) {
    await transaction('readwrite', (store) => store.put(record, key));
  }
  async remove(key: string) {
    await transaction('readwrite', (store) => store.delete(key));
  }
}

const defaultStorage = new IndexedDbBrowserRelayAuthorityStorage();
const epochs = new Map<string, number>();

function bump(key: string) {
  epochs.set(key, (epochs.get(key) ?? 0) + 1);
}

/** Persist a server-issued authority only for the currently selected, trusted encrypted route. */
export async function installBrowserRelayApplicationAuthority(
  input: BrowserRelayAuthorityInput,
  storage: BrowserRelayAuthorityStorage = defaultStorage,
) {
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
    Date.parse(input.continuation.expiresAt) <= Date.now() ||
    input.continuation.keyThumbprint !== (await publicKeyThumbprint(input.key))
  )
    throw new Error(
      'Relay application authority does not match this Station route.',
    );
  const current = captureBrowserRelayRoute(
    input.connectionId,
    applicationOrigin,
    input.route,
  );
  if (!current?.isCurrent())
    throw new Error('The selected encrypted Station route is not current.');
  const key = routeKey(
    input.connectionId,
    applicationOrigin,
    input.route,
    clientOrigin,
  );
  const record: AuthorityRecord = {
    ...input,
    key: {
      privateKey: input.key.privateKey,
      publicKey: input.key.publicKey,
    },
    version: 1,
    clientOrigin,
    applicationOrigin,
    installedAt: Date.now(),
  };
  await storage.write(key, record);
  // Prove this browser can restore the non-extractable key before declaring
  // the authority installed. A storage failure cannot silently downgrade.
  const restored = await storage.read(key);
  if (
    !isRecord(restored) ||
    restored.version !== 1 ||
    !restored.key ||
    !restored.continuation ||
    restored.key.privateKey.extractable
  )
    throw new Error(
      'Relay application authority could not be restored securely.',
    );
  restoreApplicationSessionKey(restored.key.privateKey, restored.key.publicKey);
  bump(key);
  return {
    authorityKey: input.continuation.authorityKey,
    deviceId: input.continuation.deviceId,
  };
}

function isRecord(value: unknown): value is AuthorityRecord {
  return Boolean(value && typeof value === 'object' && 'version' in value);
}

export async function removeBrowserRelayApplicationAuthority(
  input: Pick<
    BrowserRelayAuthorityInput,
    'connectionId' | 'applicationOrigin' | 'route'
  >,
  storage: BrowserRelayAuthorityStorage = defaultStorage,
) {
  const key = routeKey(
    input.connectionId,
    input.applicationOrigin,
    input.route,
    window.location.origin,
  );
  bump(key);
  await storage.remove(key);
}

async function clearBrowserRelayAccountContinuation(
  input: Pick<
    BrowserRelayAuthorityInput,
    'connectionId' | 'applicationOrigin' | 'route'
  >,
  storage: BrowserRelayAuthorityStorage,
) {
  const key = routeKey(
    input.connectionId,
    input.applicationOrigin,
    input.route,
    window.location.origin,
  );
  bump(key);
  const current = await storage.read(key);
  if (!isRecord(current)) return;
  // Account refusal retires only account proof material. The independently
  // approved Device or alias credential remains stored for its own recovery.
  const {
    continuation: _continuation,
    key: _key,
    ...deviceAuthority
  } = current;
  await storage.write(key, deviceAuthority);
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
  const installedEpoch = epochs.get(key) ?? 0;
  const load = async () => {
    if (!input.routeIsCurrent())
      throw authorityError(
        'station_relay_route_stale',
        'Selected encrypted Station route is stale.',
      );
    const value = await storage.read(key);
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      value.connectionId !== input.connectionId ||
      value.applicationOrigin !== input.applicationOrigin ||
      value.clientOrigin !== clientOrigin ||
      value.route.brokerOrigin !== input.route.brokerOrigin ||
      !sameScope(value.route.scope, input.route.scope) ||
      (value.bearer.kind !== 'device' && value.bearer.kind !== 'alias') ||
      !OPAQUE.test(value.bearer.credential) ||
      !value.key ||
      !value.continuation ||
      value.continuation.stationId !== input.route.scope.stationId ||
      !OPAQUE.test(value.continuation.credential) ||
      !OPAQUE.test(value.continuation.nonce) ||
      value.continuation.deviceId.length === 0 ||
      value.continuation.requestOrigin !== input.applicationOrigin ||
      value.continuation.clientOrigin !== clientOrigin ||
      !Number.isFinite(Date.parse(value.continuation.expiresAt)) ||
      Date.parse(value.continuation.expiresAt) <= Date.now() ||
      !input.routeIsCurrent()
    )
      throw authorityError(
        'station_application_authority_required',
        'Approved Device and account continuation authority is unavailable or stale.',
      );
    const continuation = value.continuation;
    if (!continuation)
      throw new Error('Account continuation authority is missing.');
    const privateKey = value.key.privateKey;
    const publicKey = value.key.publicKey;
    const signer = restoreApplicationSessionKey(privateKey, publicKey);
    if ((await publicKeyThumbprint(signer)) !== continuation.keyThumbprint)
      throw authorityError(
        'station_application_authority_invalid',
        'Account continuation signing key does not match its authority.',
      );
    return { value, signer };
  };
  const initial = await load();
  const authorityIsCurrent = () =>
    input.routeIsCurrent() && (epochs.get(key) ?? 0) === installedEpoch;
  return {
    origin: input.applicationOrigin,
    credential: initial.value.bearer.credential,
    requestAuthority: {
      apiBase: input.applicationOrigin,
      authorityKey: `relay:${input.connectionId}:${input.route.scope.stationId}:${input.route.scope.enrollmentId}:${input.route.scope.routingGeneration}`,
      isCurrent: authorityIsCurrent,
    },
    transportBindingIsCurrent: authorityIsCurrent,
    onUnauthorized: () =>
      removeBrowserRelayApplicationAuthority(input, storage),
    onAccountUnauthorized: () =>
      clearBrowserRelayAccountContinuation(input, storage),
    transport: async (request, init) => {
      const { value, signer } = await load();
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
