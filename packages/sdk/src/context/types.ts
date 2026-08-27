/**
 * Message context provider interfaces.
 *
 * A MessageContextProvider contributes ambient context that is prepended to
 * outgoing messages (e.g. GPS coordinates, timezone, calendar state).
 *
 * Providers register themselves in contextRegistry on load. The
 * MessageContextContext React context subscribes to changes and composes
 * all enabled providers into a single context prefix.
 */

export interface ContextCapability {
  id: string;
  name: string;
  /** Which client types surface this option in Settings. */
  visibleOn: Array<'all' | 'mobile' | 'desktop'>;
}

export interface MessageContextProvider {
  readonly id: string;
  readonly name: string;
  /** Short description shown in Settings to explain what this provider does. */
  readonly description?: string;
  /** Whether the user has enabled this provider. */
  enabled: boolean;
  /**
   * Returns the context string to prepend to the next message, or null if
   * not available / disabled.
   */
  getContext(): string | null;
  /** useSyncExternalStore-compatible subscribe. Returns unsubscribe fn. */
  subscribe(fn: () => void): () => void;
}
