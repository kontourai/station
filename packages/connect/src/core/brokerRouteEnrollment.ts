import type {
  ApprovedStationConnectionTrust,
  DeviceConnectionTrustRecord,
} from '@kontourai/station-contracts/connection-proof';
import type {
  SelfHostedBrokerClientGrantV1,
  SelfHostedBrokerRouteInvitationV1,
  SelfHostedBrokerScopeV1,
} from '@kontourai/station-contracts/self-hosted-broker';
import {
  copyStationConnectionTrust,
  stationConnectionSigningKeyId,
} from '@kontourai/station-shared/connection-proof';
import type { BrowserRoutingCredentialProvider } from './selfHostedBrokerBrowserClient.js';

const DATABASE = 'station-browser-routing-grants-v1';
const STORE = 'grants';
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_RESPONSE_CHUNKS = 256;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_INVITATION_BYTES = 4096;
const SAFE_ID = /^[A-Za-z0-9_-]{8,128}$/;
const OPAQUE = /^[A-Za-z0-9_-]{43}$/;

export interface BrokerRouteTrustStore {
  read(stationId: string): Promise<DeviceConnectionTrustRecord | null>;
}

export interface BrowserRoutingGrantStorage {
  read(key: string): Promise<unknown | null>;
  write(key: string, grant: SelfHostedBrokerClientGrantV1): Promise<void>;
  removeIfCredentialId(key: string, credentialId: string): Promise<void>;
}

export interface BrowserRoutingGrantOperation {
  readonly epoch: number;
  readonly key: string;
  readonly signal: AbortSignal;
}

function copyTrustRecord(value: DeviceConnectionTrustRecord) {
  const record = exact(
    value,
    ['schemaVersion', 'revision', 'status', 'trust'],
    'broker_route_trust_required',
  );
  if (
    record.schemaVersion !== 1 ||
    !Number.isSafeInteger(record.revision) ||
    (record.revision as number) < 1 ||
    record.status !== 'approved'
  )
    throw new Error('broker_route_trust_required');
  return Object.freeze({
    schemaVersion: 1 as const,
    revision: record.revision as number,
    status: 'approved' as const,
    trust: copyStationConnectionTrust(
      record.trust as ApprovedStationConnectionTrust,
    ),
  });
}

function exact(value: unknown, keys: readonly string[], code: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(code);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== [...keys].sort().join(','))
    throw new Error(code);
  return record;
}

