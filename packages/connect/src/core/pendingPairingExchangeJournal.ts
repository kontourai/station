import type { PendingPairingExchange } from './devicePairing';

interface JournalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
interface Entry {
  pending: PendingPairingExchange;
  outcome: 'held' | 'completed' | 'retired';
}
export type ExchangeClaim = 'claimed' | 'held' | 'unavailable';

function journalKey(
  endpoint: string,
  kind: PendingPairingExchange['requestKind'],
) {
  return `station-pairing-exchange-journal:v1:${new URL(endpoint).origin}:${kind}`;
}
export function pairingExchangeIntentKey(
  pending: PendingPairingExchange,
): string {
  return JSON.stringify([
    new URL(pending.endpoint).origin,
    pending.requestKind,
    pending.requestId,
    pending.offerId,
    pending.proof,
    pending.expectedEnvironmentId,
    pending.browserSession,
    pending.clientInstanceId,
    pending.requiredAccountBinding?.issuer,
    pending.requiredAccountBinding?.subject,
    pending.requireAccountBinding,
    pending.targetConnectionId,
    pending.activateConnection,
    pending.preserveSelectedStation,
  ]);
}
function sameRequest(
  left: PendingPairingExchange,
  right: PendingPairingExchange,
) {
  return pairingExchangeIntentKey(left) === pairingExchangeIntentKey(right);
}

function read(
  endpoint: string,
  kind: PendingPairingExchange['requestKind'],
  storage: JournalStorage,
): Entry[] {
  const raw = storage.getItem(journalKey(endpoint, kind));
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length > 64)
    throw new Error('pairing_journal_invalid');
  return parsed.map((entry) => {
    const pending = entry?.pending;
    if (
      !pending ||
      typeof pending.endpoint !== 'string' ||
      new URL(pending.endpoint).origin !== new URL(endpoint).origin ||
      pending.requestKind !== kind ||
      typeof pending.requestId !== 'string' ||
      typeof pending.offerId !== 'string' ||
      typeof pending.proof !== 'string' ||
      !Number.isFinite(pending.expiresAt) ||
      typeof pending.browserSession !== 'boolean' ||
      !['held', 'completed', 'retired'].includes(entry.outcome)
    )
      throw new Error('pairing_journal_invalid');
    return entry;
  });
}
function write(
  endpoint: string,
  kind: PendingPairingExchange['requestKind'],
  entries: Entry[],
  storage: JournalStorage,
) {
  const encoded = JSON.stringify(entries);
  const key = journalKey(endpoint, kind);
  storage.setItem(key, encoded);
  if (storage.getItem(key) !== encoded)
    throw new Error('pairing_journal_not_saved');
}

/** Holds survive expiry and cannot be removed by an older pending-slot writer. */
export function heldPendingPairingExchange(
  endpoint: string,
  kind: PendingPairingExchange['requestKind'],
  storage?: JournalStorage,
): PendingPairingExchange | null {
  try {
    const selected = storage ?? globalThis.localStorage;
    if (!selected) return null;
    const held = read(endpoint, kind, selected).find(
      (entry) => entry.outcome === 'held',
    );
    return held ? { ...held.pending, exchangeAttempt: true } : null;
  } catch {
    return null;
  }
}

interface StoredJournal {
  key: string;
  entries: Entry[];
}
// This module is also imported by the DOM-free CLI. Describe only the browser
// capability used here instead of adding browser ambient globals to that build.
interface JournalRequest<T> {
  result: T;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}
interface JournalCursor {
  value: StoredJournal;
  continue(): void;
}
interface JournalTransaction {
  durability: string;
  objectStore(name: string): {
    get(key: string): JournalRequest<StoredJournal | undefined>;
    put(value: StoredJournal): unknown;
    openCursor(): JournalRequest<JournalCursor | null>;
  };
  abort(): void;
  onabort: (() => void) | null;
  onerror: (() => void) | null;
  oncomplete: (() => void) | null;
}
interface JournalDatabase {
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string, options: { keyPath: string }): unknown;
  transaction(
    name: string,
    mode: 'readonly' | 'readwrite',
    options?: { durability: 'strict' },
  ): JournalTransaction;
  close(): void;
}
interface JournalFactory {
  open(
    name: string,
    version: number,
  ): JournalRequest<JournalDatabase> & {
    onupgradeneeded: (() => void) | null;
    onblocked: (() => void) | null;
  };
}
function journalFactory(): JournalFactory | undefined {
  return (globalThis as { indexedDB?: JournalFactory }).indexedDB;
}

