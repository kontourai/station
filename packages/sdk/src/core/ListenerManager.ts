/**
 * ListenerManager — minimal base for the useSyncExternalStore subscribe pattern.
 *
 * Exposes `subscribe` as a public bound class field so subclasses satisfy the
 * STTProvider / TTSProvider / MessageContextProvider interface without
 * repeating `subscribe = this._subscribe.bind(this)`.
 *
 * Subclasses call `this._notify()` to push updates to all subscribers.
 * Call `this._clearListeners()` in a destroy() method to prevent leaks.
 */
export class ListenerManager {
  private _listeners = new Set<() => void>();

  /** useSyncExternalStore-compatible subscribe. Returns unsubscribe function. */
  readonly subscribe = (fn: () => void): (() => void) => {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  };

  protected _notify(): void {
    this._listeners.forEach((fn) => fn());
  }

  protected _clearListeners(): void {
    this._listeners.clear();
  }
}

/**
 * No-op subscribe for useSyncExternalStore when there is no active provider.
 * Shared across hooks to avoid creating new function references per render.
 */
export const noopSubscribe =
  (_fn: () => void): (() => void) =>
  () => {};