function canonicalOrigin(value: string, label: string): string {
  if (typeof value !== 'string' || value.length > 2048)
    throw new Error(`${label}_invalid`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label}_invalid`);
  }
  if (
    url.origin !== value ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error(`${label}_invalid`);
  if (url.protocol === 'https:') return url.origin;
  if (
    url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]', '::1'].includes(
      url.hostname.toLowerCase(),
    )
  )
    return url.origin;
  throw new Error(`${label}_invalid`);
}

function actualBrowserOrigin(): string {
  const origin = (globalThis as { location?: { origin?: unknown } }).location
    ?.origin;
  if (typeof origin !== 'string')
    throw new Error('broker_browser_origin_invalid');
  return canonicalOrigin(origin, 'broker_browser_origin');
}

function validScope(value: unknown, expectedBrowserOrigin: string) {
  const scope = exact(
    value,
    ['stationId', 'enrollmentId', 'routingGeneration', 'browserOrigin'],
    'broker_scope_invalid',
  ) as unknown as SelfHostedBrokerScopeV1;
  if (
    typeof scope.stationId !== 'string' ||
    !SAFE_ID.test(scope.stationId) ||
    typeof scope.enrollmentId !== 'string' ||
    !SAFE_ID.test(scope.enrollmentId) ||
    !Number.isSafeInteger(scope.routingGeneration) ||
    scope.routingGeneration < 1 ||
    canonicalOrigin(scope.browserOrigin, 'broker_browser_origin') !==
      expectedBrowserOrigin
  )
    throw new Error('broker_scope_invalid');
  return Object.freeze({ ...scope });
}

function sameScope(
  left: SelfHostedBrokerScopeV1,
  right: SelfHostedBrokerScopeV1,
): boolean {
  return (
    left.stationId === right.stationId &&
    left.enrollmentId === right.enrollmentId &&
    left.routingGeneration === right.routingGeneration &&
    left.browserOrigin === right.browserOrigin
  );
}

function validateInvitation(
  value: unknown,
  expectedBrowserOrigin: string,
  now: number,
): SelfHostedBrokerRouteInvitationV1 {
  const raw = exact(
    value,
    [
      'version',
      'brokerOrigin',
      'scope',
      'stationSigningKeyId',
      'stationSigningGeneration',
      'invitationId',
      'invitationSecret',
      'expiresAt',
    ],
    'broker_invitation_invalid',
  );
  const brokerOrigin = canonicalOrigin(
    raw.brokerOrigin as string,
    'broker_origin',
  );
  const scope = validScope(raw.scope, expectedBrowserOrigin);
  if (
    raw.version !== 'station-broker-route-invitation/v1' ||
    typeof raw.invitationId !== 'string' ||
    !SAFE_ID.test(raw.invitationId) ||
    typeof raw.invitationSecret !== 'string' ||
    !OPAQUE.test(raw.invitationSecret) ||
    !Number.isSafeInteger(raw.expiresAt) ||
    (raw.expiresAt as number) <= now ||
    typeof raw.stationSigningKeyId !== 'string' ||
    !OPAQUE.test(raw.stationSigningKeyId) ||
    !Number.isSafeInteger(raw.stationSigningGeneration) ||
    (raw.stationSigningGeneration as number) < 1
  )
    throw new Error('broker_invitation_invalid');
  return Object.freeze({
    version: raw.version,
    brokerOrigin,
    scope,
    stationSigningKeyId: raw.stationSigningKeyId,
    stationSigningGeneration: raw.stationSigningGeneration as number,
    invitationId: raw.invitationId,
    invitationSecret: raw.invitationSecret,
    expiresAt: raw.expiresAt as number,
  });
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error('broker_invitation_fragment_invalid');
  const padded =
    value.replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - (value.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error('broker_invitation_fragment_invalid');
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (
    encodeBase64Url(bytes) !== value ||
    bytes.byteLength > MAX_INVITATION_BYTES
  )
    throw new Error('broker_invitation_fragment_invalid');
  return bytes;
}

/** Encodes an invitation into the non-request Computers URL fragment. */
export function encodeBrokerRouteInvitationFragment(
  invitationValue: SelfHostedBrokerRouteInvitationV1,
  now = Date.now(),
): string {
  const invitation = validateInvitation(
    invitationValue,
    canonicalOrigin(
      invitationValue.scope.browserOrigin,
      'broker_browser_origin',
    ),
    now,
  );
  const bytes = new TextEncoder().encode(JSON.stringify(invitation));
  if (bytes.byteLength > MAX_INVITATION_BYTES)
    throw new Error('broker_invitation_too_large');
  return `#relay-invite=${encodeBase64Url(bytes)}`;
}

/**
 * Reads only `${browserOrigin}/connections/computers#relay-invite=<base64url JSON>`.
 * Callers must replace the URL without the fragment before fetch or telemetry.
 */
export function parseBrokerRouteInvitationUrl(
  value: string,
  now = Date.now(),
): SelfHostedBrokerRouteInvitationV1 {
  const browserOrigin = actualBrowserOrigin();
  let url: URL;
  try {
    url = new URL(value, browserOrigin);
  } catch {
    throw new Error('broker_invitation_fragment_invalid');
  }
  if (
    url.origin !== browserOrigin ||
    url.pathname !== '/connections/computers' ||
    url.search
  )
    throw new Error('broker_invitation_fragment_invalid');
  const match = /^#relay-invite=([A-Za-z0-9_-]+)$/.exec(url.hash);
  if (!match || match[1]!.length > Math.ceil((MAX_INVITATION_BYTES * 4) / 3))
    throw new Error('broker_invitation_fragment_invalid');
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        decodeBase64Url(match[1]!),
      ),
    ) as unknown;
  } catch {
    throw new Error('broker_invitation_fragment_invalid');
  }
  return validateInvitation(decoded, url.origin, now);
}

