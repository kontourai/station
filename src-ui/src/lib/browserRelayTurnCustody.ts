import type { SavedConnection } from '@kontourai/station-connect';

const DATABASE = 'station-browser-relay-turn-custody-v1';
const STORE = 'turn-configurations';
const TURN_URL_MAX_LENGTH = 2048;
const USERNAME_MAX_LENGTH = 512;
const CREDENTIAL_MAX_LENGTH = 1024;

type BrowserRelayRoute = NonNullable<SavedConnection['brokerRoute']>;

export type BrowserRelayTurnConfigurationV1 = {
  schemaVersion: 1;
  url: string;
  username: string;
  credential: string;
};

export type BrowserRelayTurnIdentity = {
  applicationOrigin: string;
  browserOrigin: string;
  route: BrowserRelayRoute;
};

export interface BrowserRelayTurnStorage {
  read(key: string): Promise<unknown | null>;
  write(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

type StoredTurnConfigurationV1 = {
  schemaVersion: 1;
  identityKey: string;
  url: string;
  username: string;
  credential: string;
};

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function canonicalOrigin(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a canonical secure origin.`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(
    parsed.hostname.toLowerCase(),
  );
  if (
    parsed.origin !== value ||
    (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback))
  )
    throw new Error(`${label} must be a canonical secure origin.`);
  return parsed.origin;
}

function turnIdentityKey(identity: BrowserRelayTurnIdentity): string {
  const { brokerOrigin, scope } = identity.route;
  const applicationOrigin = canonicalOrigin(
    identity.applicationOrigin,
    'Station application address',
  );
  const browserOrigin = canonicalOrigin(
    identity.browserOrigin,
    'Browser origin',
  );
  if (scope.browserOrigin !== browserOrigin)
    throw new Error(
      'TURN configuration belongs to a different browser origin.',
    );
  const canonicalBrokerOrigin = canonicalOrigin(brokerOrigin, 'Broker address');
  return JSON.stringify([
    'station-browser-relay-turn-custody-v1',
    canonicalBrokerOrigin,
    scope.stationId,
    scope.enrollmentId,
    scope.routingGeneration,
    browserOrigin,
    applicationOrigin,
  ]);
}

function validateTurnUrl(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > TURN_URL_MAX_LENGTH ||
    value.trim() !== value ||
    hasControlCharacters(value)
  )
    throw new Error('Enter a valid TURN server URL.');
  const match = /^(turn|turns):([^?#]+)(?:\?transport=(udp|tcp|tls))?$/.exec(
    value,
  );
  if (!match) throw new Error('Use a turn: or turns: server URL.');
  const authority = match[2]!;
  if (/\s|@|%40/i.test(authority))
    throw new Error('TURN server URLs cannot include credentials or spaces.');
  let parsed: URL;
  try {
    parsed = new URL(`https://${authority}`);
  } catch {
    throw new Error('Enter a valid TURN server URL.');
  }
  if (
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  )
    throw new Error('Enter a TURN URL with a host and optional port.');
  const portMatch = /:\d+$/.exec(authority);
  if (portMatch) {
    const port = Number(portMatch[0].slice(1));
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('TURN server port must be between 1 and 65535.');
  }
  return value;
}

function validateCredential(value: unknown, label: string, maxLength: number) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value ||
    hasControlCharacters(value)
  )
    throw new Error(`Enter a valid TURN ${label.toLowerCase()}.`);
  return value;
}

export function parseBrowserRelayTurnConfiguration(
  value: unknown,
): BrowserRelayTurnConfigurationV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('TURN configuration must use version 1 fields.');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    record.schemaVersion !== 1 ||
    keys.join(',') !== 'credential,schemaVersion,url,username'
  )
    throw new Error('TURN configuration must use version 1 fields.');
  return {
    schemaVersion: 1,
    url: validateTurnUrl(record.url),
    username: validateCredential(
      record.username,
      'username',
      USERNAME_MAX_LENGTH,
    ),
    credential: validateCredential(
      record.credential,
      'credential',
      CREDENTIAL_MAX_LENGTH,
    ),
  };
}

function unavailable() {
  return new Error('Browser TURN credential storage is unavailable.');
}

function transaction<T>(
  mode: IDBTransactionMode,
  apply: (store: IDBObjectStore) => IDBRequest<T> | undefined,
): Promise<T | undefined> {
  if (!globalThis.isSecureContext || !globalThis.indexedDB)
    return Promise.reject(unavailable());
  return new Promise((resolve, reject) => {
    let open: IDBOpenDBRequest;
    try {
      open = indexedDB.open(DATABASE, 1);
    } catch {
      reject(unavailable());
      return;
    }
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE))
        open.result.createObjectStore(STORE);
    };
    open.onerror = open.onblocked = () => reject(unavailable());
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
        reject(unavailable());
        return;
      }
      if (mode === 'readwrite' && tx.durability !== 'strict') {
        tx.abort();
        db.close();
        reject(unavailable());
        return;
      }
      let result: T | undefined;
      tx.onerror = () => reject(unavailable());
      tx.onabort = () => {
        db.close();
        reject(unavailable());
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
            tx.abort();
            reject(unavailable());
          };
        }
      } catch {
        tx.abort();
        reject(unavailable());
      }
    };
  });
}

class IndexedDbBrowserRelayTurnStorage implements BrowserRelayTurnStorage {
  async read(key: string) {
    return (
      (await transaction<unknown>('readonly', (store) => store.get(key))) ??
      null
    );
  }

  async write(key: string, value: unknown) {
    await transaction('readwrite', (store) => store.put(value, key));
  }

  async delete(key: string) {
    await transaction('readwrite', (store) => store.delete(key));
  }
}

const indexedDbStorage = new IndexedDbBrowserRelayTurnStorage();

/** A separate, exact-route IndexedDB partition for operator-supplied TURN secrets. */
export class BrowserRelayTurnCustody {
  private readonly identityKey: string;

  constructor(
    identity: BrowserRelayTurnIdentity,
    private readonly storage: BrowserRelayTurnStorage = indexedDbStorage,
  ) {
    this.identityKey = turnIdentityKey(identity);
  }

  async save(value: unknown): Promise<void> {
    const configuration = parseBrowserRelayTurnConfiguration(value);
    const record: StoredTurnConfigurationV1 = {
      ...configuration,
      identityKey: this.identityKey,
    };
    await this.storage.write(this.identityKey, record);
  }

  async restore(): Promise<RTCIceServer | null> {
    const value = await this.storage.read(this.identityKey);
    if (value === null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw unavailable();
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (
      keys.join(',') !== 'credential,identityKey,schemaVersion,url,username' ||
      record.identityKey !== this.identityKey
    )
      throw unavailable();
    let configuration: BrowserRelayTurnConfigurationV1;
    try {
      configuration = parseBrowserRelayTurnConfiguration({
        schemaVersion: record.schemaVersion,
        url: record.url,
        username: record.username,
        credential: record.credential,
      });
    } catch {
      throw unavailable();
    }
    return {
      urls: configuration.url,
      username: configuration.username,
      credential: configuration.credential,
    };
  }

  async forget(): Promise<void> {
    await this.storage.delete(this.identityKey);
  }
}
