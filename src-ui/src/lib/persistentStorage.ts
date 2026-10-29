let request: Promise<boolean> | undefined;

/**
 * Asks the browser to keep this origin's storage under storage pressure (and,
 * in Safari, past its seven-day eviction of unused sites), once per page.
 *
 * Chromium and WebKit decide silently, but Firefox asks the person, so this
 * runs only where they chose to keep data on this device: enabling offline
 * reading, or a message left waiting in the outbox. A refusal or a missing
 * API changes nothing; the data stays best-effort as before.
 */
export function requestPersistentStorage(): Promise<boolean> {
  request ??= (async () => {
    try {
      const manager = globalThis.navigator?.storage;
      if (typeof manager?.persist !== 'function') return false;
      if (await manager.persisted?.()) return true;
      return await manager.persist();
    } catch {
      return false;
    }
  })();
  return request;
}

/** Test-only: forget this page's request so a test can make another. */
export function _resetPersistentStorageRequestForTests(): void {
  request = undefined;
}
