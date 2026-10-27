/**
 * One transaction against a single-store IndexedDB database that refuses to
 * write unless the browser promises a strict (flushed) commit.
 *
 * Credential custody (the browser relay authority and TURN credentials, and
 * Connect's broker routing grants) each carried this open-upgrade-transact
 * sequence verbatim. The rules that matter are the same for all of them: no
 * storage outside a secure context, a `readwrite` that the browser would only
 * relax-commit is refused rather than trusted, a version change closes the
 * handle, and each caller keeps its own error so its fail-closed callers see
 * the codes they already handle.
 */

export interface StrictIndexedDbStore {
  readonly database: string;
  readonly store: string;
  /** The rejection when storage cannot open or cannot promise a strict commit. */
  unavailable(): Error;
  /** The rejection when a started transaction fails; defaults to `unavailable`. */
  failed?(): Error;
}

export interface StrictIndexedDbWork<R> {
  /** A request whose `error` event fails the transaction. */
  readonly request?: EventTarget | null;
  /** Read after the transaction commits. */
  result(): R;
}

/**
 * Runs `configure` in one transaction and resolves with its result once the
 * transaction commits. An aborted `signal` rejects with its reason; the
 * caller checks it before calling if it needs a different first rejection.
 */
export function strictIndexedDbTransaction<R>(
  target: StrictIndexedDbStore,
  mode: IDBTransactionMode,
  configure: (store: IDBObjectStore) => StrictIndexedDbWork<R>,
  signal?: AbortSignal,
): Promise<R> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (!globalThis.isSecureContext || !globalThis.indexedDB)
    return Promise.reject(target.unavailable());
  const failure = () => (target.failed ?? target.unavailable)();
  return new Promise((resolve, reject) => {
    let open: IDBOpenDBRequest;
    try {
      open = globalThis.indexedDB.open(target.database, 1);
    } catch {
      reject(target.unavailable());
      return;
    }
    const abortOpen = () => reject(signal?.reason);
    signal?.addEventListener('abort', abortOpen, { once: true });
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(target.store))
        open.result.createObjectStore(target.store);
    };
    open.onerror = open.onblocked = () => {
      signal?.removeEventListener('abort', abortOpen);
      reject(signal?.aborted ? signal.reason : target.unavailable());
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
          target.store,
          mode,
          mode === 'readwrite' ? { durability: 'strict' } : undefined,
        );
      } catch {
        db.close();
        reject(target.unavailable());
        return;
      }
      if (mode === 'readwrite' && tx.durability !== 'strict') {
        tx.abort();
        db.close();
        reject(target.unavailable());
        return;
      }
      let work: StrictIndexedDbWork<R>;
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
        if (!failed) reject(signal?.aborted ? signal.reason : failure());
        failed = true;
      };
      tx.onabort = () => {
        signal?.removeEventListener('abort', abortTransaction);
        db.close();
        if (!failed) reject(failure());
        failed = true;
      };
      tx.oncomplete = () => {
        signal?.removeEventListener('abort', abortTransaction);
        db.close();
        resolve(work.result());
      };
      try {
        work = configure(tx.objectStore(target.store));
        work.request?.addEventListener('error', () => {
          failed = true;
          reject(failure());
          tx.abort();
        });
      } catch {
        failed = true;
        reject(failure());
        tx.abort();
      }
    };
  });
}

/** One request in one transaction; resolves with its result after commit. */
export function strictIndexedDbRequest<T>(
  target: StrictIndexedDbStore,
  mode: IDBTransactionMode,
  apply: (store: IDBObjectStore) => IDBRequest<T> | undefined,
  signal?: AbortSignal,
): Promise<T | undefined> {
  return strictIndexedDbTransaction(
    target,
    mode,
    (store) => {
      const request = apply(store);
      let result: T | undefined;
      request?.addEventListener('success', () => {
        result = request.result;
      });
      return { request, result: () => result };
    },
    signal,
  );
}
