/**
 * The browser lock boundary stays intentionally small so host tests can model
 * contention and owner loss without depending on a particular DOM runtime.
 */
export type WorkspacePaneHostPersistenceStatus =
  | 'owned'
  | 'contended'
  | 'unavailable';

export interface WorkspacePaneHostLockManager {
  request(
    name: string,
    options: {
      mode: 'exclusive';
      ifAvailable?: boolean;
      signal?: AbortSignal;
    },
    callback: (lock: object | null) => void | Promise<void>,
  ): Promise<void>;
}

interface NavigatorWithLocks {
  locks?: WorkspacePaneHostLockManager;
}

/**
 * Web Locks is the only production writer-election mechanism. Callers must
 * surface an unavailable result when it is absent rather than writing anyway.
 */
export function browserWorkspacePaneHostLockManager(): WorkspacePaneHostLockManager | null {
  const locks = (globalThis.navigator as NavigatorWithLocks | undefined)?.locks;
  return locks && typeof locks.request === 'function' ? locks : null;
}
