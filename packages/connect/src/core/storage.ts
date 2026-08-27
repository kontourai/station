import type { StorageAdapter } from './types';

export class LocalStorageAdapter implements StorageAdapter {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      // ignore quota errors
    }
  }

  remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
  }
}

/**
 * Conservative web credential vault: credentials survive reloads in the same
 * tab but are not serialized with connection profiles or persisted in ordinary
 * localStorage. Native clients can inject a keychain-backed adapter instead.
 */
export class SessionStorageAdapter implements StorageAdapter {
  get(key: string): string | null {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  }

  set(key: string, value: string): void {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      // Fail closed when secure session storage is unavailable.
    }
  }

  remove(key: string): void {
    try {
      sessionStorage.removeItem(key);
    } catch {
      // Nothing to clear when secure session storage is unavailable.
    }
  }
}

/** Native shells reject renderer-owned bearer persistence entirely. */
export class RejectingCredentialStorage implements StorageAdapter {
  get(_key: string): null {
    return null;
  }

  set(_key: string, _value: string): void {
    // Deliberate no-op: native authentication must go through the host broker.
  }

  remove(_key: string): void {
    // Nothing is retained by this adapter.
  }
}

/**
 * A credential store that reads synchronously from memory and persists
 * asynchronously through a host-provided backend.
 *
 * `StorageAdapter` is synchronous, and every native bridge is not, so a native
 * adapter cannot simply await inside `get`. Hydrating once at startup and
 * writing through afterwards keeps the sync contract without pretending the
 * underlying store is sync.
 *
 * Reads before `hydrate()` resolves return null, which reads as "no credential
 * saved" — so callers must hydrate before the first read or they will
 * incorrectly prompt to pair. `PlatformBootstrap` is where that happens.
 */
export interface CredentialVaultBackend {
  load(): Promise<Record<string, string>>;
  save(entries: Record<string, string>): Promise<void>;
}

export class HydratedCredentialStorage implements StorageAdapter {
  private entries: Record<string, string> = {};
  private hydrated = false;

  constructor(private readonly backend: CredentialVaultBackend) {}

  async hydrate(): Promise<void> {
    // Do not clear a usable credential snapshot until the replacement has
    // arrived. A transient keyring failure must remain observable to callers:
    // presenting an empty vault turns an unavailable OS service into an
    // unnecessary re-pair, and a resolved promise prevents the caller from
    // retrying the read.
    const entries = await this.backend.load();
    this.entries = entries;
    this.hydrated = true;
  }

  get isHydrated(): boolean {
    return this.hydrated;
  }

  get(key: string): string | null {
    return this.entries[key] ?? null;
  }

  set(key: string, value: string): void {
    this.entries[key] = value;
    void this.flush();
  }

  remove(key: string): void {
    delete this.entries[key];
    void this.flush();
  }

  private async flush(): Promise<void> {
    try {
      await this.backend.save({ ...this.entries });
    } catch {
      // Keep the in-memory value so the current session still works; the next
      // write retries. Losing the session too would turn a failed disk write
      // into an immediate re-pair.
    }
  }
}

export const defaultStorage = new LocalStorageAdapter();
export const defaultCredentialStorage = new SessionStorageAdapter();
