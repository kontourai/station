/**
 * Phase 1 {@link BrowserHost}: a headless Chromium on the Station host,
 * driven over raw CDP on `--remote-debugging-pipe` (#90, D1/D3).
 *
 * One instance owns ONE browser process for ONE profile directory, for that
 * process's whole life. It is single-use: after the process exits (crash,
 * kill, shutdown) every call fails with {@link BrowserHostExitedError} and the
 * owner starts a new host, which is what lets the session registry bump a
 * generation instead of pretending the old targets survived.
 *
 * Enforcement installed before any target exists, and fail-closed — if any
 * mandatory step is refused the launch is torn down:
 *
 * - No Station listener on this host is reachable. Every connection goes
 *   through a Station-owned egress proxy that decides on the RESOLVED
 *   address and port (`browser-egress-proxy.ts`, `station-listeners.ts`);
 *   loopback is proxied too (`<-loopback>`), QUIC is off and WebRTC may not
 *   use unproxied UDP. CDP `Fetch` failing Station-bound HTTP URLs is a
 *   second, URL-level layer.
 * - Document requests to a URL outside the D2 scope are failed at the network
 *   layer (this catches `file:` — CDP Fetch does see file: documents). Schemes
 *   the network layer never sees (`data:`, `chrome:`, `view-source:`) cannot
 *   be reached renderer-initiated (Chromium refuses those itself) and are
 *   refused browser-initiated by the guarded {@link BrowserHost.cdp} channel.
 *   A committed main-frame URL outside scope is navigated away as the last
 *   line.
 * - Downloads are denied (`Browser.setDownloadBehavior`). Headless Chrome's
 *   default otherwise writes into the user's real Downloads folder.
 * - Popups load in their opener's tab and the popup target is closed (t3code
 *   behaviour, `apps/desktop/src/preview/Manager.ts`, MIT © 2026 T3 Tools Inc.).
 * - Permissions are denied.
 */
import { mkdirSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import {
  spawnOwnedChild,
  terminateProcessTree,
} from '../../infra/process-utils.js';
import {
  BrowserEgressProxy,
  type EgressDecisionEvent,
  type EgressLookup,
} from '../browser-egress-proxy.js';
import type {
  BrowserHost,
  BrowserHostKind,
  BrowserTarget,
  BrowserViewport,
  CdpTransport,
} from '../browser-host.js';
import { CdpPipeTransport } from '../cdp-pipe-transport.js';
import type { EgressPolicy } from '../egress-policy.js';
import {
  isStationSelfUrl,
  type StationListeners,
  stationSelfFetchPatterns,
} from '../station-listeners.js';
import { ABOUT_BLANK, isAllowedBrowserUrl } from '../url-policy.js';

/** Chromium's own network-error page. It cannot be navigated to directly. */
const CHROME_ERROR_PAGE = 'chrome-error://chromewebdata/';

/**
 * The ONLY methods the public {@link BrowserHost.cdp} channel forwards, and
 * only on a page session this host opened (review B2/M1). Everything else —
 * every `Browser.*` and `Target.*` method, `Fetch.*`, storage and download
 * controls, and `DOM.setFileInputFiles` — stays host-owned, because
 * `Target.attachToTarget{flatten:false}` + `Target.sendMessageToTarget` or
 * `Target.attachToBrowserTarget` would tunnel ANY method past a deny-list.
 * Adding an entry requires updating the pinning test.
 */
export const PAGE_SESSION_CDP_ALLOWLIST: readonly string[] = Object.freeze([
  // Navigation. Page.navigate is URL-checked below; navigateToHistoryEntry is
  // checked against the entry's URL. Reload and stop keep the current URL.
  'Page.navigate',
  'Page.reload',
  'Page.stopLoading',
  'Page.getNavigationHistory',
  'Page.navigateToHistoryEntry',
  // Observation: frames the pane streams and the agent inspects.
  'Page.enable',
  'Page.getFrameTree',
  'Page.getLayoutMetrics',
  'Page.captureScreenshot',
  'Page.startScreencast',
  'Page.stopScreencast',
  'Page.screencastFrameAck',
  // Input the human or agent sends into the page (the lease decides who).
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.dispatchTouchEvent',
  'Input.insertText',
  'Input.imeSetComposition',
  // Page-realm script: locators and element handles run here. It has the
  // page's own authority only (same as the page's JS); D4 gates the tool.
  'Runtime.enable',
  'Runtime.evaluate',
  'Runtime.callFunctionOn',
  'Runtime.getProperties',
  'Runtime.releaseObject',
  'Runtime.releaseObjectGroup',
  'Runtime.awaitPromise',
  // DOM reads (and focus, which a click also does). Never setFileInputFiles:
  // it reads host files into the page.
  'DOM.enable',
  'DOM.getDocument',
  'DOM.querySelector',
  'DOM.querySelectorAll',
  'DOM.describeNode',
  'DOM.resolveNode',
  'DOM.requestNode',
  'DOM.getBoxModel',
  'DOM.getContentQuads',
  'DOM.getOuterHTML',
  'DOM.getAttributes',
  'DOM.getNodeForLocation',
  'DOM.scrollIntoViewIfNeeded',
  'DOM.focus',
  // Accessibility tree reads for snapshots.
  'Accessibility.enable',
  'Accessibility.disable',
  'Accessibility.getFullAXTree',
  'Accessibility.getPartialAXTree',
  'Accessibility.queryAXTree',
  'Accessibility.getRootAXNode',
  'Accessibility.getChildAXNodes',
  // Viewport and media emulation for the pane's size and responsive checks.
  'Emulation.setDeviceMetricsOverride',
  'Emulation.clearDeviceMetricsOverride',
  'Emulation.setEmulatedMedia',
  'Emulation.setTouchEmulationEnabled',
  // Diagnostics event streams (console, network log); no interception.
  'Network.enable',
  'Log.enable',
]);
const PAGE_SESSION_CDP_ALLOWED = new Set(PAGE_SESSION_CDP_ALLOWLIST);

/** Permission names denied at launch. The first five are mandatory. */
export const MANDATORY_DENIED_PERMISSIONS = [
  'geolocation',
  'notifications',
  'camera',
  'microphone',
  'clipboard-read',
] as const;
export const BEST_EFFORT_DENIED_PERMISSIONS = [
  'midi',
  'background-sync',
  'persistent-storage',
  'screen-wake-lock',
  'display-capture',
  'idle-detection',
  'local-fonts',
  'window-management',
  'payment-handler',
  'nfc',
  'storage-access',
] as const;

const POPUP_URL_GRACE_MS = 3_000;

export class BrowserHostExitedError extends Error {
  constructor(readonly reason: string) {
    super(`The browser host is no longer running (${reason}).`);
    this.name = 'BrowserHostExitedError';
  }
}

export class BrowserHostPolicyError extends Error {
  constructor(
    readonly method: string,
    readonly code:
      | 'host-owned-method'
      | 'url-not-allowed'
      | 'profile-mismatch'
      | 'foreign-session',
  ) {
    super(
      code === 'url-not-allowed'
        ? `${method} was refused: the URL is outside the Browser pane's scope.`
        : code === 'profile-mismatch'
          ? 'This browser host already runs a different profile directory.'
          : code === 'foreign-session'
            ? `${method} was refused: only page sessions this host opened are reachable.`
            : `${method} is reserved to the browser host.`,
    );
    this.name = 'BrowserHostPolicyError';
  }
}

export interface ChromiumLaunch {
  readonly transport: CdpTransport;
  readonly pid: number | undefined;
  /** Resolves with a human-readable reason once the process has exited. */
  readonly exited: Promise<string>;
  /** Kill the process tree and forget its orphan-registry record. */
  terminate(): Promise<void>;
}

export type ChromiumLauncher = (request: {
  executablePath: string;
  args: readonly string[];
}) => ChromiumLaunch;

export interface ChromiumServerHostOptions {
  executablePath: string;
  /**
   * The profile's egress policy (Station listeners plus the actor's reach,
   * D7), re-read for every connection. Required so no caller can forget it.
   */
  egressPolicy: EgressPolicy;
  /** Egress-proxy seam (tests): hostname resolution. */
  egress?: { lookup?: EgressLookup };
  launcher?: ChromiumLauncher;
  launchTimeoutMs?: number;
  /** Diagnostics sink for non-fatal enforcement events. */
  onEvent?: (event: ChromiumHostEvent) => void;
}

export type ChromiumHostEvent =
  | { kind: 'request-blocked'; reason: PausedRequestBlock; url: string }
  | { kind: 'popup-folded'; openerTargetId: string; url: string | undefined }
  | {
      kind: 'committed-url-refused';
      targetId: string;
      url: string;
      frame: 'main' | 'subframe';
    }
  | { kind: 'untracked-target-closed'; targetId: string; url: string }
  | { kind: 'permission-deny-skipped'; permission: string; error: string }
  | ({ kind: 'egress-refused' } & EgressDecisionEvent);

export type PausedRequestBlock = 'station-self' | 'disallowed-url' | 'popup';

export type PausedRequestDecision =
  | { action: 'continue' }
  | { action: 'fail'; reason: PausedRequestBlock };

/** Pure: what to do with one request CDP Fetch paused. */
export function decidePausedRequest(
  request: { url: string; resourceType: string; frameId?: string },
  context: {
    stationListeners: StationListeners;
    interfaceAddresses?: readonly string[];
    popupFrameIds: ReadonlySet<string>;
  },
): PausedRequestDecision {
  if (
    isStationSelfUrl(
      request.url,
      context.stationListeners,
      context.interfaceAddresses,
    )
  )
    return { action: 'fail', reason: 'station-self' };
  if (request.resourceType !== 'Document') return { action: 'continue' };
  if (
    request.frameId !== undefined &&
    context.popupFrameIds.has(request.frameId)
  )
    return { action: 'fail', reason: 'popup' };
  if (!isAllowedBrowserUrl(request.url))
    return { action: 'fail', reason: 'disallowed-url' };
  return { action: 'continue' };
}

/** A main-frame URL that may stay committed. */
export function isAllowedCommittedUrl(url: string): boolean {
  return url === CHROME_ERROR_PAGE || isAllowedBrowserUrl(url);
}

/**
 * A subframe URL that may stay committed (review S3): the main-frame scope
 * plus `about:srcdoc` (an inline iframe). `data:`, `blob:`, `filesystem:` and
 * every other scheme are replaced with about:blank.
 */
export function isAllowedSubframeUrl(url: string): boolean {
  return url === 'about:srcdoc' || isAllowedCommittedUrl(url);
}

/** Pure launch argument list. */
export function buildChromiumArgs(input: {
  profileDir: string;
  /** The egress proxy (`http://127.0.0.1:<port>`); required. */
  proxyServer: string;
}): string[] {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(input.proxyServer)) {
    throw new Error(
      'Refusing to launch Chromium without its loopback egress proxy.',
    );
  }
  return [
    '--headless=new',
    '--remote-debugging-pipe',
    `--user-data-dir=${input.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-component-extensions-with-background-pages',
    '--disable-sync',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--mute-audio',
    // Never touch the user's real keychain / keyring from a headless profile.
    '--password-store=basic',
    '--use-mock-keychain',
    // Every connection, loopback included, goes through the egress proxy.
    `--proxy-server=${input.proxyServer}`,
    '--proxy-bypass-list=<-loopback>',
    // QUIC and non-proxied WebRTC UDP would sidestep an HTTP proxy.
    '--disable-quic',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    // No launch tab: every page target is one this host created.
    '--no-startup-window',
  ];
}

const CHROMIUM_ENV_ALLOWLIST =
  /^(HOME|USER|LOGNAME|PATH|TMPDIR|TEMP|TMP|LANG|LANGUAGE|TZ|LC_[A-Z]+|DISPLAY|WAYLAND_DISPLAY|XDG_[A-Z_]+|DBUS_SESSION_BUS_ADDRESS|FONTCONFIG_[A-Z_]+|SystemRoot|SYSTEMROOT|windir|WINDIR|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|PROGRAMDATA|ProgramFiles|PROGRAMFILES|ProgramFiles\(x86\)|PROGRAMFILES\(X86\)|CommonProgramFiles|COMSPEC|ComSpec|PATHEXT|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/;

/**
 * The browser gets a minimal environment: it renders untrusted pages and has
 * no business holding Station's provider keys or tokens.
 */
export function chromiumEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && CHROMIUM_ENV_ALLOWLIST.test(key))
      out[key] = value;
  }
  return out;
}

const STDERR_TAIL_BYTES = 4096;

/** Production launcher: an owned, orphan-registered child with a CDP pipe. */
export const launchChromiumProcess: ChromiumLauncher = ({
  executablePath,
  args,
}) => {
  const { proc, release } = spawnOwnedChild(executablePath, [...args], {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    env: chromiumEnvironment(process.env),
  });
  let stderrTail = '';
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(
      -STDERR_TAIL_BYTES,
    );
  });
  proc.stderr?.on('error', () => {});
  const transport = new CdpPipeTransport(
    proc.stdio[3] as Writable,
    proc.stdio[4] as Readable,
  );
  const exited = new Promise<string>((resolve) => {
    proc.once('exit', (code, signal) => {
      const tail = stderrTail.trim().split('\n').slice(-3).join(' | ');
      resolve(
        `browser process exited (code ${code ?? 'none'}, signal ${signal ?? 'none'})${tail ? `: ${tail}` : ''}`,
      );
    });
    proc.once('error', (error) =>
      resolve(`browser process failed to start: ${error.message}`),
    );
  });
  void exited.then(() => {
    release();
    void transport.close();
  });
  return {
    transport,
    pid: proc.pid,
    exited,
    async terminate() {
      try {
        await terminateProcessTree(proc, { processGroup: true });
      } finally {
        release();
      }
    },
  };
};

interface TargetState {
  sessionId: string;
  unsubscribe: () => void;
}

interface Running {
  profileDir: string;
  launch: ChromiumLaunch;
  proxy: BrowserEgressProxy;
  targets: Map<string, TargetState>;
  popups: Map<
    string,
    { openerTargetId: string; folded: boolean; timer?: NodeJS.Timeout }
  >;
  unsubscribe: Array<() => void>;
  /** Target.createTarget calls in flight (their targets are not yet known). */
  creating: number;
  /** Page targets awaiting the untracked-target check. */
  pendingUntracked: Map<string, NodeJS.Timeout>;
}

/** Grace before an unknown page target (not ours, not a popup) is closed. */
const UNTRACKED_TARGET_GRACE_MS = 1_000;

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${what} timed out after ${ms}ms`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

export class ChromiumServerHost implements BrowserHost {
  readonly kind: BrowserHostKind = 'server-chromium';
  private running: Running | undefined;
  private starting: Promise<Running> | undefined;
  private exitReason: string | undefined;
  private shuttingDown = false;
  private readonly exitListeners = new Set<(reason: string) => void>();
  private readonly launcher: ChromiumLauncher;
  private readonly guarded: CdpTransport;

  constructor(private readonly options: ChromiumServerHostOptions) {
    this.launcher = options.launcher ?? launchChromiumProcess;
    this.guarded = this.createGuardedTransport();
  }

  /** The browser process id while running (diagnostics and tests). */
  get pid(): number | undefined {
    return this.running?.launch.pid;
  }

  get exited(): string | undefined {
    return this.exitReason;
  }

  async openTarget(p: {
    profileDir: string;
    viewport: BrowserViewport;
  }): Promise<BrowserTarget> {
    const running = await this.ensureRunning(p.profileDir);
    const transport = running.launch.transport;
    running.creating += 1;
    let targetId: string;
    try {
      ({ targetId } = await transport.send<{ targetId: string }>(
        'Target.createTarget',
        { url: ABOUT_BLANK },
      ));
    } finally {
      running.creating -= 1;
    }
    try {
      const { sessionId } = await transport.send<{ sessionId: string }>(
        'Target.attachToTarget',
        { targetId, flatten: true },
      );
      const unsubscribe = this.watchCommittedUrls(running, targetId, sessionId);
      running.targets.set(targetId, { sessionId, unsubscribe });
      const pending = running.pendingUntracked.get(targetId);
      if (pending) clearTimeout(pending);
      running.pendingUntracked.delete(targetId);
      await transport.send('Page.enable', {}, sessionId);
      await transport.send(
        'Emulation.setDeviceMetricsOverride',
        {
          width: p.viewport.width,
          height: p.viewport.height,
          deviceScaleFactor: p.viewport.deviceScaleFactor,
          mobile: false,
        },
        sessionId,
      );
      return { targetId, cdpSessionId: sessionId };
    } catch (error) {
      await this.closeTarget(targetId).catch(() => {});
      throw error;
    }
  }

  cdp(): CdpTransport {
    return this.guarded;
  }

  async closeTarget(targetId: string): Promise<void> {
    const running = this.requireRunning();
    const target = running.targets.get(targetId);
    target?.unsubscribe();
    running.targets.delete(targetId);
    await running.launch.transport.send('Target.closeTarget', { targetId });
  }

  onExit(fn: (reason: string) => void): () => void {
    if (this.exitReason !== undefined) {
      const reason = this.exitReason;
      queueMicrotask(() => fn(reason));
      return () => {};
    }
    this.exitListeners.add(fn);
    return () => {
      this.exitListeners.delete(fn);
    };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const starting = this.starting;
    if (starting) await starting.catch(() => {});
    const running = this.running;
    if (!running) {
      this.markExited('shutdown');
      return;
    }
    await withTimeout(
      running.launch.transport.send('Browser.close'),
      2_000,
      'Browser.close',
    ).catch(() => {});
    await running.launch.terminate();
    await running.proxy.close();
    this.markExited('shutdown');
  }

  private requireRunning(): Running {
    if (this.exitReason !== undefined)
      throw new BrowserHostExitedError(this.exitReason);
    if (!this.running) throw new BrowserHostExitedError('not started');
    return this.running;
  }

  private async ensureRunning(profileDir: string): Promise<Running> {
    if (this.exitReason !== undefined)
      throw new BrowserHostExitedError(this.exitReason);
    const current = this.running ?? (await this.starting);
    if (current) {
      if (current.profileDir !== profileDir)
        throw new BrowserHostPolicyError('openTarget', 'profile-mismatch');
      return current;
    }
    this.starting = this.start(profileDir);
    try {
      this.running = await this.starting;
      return this.running;
    } finally {
      this.starting = undefined;
    }
  }

  private async start(profileDir: string): Promise<Running> {
    mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    const proxy = new BrowserEgressProxy({
      policy: this.options.egressPolicy,
      lookup: this.options.egress?.lookup,
      onRefused: (event) =>
        this.options.onEvent?.({ kind: 'egress-refused', ...event }),
    });
    await proxy.start();
    let launch: ChromiumLaunch;
    try {
      launch = this.launcher({
        executablePath: this.options.executablePath,
        args: buildChromiumArgs({
          profileDir,
          proxyServer: proxy.proxyServerArg,
        }),
      });
    } catch (error) {
      await proxy.close();
      throw error;
    }
    const running: Running = {
      profileDir,
      launch,
      proxy,
      targets: new Map(),
      popups: new Map(),
      unsubscribe: [],
      creating: 0,
      pendingUntracked: new Map(),
    };
    void launch.exited.then((reason) => {
      void proxy.close();
      this.markExited(reason);
    });
    try {
      await withTimeout(
        Promise.race([
          launch.transport.send('Browser.getVersion'),
          launch.exited.then((reason) => {
            throw new BrowserHostExitedError(reason);
          }),
        ]),
        this.options.launchTimeoutMs ?? 30_000,
        'Chromium launch',
      );
      await this.installBrowserEnforcement(running);
      return running;
    } catch (error) {
      for (const off of running.unsubscribe) off();
      await launch.terminate().catch(() => {});
      await proxy.close();
      this.markExited(
        `launch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  private async installBrowserEnforcement(running: Running): Promise<void> {
    const transport = running.launch.transport;
    await transport.send('Browser.setDownloadBehavior', {
      behavior: 'deny',
      eventsEnabled: true,
    });
    for (const name of MANDATORY_DENIED_PERMISSIONS) {
      await transport.send('Browser.setPermission', {
        permission: { name },
        setting: 'denied',
      });
    }
    for (const name of BEST_EFFORT_DENIED_PERMISSIONS) {
      await transport
        .send('Browser.setPermission', {
          permission: { name },
          setting: 'denied',
        })
        .catch((error: Error) =>
          this.options.onEvent?.({
            kind: 'permission-deny-skipped',
            permission: name,
            error: error.message,
          }),
        );
    }
    running.unsubscribe.push(
      transport.on('Fetch.requestPaused', (params) =>
        this.onRequestPaused(running, params),
      ),
      transport.on('Target.targetCreated', (params) =>
        this.onTargetSeen(running, params),
      ),
      transport.on('Target.targetInfoChanged', (params) =>
        this.onTargetSeen(running, params),
      ),
    );
    await transport.send('Fetch.enable', {
      patterns: [
        { urlPattern: '*', resourceType: 'Document', requestStage: 'Request' },
        ...stationSelfFetchPatterns(this.options.egressPolicy.listeners()).map(
          (urlPattern) => ({ urlPattern, requestStage: 'Request' }),
        ),
      ],
    });
    await transport.send('Target.setDiscoverTargets', { discover: true });
    // Any page present at launch was not created by this host.
    const { targetInfos } = await transport.send<{
      targetInfos?: Array<{ targetId: string; type: string; url: string }>;
    }>('Target.getTargets');
    for (const info of targetInfos ?? []) {
      if (info.type !== 'page') continue;
      await transport.send('Target.closeTarget', { targetId: info.targetId });
      this.options.onEvent?.({
        kind: 'untracked-target-closed',
        targetId: info.targetId,
        url: info.url,
      });
    }
  }

  private onRequestPaused(running: Running, params: unknown): void {
    const p = params as {
      requestId: string;
      request: { url: string };
      resourceType: string;
      frameId?: string;
    };
    const transport = running.launch.transport;
    const decision = decidePausedRequest(
      { url: p.request.url, resourceType: p.resourceType, frameId: p.frameId },
      {
        stationListeners: this.options.egressPolicy.listeners(),
        interfaceAddresses: this.options.egressPolicy.interfaceAddresses(),
        popupFrameIds: new Set(
          [...running.popups.entries()]
            .filter(([, popup]) => !popup.folded)
            .map(([id]) => id),
        ),
      },
    );
    if (decision.action === 'continue') {
      void transport
        .send('Fetch.continueRequest', { requestId: p.requestId })
        .catch(() => {});
      return;
    }
    void transport
      .send('Fetch.failRequest', {
        requestId: p.requestId,
        errorReason: 'BlockedByClient',
      })
      .catch(() => {});
    this.options.onEvent?.({
      kind: 'request-blocked',
      reason: decision.reason,
      url: p.request.url,
    });
    if (decision.reason === 'popup' && p.frameId)
      this.foldPopup(running, p.frameId, p.request.url);
  }

  private onTargetSeen(running: Running, params: unknown): void {
    const info = (params as { targetInfo?: Record<string, unknown> })
      .targetInfo;
    if (info?.type !== 'page' || typeof info.targetId !== 'string') return;
    const targetId = info.targetId;
    const url = typeof info.url === 'string' ? info.url : '';
    let popup = running.popups.get(targetId);
    if (!popup) {
      const opener =
        typeof info.openerId === 'string' ? info.openerId : undefined;
      if (!opener || !running.targets.has(opener)) {
        this.checkUntracked(running, targetId, url);
        return;
      }
      popup = { openerTargetId: opener, folded: false };
      running.popups.set(targetId, popup);
      // A popup opened without a URL (or that never reports one) is closed
      // after a grace period rather than left running unobserved.
      popup.timer = setTimeout(
        () => this.foldPopup(running, targetId, undefined),
        POPUP_URL_GRACE_MS,
      );
    }
    if (url !== '' && url !== ABOUT_BLANK)
      this.foldPopup(running, targetId, url);
  }

  /**
   * A page target this host did not create and that is not a popup of one of
   * its targets (the launch tab, an extension page, a view-source: tab) is
   * closed: no unobserved page may live in the browser (review B2).
   */
  private checkUntracked(
    running: Running,
    targetId: string,
    url: string,
  ): void {
    if (running.targets.has(targetId) || running.pendingUntracked.has(targetId))
      return;
    const check = () => {
      running.pendingUntracked.delete(targetId);
      if (running.targets.has(targetId) || running.popups.has(targetId)) return;
      if (running.creating > 0) {
        // One of our own creates may still be answering with this id.
        running.pendingUntracked.set(
          targetId,
          setTimeout(check, UNTRACKED_TARGET_GRACE_MS),
        );
        return;
      }
      void running.launch.transport
        .send('Target.closeTarget', { targetId })
        .catch(() => {});
      this.options.onEvent?.({
        kind: 'untracked-target-closed',
        targetId,
        url,
      });
    };
    running.pendingUntracked.set(
      targetId,
      setTimeout(check, UNTRACKED_TARGET_GRACE_MS),
    );
  }

  private foldPopup(
    running: Running,
    popupId: string,
    url: string | undefined,
  ): void {
    const popup = running.popups.get(popupId);
    if (!popup || popup.folded) return;
    popup.folded = true;
    if (popup.timer) clearTimeout(popup.timer);
    const transport = running.launch.transport;
    void transport
      .send('Target.closeTarget', { targetId: popupId })
      .catch(() => {});
    const opener = running.targets.get(popup.openerTargetId);
    const target =
      url !== undefined && isAllowedBrowserUrl(url) && url !== ABOUT_BLANK
        ? url
        : undefined;
    if (opener && target) {
      void transport
        .send('Page.navigate', { url: target }, opener.sessionId)
        .catch(() => {});
    }
    this.options.onEvent?.({
      kind: 'popup-folded',
      openerTargetId: popup.openerTargetId,
      url: target,
    });
    // Keep the folded record briefly so late events for it are ignored.
    setTimeout(
      () => running.popups.delete(popupId),
      POPUP_URL_GRACE_MS,
    ).unref?.();
  }

  private watchCommittedUrls(
    running: Running,
    targetId: string,
    sessionId: string,
  ): () => void {
    const transport = running.launch.transport;
    return transport.on('Page.frameNavigated', (params, eventSessionId) => {
      if (eventSessionId !== sessionId) return;
      const frame = (
        params as { frame?: { id?: string; url?: string; parentId?: string } }
      ).frame;
      if (!frame || typeof frame.url !== 'string') return;
      const subframe = frame.parentId !== undefined;
      if (
        subframe
          ? isAllowedSubframeUrl(frame.url)
          : isAllowedCommittedUrl(frame.url)
      )
        return;
      this.options.onEvent?.({
        kind: 'committed-url-refused',
        targetId,
        url: frame.url,
        frame: subframe ? 'subframe' : 'main',
      });
      // data:, blob: and filesystem: documents never touch the network, so
      // the Fetch layer cannot stop them; they are replaced on commit.
      void transport
        .send(
          'Page.navigate',
          {
            url: ABOUT_BLANK,
            ...(subframe && frame.id ? { frameId: frame.id } : {}),
          },
          sessionId,
        )
        .catch(() => {});
    });
  }

  private markExited(reason: string): void {
    if (this.exitReason !== undefined) return;
    this.exitReason = this.shuttingDown ? 'shutdown' : reason;
    const running = this.running;
    this.running = undefined;
    if (running) {
      for (const off of running.unsubscribe) off();
      for (const target of running.targets.values()) target.unsubscribe();
      for (const popup of running.popups.values())
        if (popup.timer) clearTimeout(popup.timer);
      for (const timer of running.pendingUntracked.values())
        clearTimeout(timer);
    }
    const listeners = [...this.exitListeners];
    this.exitListeners.clear();
    const exitReason = this.exitReason;
    for (const listener of listeners) {
      try {
        listener(exitReason);
      } catch {
        // One listener's failure must not hide the exit from the others.
      }
    }
  }

  private ownSession(sessionId: string | undefined): boolean {
    if (sessionId === undefined) return false;
    for (const target of this.running?.targets.values() ?? [])
      if (target.sessionId === sessionId) return true;
    return false;
  }

  private createGuardedTransport(): CdpTransport {
    const host = this;
    const closed = new Promise<void>((resolve) => {
      host.onExit(() => resolve());
    });
    const refuse = (method: string, code: BrowserHostPolicyError['code']) =>
      Promise.reject(new BrowserHostPolicyError(method, code));
    return {
      async send<R = unknown>(
        method: string,
        params?: object,
        sessionId?: string,
      ): Promise<R> {
        if (!PAGE_SESSION_CDP_ALLOWED.has(method))
          return refuse(method, 'host-owned-method');
        const running = host.requireRunning();
        if (!host.ownSession(sessionId))
          return refuse(method, 'foreign-session');
        if (method === 'Page.navigate') {
          const url = (params as { url?: unknown } | undefined)?.url;
          if (typeof url !== 'string' || !isAllowedBrowserUrl(url))
            return refuse(method, 'url-not-allowed');
        }
        if (method === 'Page.navigateToHistoryEntry') {
          const entryId = (params as { entryId?: unknown } | undefined)
            ?.entryId;
          const history = await running.launch.transport.send<{
            entries: Array<{ id: number; url: string }>;
          }>('Page.getNavigationHistory', {}, sessionId);
          const entry = history.entries.find((e) => e.id === entryId);
          if (!entry || !isAllowedBrowserUrl(entry.url))
            return refuse(method, 'url-not-allowed');
        }
        return running.launch.transport.send<R>(method, params, sessionId);
      },
      // Subscribe after openTarget: before launch there is no channel, and a
      // subscription that silently never fires would read as "no events".
      // Only events from this host's own page sessions are delivered.
      on(event, fn) {
        return host
          .requireRunning()
          .launch.transport.on(event, (params, sessionId) => {
            if (host.ownSession(sessionId)) fn(params, sessionId);
          });
      },
      // The channel belongs to the host; callers end it with shutdown().
      close: async () => {},
      closed,
    };
  }
}
