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
  /**
   * Emulate a mobile device (meta viewport, touch). Absent means desktop.
   * Added by the Browser pane lane for device presets.
   */
  mobile?: boolean;
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

/**
 * Which Station runs a browser (#90 D13). Always `local` today; a later
 * epic adds peer Stations. Persisted on every session record.
 */
export const LOCAL_BROWSER_HOST_ID = 'local';

/** What a host is resolved for: the profile it will run (never its reach). */
export interface BrowserHostRequest {
  /** Canonical Project ID. */
  projectId: string;
  /** `operator` or `principal:<id>` (D7). */
  principalKey: string;
  hostId: string;
}

/**
 * The ONE path from a profile to a browser host (#90 D13). The session
 * registry never constructs a host itself; a peer implementation later
 * plugs in here without the tools, routes or pane changing.
 */
export interface BrowserHostResolver {
  resolve(request: BrowserHostRequest): BrowserHost | Promise<BrowserHost>;
}

/** The only implementation today: hosts on this Station. */
export function createLocalBrowserHostResolver(
  create: (request: BrowserHostRequest) => BrowserHost | Promise<BrowserHost>,
): BrowserHostResolver {
  return {
    resolve(request) {
      if (request.hostId !== LOCAL_BROWSER_HOST_ID)
        throw new Error(
          `browser host ${JSON.stringify(request.hostId)} is not available on this Station`,
        );
      return create(request);
    },
  };
}