function transaction<T>(
  endpoint: string,
  kind: PendingPairingExchange['requestKind'],
  change: (entries: Entry[]) => { entries: Entry[]; result: T },
): Promise<T> {
  return new Promise((resolve, reject) => {
    const factory = journalFactory();
    if (!factory) {
      reject(new Error('pairing_journal_unavailable'));
      return;
    }
    const open = factory.open('station-pairing-exchange-journal', 1);
    let ended = false;
    let active: JournalTransaction | undefined;
    const fail = () => {
      if (!ended) {
        ended = true;
        try {
          active?.abort();
        } catch {}
        reject(new Error('pairing_journal_unavailable'));
      }
    };
    const timer = setTimeout(fail, 5000);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains('journals'))
        open.result.createObjectStore('journals', { keyPath: 'key' });
    };
    open.onerror = fail;
    open.onblocked = fail;
    open.onsuccess = () => {
      const database = open.result;
      if (ended) {
        database.close();
        return;
      }
      let tx: JournalTransaction;
      try {
        tx = database.transaction('journals', 'readwrite', {
          durability: 'strict',
        });
        if (tx.durability !== 'strict')
          throw new Error('strict_durability_unavailable');
      } catch {
        database.close();
        clearTimeout(timer);
        fail();
        return;
      }
      active = tx;
      const store = tx.objectStore('journals');
      const key = journalKey(endpoint, kind);
      const request = store.get(key);
      let result: T;
      let entries: Entry[];
      request.onsuccess = () => {
        try {
          const current = request.result as StoredJournal | undefined;
          const parsed = current
            ? read(endpoint, kind, {
                getItem: () => JSON.stringify(current.entries),
                setItem: () => undefined,
              })
            : [];
          const changed = change(parsed);
          entries = changed.entries;
          result = changed.result;
          store.put({ key, entries });
        } catch {
          tx.abort();
        }
      };
      tx.onabort = () => {
        clearTimeout(timer);
        active = undefined;
        database.close();
        fail();
      };
      tx.onerror = () => {
        clearTimeout(timer);
        active = undefined;
        database.close();
        fail();
      };
      tx.oncomplete = () => {
        clearTimeout(timer);
        active = undefined;
        database.close();
        if (ended) return;
        ended = true;
        // A best-effort presentation mirror. IndexedDB owns admission.
        try {
          write(endpoint, kind, entries, globalThis.localStorage);
        } catch {}
        resolve(result);
      };
    };
  });
}

/** The transaction commits before a caller may send, on HTTP and native origins alike. */
export async function claimPendingPairingExchange(
  pending: PendingPairingExchange,
  signal?: AbortSignal,
): Promise<ExchangeClaim> {
  try {
    return await transaction<ExchangeClaim>(
      pending.endpoint,
      pending.requestKind,
      (entries) => {
        if (signal?.aborted) return { entries, result: 'unavailable' };
        if (
          entries.some(
            (entry) =>
              entry.outcome === 'held' || sameRequest(entry.pending, pending),
          )
        )
          return { entries, result: 'held' };
        // Held attempts never expire locally. Terminal receipts outlive the
        // server's original offer expiry; changing a caller snapshot cannot
        // remove a still-live receipt. The server remains expiry authority.
        const retained = entries.filter(
          (entry) =>
            entry.outcome === 'held' || entry.pending.expiresAt > Date.now(),
        );
        if (retained.length >= 64) return { entries, result: 'unavailable' };
        retained.push({
          pending: { ...pending, exchangeAttempt: true },
          outcome: 'held',
        });
        return { entries: retained, result: 'claimed' };
      },
    );
  } catch {
    return 'unavailable';
  }
}

export async function settlePendingPairingExchange(
  pending: PendingPairingExchange,
  outcome: 'unconsumed' | 'completed' | 'retired',
): Promise<boolean> {
  try {
    return await transaction(
      pending.endpoint,
      pending.requestKind,
      (entries) => {
        const index = entries.findIndex((entry) =>
          sameRequest(entry.pending, pending),
        );
        if (index < 0) return { entries, result: false };
        if (outcome === 'unconsumed') entries.splice(index, 1);
        else entries[index] = { ...entries[index], outcome };
        return { entries, result: true };
      },
    );
  } catch {
    return false;
  }
}

export interface PairingExchangeRecovery {
  status: 'available' | 'unavailable' | 'corrupt';
  held: PendingPairingExchange[];
}

/** A failed inventory is distinct from a known empty journal. Admission still fails closed. */
export async function restoreHeldPairingExchanges(): Promise<PairingExchangeRecovery> {
  return new Promise((resolve) => {
    const held: PendingPairingExchange[] = [];
    let ended = false;
    let database: JournalDatabase | undefined;
    let active: JournalTransaction | undefined;
    const finish = (status: PairingExchangeRecovery['status']) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      if (status !== 'available') {
        try {
          active?.abort();
        } catch {}
      }
      database?.close();
      resolve({ status, held });
    };
    const timer = setTimeout(() => finish('unavailable'), 5000);
    try {
      const factory = journalFactory();
      if (!factory) {
        finish('unavailable');
        return;
      }
      const open = factory.open('station-pairing-exchange-journal', 1);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains('journals'))
          open.result.createObjectStore('journals', { keyPath: 'key' });
      };
      open.onerror = () => finish('unavailable');
      open.onblocked = () => finish('unavailable');
      open.onsuccess = () => {
        database = open.result;
        if (ended) {
          database.close();
          return;
        }
        try {
          const tx = database.transaction('journals', 'readonly');
          active = tx;
          const request = tx.objectStore('journals').openCursor();
          let records = 0;
          let corrupt = false;
          request.onerror = () => finish('unavailable');
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor || ended) return;
            // Bound work without mistaking a partial inventory for empty recovery.
            if (++records > 1024) {
              finish('unavailable');
              return;
            }
            try {
              const record = cursor.value as StoredJournal;
              const sample = record.entries[0]?.pending;
              if (sample) {
                if (
                  record.key !== journalKey(sample.endpoint, sample.requestKind)
                )
                  throw new Error('pairing_journal_invalid');
                const entries = read(sample.endpoint, sample.requestKind, {
                  getItem: () => JSON.stringify(record.entries),
                  setItem: () => undefined,
                });
                for (const entry of entries)
                  if (entry.outcome === 'held')
                    held.push({ ...entry.pending, exchangeAttempt: true });
              }
            } catch {
              corrupt = true;
            }
            cursor.continue();
          };
          tx.oncomplete = () => finish(corrupt ? 'corrupt' : 'available');
          tx.onabort = () => finish('unavailable');
          tx.onerror = () => finish('unavailable');
        } catch {
          finish('unavailable');
        }
      };
    } catch {
      finish('unavailable');
    }
  });
}
