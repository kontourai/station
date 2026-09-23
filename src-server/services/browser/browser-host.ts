/**
 * Host-neutral browser seam for the Browser pane (#90, design brief D1).
 *
 * Phase 1 implements {@link BrowserHost} with a server-side Chromium
 * (`hosts/chromium-server-host.ts`); Phase 2 adds a desktop CEF host. Tools,
 * the automation broker, pane state and arbitration must depend only on these
 * interfaces and never branch on {@link BrowserHostKind}.
 *
 * The names and shapes below are the shared contract from the design brief.
 * Extend them by adding fields; do not rename.
 */

/** Raw Chrome DevTools Protocol channel. Page-level calls pass a CDP session id. */
export interface CdpTransport {
  send<R = unknown>(
    method: string,
    params?: object,
    sessionId?: string,
  ): Promise<R>;
  /**
   * Subscribe to a CDP event. Events from every attached session arrive here;
   * `sessionId` identifies which one (undefined for browser-level events).
   * Returns an unsubscribe function.
   */
  on(
    event: string,
    fn: (params: unknown, sessionId?: string) => void,
  ): () => void;
  close(): Promise<void>;
  /** Settles when the transport has closed for any reason. */
  readonly closed: Promise<void>;
}

export type BrowserHostKind = 'server-chromium' | 'desktop-cef';

export interface BrowserTarget {
  targetId: string;
  cdpSessionId: string;
}

export interface BrowserViewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

export interface BrowserHost {
  readonly kind: BrowserHostKind;
  openTarget(p: {
    profileDir: string;
    viewport: BrowserViewport;
  }): Promise<BrowserTarget>;
  /** Page-level calls pass `target.cdpSessionId`. */
  cdp(): CdpTransport;
  closeTarget(targetId: string): Promise<void>;
  /** Fires once when the host's browser process exits or its channel dies. */
  onExit(fn: (reason: string) => void): () => void;
  shutdown(): Promise<void>;
}