function routeKey(grant: SelfHostedBrokerClientGrantV1): string {
  return routeStorageKey(
    grant.brokerOrigin,
    grant.scope,
    grant.scope.browserOrigin,
  );
}

function routeStorageKey(
  brokerOrigin: string,
  scope: SelfHostedBrokerScopeV1,
  browserOrigin: string,
): string {
  return [
    brokerOrigin,
    scope.stationId,
    scope.enrollmentId,
    browserOrigin,
  ].join('\n');
}

function validateGrant(
  value: unknown,
  browserOrigin: string,
  now: number,
): SelfHostedBrokerClientGrantV1 {
  const grant = exact(
    value,
    [
      'version',
      'brokerOrigin',
      'scope',
      'stationSigningKeyId',
      'stationSigningGeneration',
      'credential',
      'expiresAt',
    ],
    'broker_grant_invalid',
  ) as unknown as SelfHostedBrokerClientGrantV1;
  const credential = exact(
    grant.credential,
    ['id', 'secret'],
    'broker_grant_invalid',
  );
  if (
    grant.version !== 'station-broker-client-grant/v1' ||
    canonicalOrigin(grant.brokerOrigin, 'broker_origin') !==
      grant.brokerOrigin ||
    !Number.isSafeInteger(grant.expiresAt) ||
    grant.expiresAt <= now ||
    typeof grant.stationSigningKeyId !== 'string' ||
    !OPAQUE.test(grant.stationSigningKeyId) ||
    !Number.isSafeInteger(grant.stationSigningGeneration) ||
    grant.stationSigningGeneration < 1 ||
    typeof credential.id !== 'string' ||
    !SAFE_ID.test(credential.id) ||
    typeof credential.secret !== 'string' ||
    !OPAQUE.test(credential.secret)
  )
    throw new Error('broker_grant_invalid');
  const scope = validScope(grant.scope, browserOrigin);
  return Object.freeze({
    version: grant.version,
    brokerOrigin: grant.brokerOrigin,
    scope,
    stationSigningKeyId: grant.stationSigningKeyId,
    stationSigningGeneration: grant.stationSigningGeneration,
    credential: Object.freeze({ id: credential.id, secret: credential.secret }),
    expiresAt: grant.expiresAt,
  });
}

function trustRecordsMatch(
  left: DeviceConnectionTrustRecord | null,
  right: DeviceConnectionTrustRecord,
): boolean {
  return Boolean(
    left &&
      left.schemaVersion === 1 &&
      left.revision === right.revision &&
      left.status === 'approved' &&
      right.status === 'approved' &&
      left.trust.stationId === right.trust.stationId &&
      left.trust.enrollmentId === right.trust.enrollmentId &&
      left.trust.generation === right.trust.generation &&
      left.trust.signingKey.kty === right.trust.signingKey.kty &&
      left.trust.signingKey.crv === right.trust.signingKey.crv &&
      left.trust.signingKey.x === right.trust.signingKey.x &&
      left.trust.signingKey.y === right.trust.signingKey.y,
  );
}

async function boundedJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (response.redirected || !response.body)
    throw new Error('broker_response_invalid');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let chunksRead = 0;
  let complete = false;
  const onAbort = () => void reader.cancel(signal.reason).catch(() => {});
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const item = await readWithSignal(reader.read(), signal);
      if (item.done) {
        complete = true;
        break;
      }
      if (++chunksRead > MAX_RESPONSE_CHUNKS)
        throw new Error('broker_response_too_large');
      size += item.value.byteLength;
      if (size > MAX_RESPONSE_BYTES)
        throw new Error('broker_response_too_large');
      chunks.push(item.value);
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new Error('broker_response_invalid');
  }
}

function readWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted)
    return Promise.reject(signal.reason ?? new Error('cancelled'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? new Error('cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function readWithOperation<T>(
  promise: Promise<T>,
  operation: BrowserRoutingGrantOperation,
  signal?: AbortSignal,
): Promise<T> {
  const owned = readWithSignal(promise, operation.signal);
  return signal ? readWithSignal(owned, signal) : owned;
}

/**
 * IndexedDB custody isolated from Station profiles and application credentials.
 * One active grant is stored per broker, Station enrollment, and browser origin.
 */
export class IndexedDbBrowserRoutingGrantStorage
  implements BrowserRoutingGrantStorage
{
  private async transact<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T> | undefined,
  ): Promise<T | undefined> {
    if (!globalThis.isSecureContext || !globalThis.indexedDB)
      throw new Error('broker_grant_storage_unavailable');
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = globalThis.indexedDB.open(DATABASE, 1);
      } catch {
        reject(new Error('broker_grant_storage_unavailable'));
        return;
      }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE))
          request.result.createObjectStore(STORE);
      };
      request.onerror = () =>
        reject(new Error('broker_grant_storage_unavailable'));
      request.onblocked = () =>
        reject(new Error('broker_grant_storage_unavailable'));
      request.onsuccess = () => resolve(request.result);
    });
    database.onversionchange = () => database.close();
    try {
      return await new Promise<T | undefined>((resolve, reject) => {
        let transaction: IDBTransaction;
        try {
          transaction = database.transaction(
            STORE,
            mode,
            mode === 'readwrite' ? { durability: 'strict' } : undefined,
          );
        } catch {
          reject(new Error('broker_grant_storage_unavailable'));
          return;
        }
        if (mode === 'readwrite' && transaction.durability !== 'strict') {
          transaction.abort();
          reject(new Error('broker_grant_storage_unavailable'));
          return;
        }
        let result: T | undefined;
        let failed = false;
        transaction.onabort = transaction.onerror = () => {
          if (!failed) reject(new Error('broker_grant_storage_unavailable'));
          failed = true;
        };
        transaction.oncomplete = () => resolve(result);
        try {
          const request = operation(transaction.objectStore(STORE));
          if (request) {
            request.onsuccess = () => {
              result = request.result;
            };
            request.onerror = () => {
              failed = true;
              reject(new Error('broker_grant_storage_unavailable'));
              transaction.abort();
            };
          }
        } catch {
          failed = true;
          reject(new Error('broker_grant_storage_unavailable'));
          transaction.abort();
        }
      });
    } finally {
      database.close();
    }
  }

  async read(key: string): Promise<unknown | null> {
    return (
      (await this.transact<unknown>('readonly', (store) => store.get(key))) ??
      null
    );
  }

  async write(
    key: string,
    grant: SelfHostedBrokerClientGrantV1,
  ): Promise<void> {
    await this.transact('readwrite', (store) => store.put(grant, key));
  }

  async removeIfCredentialId(key: string, credentialId: string): Promise<void> {
    await this.transact('readwrite', (store) => {
      const request = store.get(key);
      request.addEventListener('success', () => {
        const value = request.result as
          | SelfHostedBrokerClientGrantV1
          | undefined;
        if (value?.credential?.id === credentialId) store.delete(key);
      });
      return request;
    });
  }
}

/**
 * Owns the browser's current broker routing grant. It exposes only the
 * provider contract consumed by SelfHostedBrokerBrowserClient; Station bearer,
 * Device grant, account session, and Project authority never enter this owner.
 */
