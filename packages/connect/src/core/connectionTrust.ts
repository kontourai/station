import type {
  ApprovedStationConnectionTrust,
  DeviceConnectionTrustRecord,
} from '@kontourai/station-contracts/connection-proof';
import {
  copyStationConnectionTrust,
  stationConnectionSigningKeyId,
} from '@kontourai/station-shared/connection-proof';

const DATABASE = 'station-device-connection-trust-v1';
const STORE = 'stations';
const MAX_STATIONS = 256;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class DeviceTrustError extends Error {
  constructor(
    readonly code:
      | 'device_trust_unavailable'
      | 'device_trust_invalid'
      | 'device_trust_conflict',
  ) {
    super(code);
  }
}

function validStation(stationId: string) {
  if (typeof stationId !== 'string' || !UUID.test(stationId))
    throw new DeviceTrustError('device_trust_invalid');
}

function readRecord(
  value: unknown,
  stationId: string,
): DeviceConnectionTrustRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new DeviceTrustError('device_trust_invalid');
  const record = value as DeviceConnectionTrustRecord;
  if (
    Object.keys(record).sort().join(',') !==
      'revision,schemaVersion,status,trust' ||
    record.schemaVersion !== 1 ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 1 ||
    (record.status !== 'approved' && record.status !== 'revoked')
  )
    throw new DeviceTrustError('device_trust_invalid');
  let trust: ApprovedStationConnectionTrust;
  try {
    trust = copyStationConnectionTrust(record.trust);
  } catch {
    throw new DeviceTrustError('device_trust_invalid');
  }
  if (trust.stationId !== stationId)
    throw new DeviceTrustError('device_trust_invalid');
  return Object.freeze({
    schemaVersion: 1,
    revision: record.revision,
    status: record.status,
    trust,
  });
}

function openDatabase(): Promise<IDBDatabase> {
  let factory: IDBFactory;
  try {
    if (!globalThis.isSecureContext || !globalThis.indexedDB) throw new Error();
    factory = globalThis.indexedDB;
  } catch {
    return Promise.reject(new DeviceTrustError('device_trust_unavailable'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = () => {
      settled = true;
      clearTimeout(timer);
      reject(new DeviceTrustError('device_trust_unavailable'));
    };
    const timer = setTimeout(fail, 5000);
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DATABASE, 1);
    } catch {
      fail();
      return;
    }
    request.onblocked = fail;
    request.onerror = fail;
    request.onupgradeneeded = () => {
      if (settled) {
        request.transaction?.abort();
        return;
      }
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      resolve(request.result);
    };
  });
}

/**
 * Public trust only, scoped to this browser origin/storage partition. The
 * trusted caller owns the independent operator approval ceremony. Broker
 * discovery, account login and a printed descriptor cannot call it by proxy.
 */
export async function openDeviceConnectionTrustStore() {
  const database = await openDatabase();
  let closed = false;
  const close = () => {
    closed = true;
    database.close();
  };
  database.onversionchange = close;

  function transact(
    stationId: string,
    transform?: (
      current: DeviceConnectionTrustRecord | null,
    ) => DeviceConnectionTrustRecord,
  ): Promise<DeviceConnectionTrustRecord | null> {
    validStation(stationId);
    if (closed)
      return Promise.reject(new DeviceTrustError('device_trust_unavailable'));
    return new Promise((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(
          STORE,
          transform ? 'readwrite' : 'readonly',
          transform ? { durability: 'strict' } : undefined,
        );
      } catch {
        reject(new DeviceTrustError('device_trust_unavailable'));
        return;
      }
      if (transform && transaction.durability !== 'strict') {
        transaction.abort();
        reject(new DeviceTrustError('device_trust_unavailable'));
        return;
      }
      let result: DeviceConnectionTrustRecord | null = null;
      let failure: DeviceTrustError | undefined;
      const abort = (error: unknown) => {
        failure =
          error instanceof DeviceTrustError
            ? error
            : new DeviceTrustError('device_trust_unavailable');
        transaction.abort();
      };
      transaction.onabort = () =>
        reject(failure ?? new DeviceTrustError('device_trust_unavailable'));
      transaction.oncomplete = () => resolve(result);
      const store = transaction.objectStore(STORE);
      // get() conflates an absent row with a corrupt stored undefined value.
      const request = store.openCursor(stationId);
      request.onsuccess = () => {
        try {
          const current = request.result
            ? readRecord(request.result.value, stationId)
            : null;
          result = transform ? transform(current) : current;
          if (!transform) return;
          const put = () => {
            store.put(result, stationId);
          };
          if (current) put();
          else {
            const count = store.count();
            count.onsuccess = () => {
              try {
                if (count.result >= MAX_STATIONS)
                  throw new DeviceTrustError('device_trust_unavailable');
                put();
              } catch (error) {
                abort(error);
              }
            };
          }
        } catch (error) {
          abort(error);
        }
      };
    });
  }

  function requireRevision(
    current: DeviceConnectionTrustRecord | null,
    expected: number | null,
  ) {
    if (expected !== null && (!Number.isSafeInteger(expected) || expected < 1))
      throw new DeviceTrustError('device_trust_conflict');
    if (
      (current?.revision ?? null) !== expected ||
      current?.revision === Number.MAX_SAFE_INTEGER
    )
      throw new DeviceTrustError('device_trust_conflict');
  }

  return Object.freeze({
    close,
    read: (stationId: string) => transact(stationId),
    /** The supplied key ID must come from independently authenticated approval. */
    approve: async (
      input: ApprovedStationConnectionTrust,
      expectedRevision: number | null,
      approvedKeyId: string,
    ) => {
      const trust = copyStationConnectionTrust(input);
      if (
        typeof approvedKeyId !== 'string' ||
        (await stationConnectionSigningKeyId(trust)) !== approvedKeyId
      )
        throw new DeviceTrustError('device_trust_conflict');
      return transact(trust.stationId, (current) => {
        requireRevision(current, expectedRevision);
        if (current) {
          if (current.trust.enrollmentId !== trust.enrollmentId)
            throw new DeviceTrustError('device_trust_conflict');
          const sameKey =
            current.trust.signingKey.x === trust.signingKey.x &&
            current.trust.signingKey.y === trust.signingKey.y;
          if (
            sameKey &&
            trust.generation === current.trust.generation &&
            current.status === 'approved'
          )
            return current;
          if (sameKey || trust.generation <= current.trust.generation)
            throw new DeviceTrustError('device_trust_conflict');
        }
        return {
          schemaVersion: 1,
          revision: (current?.revision ?? 0) + 1,
          status: 'approved',
          trust,
        };
      });
    },
    revoke: (stationId: string, expectedRevision: number) =>
      transact(stationId, (current) => {
        requireRevision(current, expectedRevision);
        if (!current) throw new DeviceTrustError('device_trust_conflict');
        return current.status === 'revoked'
          ? current
          : { ...current, revision: current.revision + 1, status: 'revoked' };
      }),
    /** Recheck after asynchronous crypto, before accepting a peer description. */
    isCurrent: async (snapshot: DeviceConnectionTrustRecord) => {
      const stationId = snapshot?.trust?.stationId;
      validStation(stationId);
      const expected = readRecord(snapshot, stationId);
      const current = await transact(stationId);
      return (
        expected.status === 'approved' &&
        current?.status === 'approved' &&
        current.revision === expected.revision &&
        JSON.stringify(current.trust) === JSON.stringify(expected.trust)
      );
    },
  });
}
