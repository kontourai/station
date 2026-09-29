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

export const defaultStorage = new LocalStorageAdapter();
export const defaultCredentialStorage = new SessionStorageAdapter();