export class BrowserRoutingGrantCustody
  implements BrowserRoutingCredentialProvider
{
  private grant: SelfHostedBrokerClientGrantV1 | null = null;
  private epoch = 0;
  private activeOperation: BrowserRoutingGrantOperation | null = null;
  private operationController: AbortController | null = null;
  private boundTrust: DeviceConnectionTrustRecord | null = null;
  private boundTrustStore: BrokerRouteTrustStore | null = null;
  private persistence: Promise<void> = Promise.resolve();
  private readonly storage: BrowserRoutingGrantStorage;
  private readonly now: () => number;

  constructor(
    input: {
      storage?: BrowserRoutingGrantStorage;
      now?: () => number;
    } = {},
  ) {
    this.storage = input.storage ?? new IndexedDbBrowserRoutingGrantStorage();
    this.now = input.now ?? Date.now;
  }

  /** Starts a user enrollment synchronously so later async results are owned. */
  beginEnrollment(
    brokerOriginValue: string,
    scopeValue: SelfHostedBrokerScopeV1,
  ): BrowserRoutingGrantOperation {
    const browserOrigin = actualBrowserOrigin();
    const brokerOrigin = canonicalOrigin(brokerOriginValue, 'broker_origin');
    const scope = validScope(scopeValue, browserOrigin);
    return this.beginOperation(
      routeStorageKey(brokerOrigin, scope, browserOrigin),
    );
  }

  isEnrollmentCurrent(operation: BrowserRoutingGrantOperation): boolean {
    return (
      this.activeOperation === operation &&
      this.epoch === operation.epoch &&
      !operation.signal.aborted
    );
  }

  assertEnrollmentCurrent(
    operation: BrowserRoutingGrantOperation,
    signal?: AbortSignal,
  ): void {
    signal?.throwIfAborted();
    if (!this.isEnrollmentCurrent(operation))
      throw operation.signal.reason ?? new Error('broker_grant_stale');
  }

  cancelEnrollment(operation: BrowserRoutingGrantOperation): void {
    if (this.activeOperation === operation) this.invalidate();
  }

  async restore(input: {
    brokerOrigin: string;
    scope: SelfHostedBrokerScopeV1;
    trustRecord: DeviceConnectionTrustRecord;
    trustStore: BrokerRouteTrustStore;
  }): Promise<boolean> {
    const trustRecord = copyTrustRecord(input.trustRecord);
    const browserOrigin = actualBrowserOrigin();
    const brokerOrigin = canonicalOrigin(input.brokerOrigin, 'broker_origin');
    const scope = validScope(input.scope, browserOrigin);
    const key = routeStorageKey(brokerOrigin, scope, browserOrigin);
    const operation = this.beginOperation(key);
    try {
      const stored = await readWithOperation(
        this.serialize(() => this.storage.read(key)),
        operation,
      );
      this.assertEnrollmentCurrent(operation);
      if (stored === null) return false;
      let grant: SelfHostedBrokerClientGrantV1;
      try {
        grant = validateGrant(stored, browserOrigin, this.now());
      } catch {
        return false;
      }
      const trustCurrent = await readWithOperation(
        approvedTrustIsCurrent(trustRecord, input.trustStore, {
          stationId: grant.scope.stationId,
          enrollmentId: grant.scope.enrollmentId,
          stationSigningKeyId: grant.stationSigningKeyId,
          stationSigningGeneration: grant.stationSigningGeneration,
        }),
        operation,
      );
      this.assertEnrollmentCurrent(operation);
      if (
        grant.brokerOrigin !== brokerOrigin ||
        !sameScope(grant.scope, scope) ||
        !trustCurrent
      ) {
        await this.serialize(() =>
          this.storage.removeIfCredentialId(key, grant.credential.id),
        );
        return false;
      }
      this.assertEnrollmentCurrent(operation);
      this.grant = grant;
      this.boundTrust = trustRecord;
      this.boundTrustStore = input.trustStore;
      this.activeOperation = null;
      this.operationController = null;
      this.epoch += 1;
      return true;
    } catch (error) {
      if (!this.isEnrollmentCurrent(operation)) return false;
      throw error;
    } finally {
      this.cancelEnrollment(operation);
    }
  }

  /** Install a verified redeemed grant as this route's sole current grant. */
  async replace(
    grantValue: SelfHostedBrokerClientGrantV1,
    trustRecord: DeviceConnectionTrustRecord,
    trustStore: BrokerRouteTrustStore,
    options: {
      operation?: BrowserRoutingGrantOperation;
      signal?: AbortSignal;
    } = {},
  ): Promise<void> {
    const browserOrigin = actualBrowserOrigin();
    const grant = validateGrant(grantValue, browserOrigin, this.now());
    const key = routeKey(grant);
    const operation = options.operation ?? this.beginOperation(key);
    if (operation.key !== key || !this.isEnrollmentCurrent(operation))
      throw new Error('broker_grant_stale');
    try {
      await this.installGrant(
        grant,
        trustRecord,
        trustStore,
        operation,
        options.signal,
      );
    } catch (error) {
      this.cancelEnrollment(operation);
      throw error;
    }
  }

  private async installGrant(
    grant: SelfHostedBrokerClientGrantV1,
    trustRecord: DeviceConnectionTrustRecord,
    trustStore: BrokerRouteTrustStore,
    operation: BrowserRoutingGrantOperation,
    signal?: AbortSignal,
  ): Promise<void> {
    const trustSnapshot = copyTrustRecord(trustRecord);
    const key = routeKey(grant);
    const binding = {
      stationId: grant.scope.stationId,
      enrollmentId: grant.scope.enrollmentId,
      stationSigningKeyId: grant.stationSigningKeyId,
      stationSigningGeneration: grant.stationSigningGeneration,
    };
    this.assertEnrollmentCurrent(operation, signal);
    const trustCurrent = await readWithOperation(
      approvedTrustIsCurrent(trustSnapshot, trustStore, binding),
      operation,
      signal,
    );
    this.assertEnrollmentCurrent(operation, signal);
    if (!trustCurrent) throw new Error('broker_route_trust_retired');

    let persisted = false;
    try {
      await this.serialize(() => this.storage.write(key, grant));
      persisted = true;
      this.assertEnrollmentCurrent(operation, signal);
      const stillTrusted = await readWithOperation(
        approvedTrustIsCurrent(trustSnapshot, trustStore, binding),
        operation,
        signal,
      );
      this.assertEnrollmentCurrent(operation, signal);
      if (!stillTrusted) throw new Error('broker_route_trust_retired');

      this.grant = grant;
      this.boundTrust = trustSnapshot;
      this.boundTrustStore = trustStore;
      this.activeOperation = null;
      this.operationController = null;
      this.epoch += 1;
    } catch (error) {
      if (persisted)
        await this.serialize(() =>
          this.storage.removeIfCredentialId(key, grant.credential.id),
        );
      throw error;
    }
  }

  /** Local deletion only; the broker grant stays live until broker retirement or expiry. */
  async forgetLocal(): Promise<void> {
    const old = this.grant;
    this.invalidate();
    if (old)
      await this.serialize(() =>
        this.storage.removeIfCredentialId(routeKey(old), old.credential.id),
      );
  }

  /**
   * Forgets one saved browser route, including a grant that has not yet been
   * restored into this process. This is local storage cleanup; broker-side
   * retirement remains a separate authenticated operation.
   */
  async forgetRoute(input: {
    brokerOrigin: string;
    scope: SelfHostedBrokerScopeV1;
  }): Promise<void> {
    const browserOrigin = actualBrowserOrigin();
    const brokerOrigin = canonicalOrigin(input.brokerOrigin, 'broker_origin');
    const scope = validScope(input.scope, browserOrigin);
    const key = [
      brokerOrigin,
      scope.stationId,
      scope.enrollmentId,
      browserOrigin,
    ].join('\n');
    if (
      (this.grant && routeKey(this.grant) === key) ||
      this.activeOperation?.key === key
    )
      this.invalidate();

    // The read captures the exact credential identity to remove. The CAS
    // after it prevents a later same-route enrollment from being deleted.
    const stored = await this.serialize(() => this.storage.read(key));
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return;
    const credential = (stored as { credential?: { id?: unknown } }).credential;
    if (typeof credential?.id !== 'string') return;
    await this.serialize(() =>
      this.storage.removeIfCredentialId(key, credential.id as string),
    );
  }

  /** Profile/client switches retire the in-memory authority immediately. */
  invalidate(): void {
    this.operationController?.abort(new Error('broker_grant_stale'));
    this.operationController = null;
    this.activeOperation = null;
    this.epoch += 1;
    this.grant = null;
    this.boundTrust = null;
    this.boundTrustStore = null;
  }

  /**
   * Async connection-start guard consumed by the broker/Pion composition.
   * The separate trust store remains the authority; grant metadata can only
   * match that existing approval and can never create or approve it.
   */
  async assertBoundToTrust(
    trustRecord: DeviceConnectionTrustRecord,
    route: {
      brokerOrigin: string;
      browserOrigin: string;
      scope: SelfHostedBrokerScopeV1;
    },
  ): Promise<boolean> {
    const grant = this.grant;
    const boundTrust = this.boundTrust;
    const trustStore = this.boundTrustStore;
    const epoch = this.epoch;
    if (!grant || !boundTrust || !trustStore || grant.expiresAt <= this.now()) {
      this.invalidate();
      return false;
    }
    let expectedBrowserOrigin: string;
    let trustSnapshot: ReturnType<typeof copyTrustRecord>;
    try {
      trustSnapshot = copyTrustRecord(trustRecord);
      expectedBrowserOrigin = actualBrowserOrigin();
      if (
        canonicalOrigin(route.browserOrigin, 'broker_browser_origin') !==
          expectedBrowserOrigin ||
        canonicalOrigin(route.brokerOrigin, 'broker_origin') !==
          grant.brokerOrigin ||
        !sameScope(
          validScope(route.scope, expectedBrowserOrigin),
          grant.scope,
        ) ||
        !trustRecordsMatch(trustSnapshot, boundTrust)
      )
        throw new Error('broker_grant_binding_invalid');
    } catch {
      await this.retire(grant, epoch);
      return false;
    }
    const binding = {
      stationId: grant.scope.stationId,
      enrollmentId: grant.scope.enrollmentId,
      stationSigningKeyId: grant.stationSigningKeyId,
      stationSigningGeneration: grant.stationSigningGeneration,
    };
    const current = await approvedTrustIsCurrent(
      trustSnapshot,
      trustStore,
      binding,
    );
    if (!current || this.epoch !== epoch || this.grant !== grant) {
      await this.retire(grant, epoch);
      return false;
    }
    return true;
  }

  private async retire(
    grant: SelfHostedBrokerClientGrantV1,
    expectedEpoch: number,
  ) {
    if (this.epoch === expectedEpoch && this.grant === grant) this.invalidate();
    await this.serialize(() =>
      this.storage.removeIfCredentialId(routeKey(grant), grant.credential.id),
    );
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.persistence.then(operation, operation);
    this.persistence = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private beginOperation(key: string): BrowserRoutingGrantOperation {
    this.invalidate();
    const controller = new AbortController();
    const operation = Object.freeze({
      epoch: this.epoch,
      key,
      signal: controller.signal,
    });
    this.operationController = controller;
    this.activeOperation = operation;
    return operation;
  }

  capture() {
    const grant = this.grant;
    const epoch = this.epoch;
    if (!grant || grant.expiresAt <= this.now())
      throw new Error('broker_credential_unavailable');
    const id = grant.credential.id;
    const secret = grant.credential.secret;
    return Object.freeze({
      id,
      secret,
      isCurrent: () =>
        this.epoch === epoch &&
        this.grant === grant &&
        grant.expiresAt > this.now(),
    });
  }
}

async function approvedTrustIsCurrent(
  trustRecord: DeviceConnectionTrustRecord,
  trustStore: BrokerRouteTrustStore,
  binding: {
    stationId: string;
    enrollmentId: string;
    stationSigningKeyId: string;
    stationSigningGeneration: number;
  },
): Promise<boolean> {
  try {
    if (
      trustRecord.schemaVersion !== 1 ||
      !Number.isSafeInteger(trustRecord.revision) ||
      trustRecord.revision < 1 ||
      trustRecord.status !== 'approved' ||
      trustRecord.trust.stationId !== binding.stationId ||
      trustRecord.trust.enrollmentId !== binding.enrollmentId ||
      trustRecord.trust.generation !== binding.stationSigningGeneration ||
      (await stationConnectionSigningKeyId(trustRecord.trust)) !==
        binding.stationSigningKeyId
    )
      return false;
    return trustRecordsMatch(
      await trustStore.read(binding.stationId),
      trustRecord,
    );
  } catch {
    return false;
  }
}

/**
 * Explicitly redeem a one-use invitation after checking independent Station
 * trust. The resulting routing secret goes directly into browser custody and
 * is never returned to UI code, profile storage, a URL, or a log.
 */
export async function redeemBrokerRouteInvitation(input: {
  invitation: SelfHostedBrokerRouteInvitationV1;
  trustRecord: DeviceConnectionTrustRecord;
  trustStore: BrokerRouteTrustStore;
  custody: BrowserRoutingGrantCustody;
  request?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
}): Promise<void> {
  const now = input.now ?? Date.now;
  const browserOrigin = actualBrowserOrigin();
  const invitation = validateInvitation(input.invitation, browserOrigin, now());
  const { brokerOrigin, scope } = invitation;
  const trustRecord = copyTrustRecord(input.trustRecord);

  const binding = {
    stationId: scope.stationId,
    enrollmentId: scope.enrollmentId,
    stationSigningKeyId: invitation.stationSigningKeyId,
    stationSigningGeneration: invitation.stationSigningGeneration,
  };
  input.signal?.throwIfAborted();
  const operation = input.custody.beginEnrollment(brokerOrigin, scope);
  const request = (input.request ?? globalThis.fetch).bind(globalThis);
  const controller = new AbortController();
  const onParentAbort = () =>
    controller.abort(input.signal?.reason ?? new Error('cancelled'));
  const onOperationAbort = () =>
    controller.abort(
      operation.signal.reason ?? new Error('broker_grant_stale'),
    );
  input.signal?.addEventListener('abort', onParentAbort, { once: true });
  operation.signal.addEventListener('abort', onOperationAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error('browser_transport_timeout')),
    REQUEST_TIMEOUT_MS,
  );
  try {
    const operationSignal = controller.signal;
    input.custody.assertEnrollmentCurrent(operation, operationSignal);
    // This must finish before the one-use invitation is sent to the broker.
    const trustedBeforeRedeem = await readWithSignal(
      approvedTrustIsCurrent(trustRecord, input.trustStore, binding),
      operationSignal,
    );
    input.custody.assertEnrollmentCurrent(operation, operationSignal);
    if (!trustedBeforeRedeem) throw new Error('broker_route_trust_required');

    const response = await readWithSignal(
      request(`${brokerOrigin}/broker/v1/grants/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invitation }),
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: operationSignal,
      }),
      operationSignal,
    );
    input.custody.assertEnrollmentCurrent(operation, operationSignal);
    const payload = await boundedJson(response, operationSignal);
    input.custody.assertEnrollmentCurrent(operation, operationSignal);
    if (!response.ok)
      throw new Error(`broker_request_refused_${response.status}`);
    const grant = validateGrant(payload, browserOrigin, now());
    if (
      grant.brokerOrigin !== brokerOrigin ||
      !sameScope(grant.scope, scope) ||
      grant.stationSigningKeyId !== binding.stationSigningKeyId ||
      grant.stationSigningGeneration !== binding.stationSigningGeneration
    )
      throw new Error('broker_grant_binding_invalid');

    // A trust rotation/revocation or abort while redemption was outstanding
    // must be observed before the token can be installed or persisted.
    const trustedAfterRedeem = await readWithSignal(
      approvedTrustIsCurrent(trustRecord, input.trustStore, binding),
      operationSignal,
    );
    input.custody.assertEnrollmentCurrent(operation, operationSignal);
    if (!trustedAfterRedeem) throw new Error('broker_route_trust_retired');
    await input.custody.replace(grant, trustRecord, input.trustStore, {
      operation,
      signal: operationSignal,
    });
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', onParentAbort);
    operation.signal.removeEventListener('abort', onOperationAbort);
    input.custody.cancelEnrollment(operation);
  }
}
