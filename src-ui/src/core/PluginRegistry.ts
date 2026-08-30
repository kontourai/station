/**
 * Plugin Registry — Runtime plugin discovery and loading
 *
 * Fetches installed plugins from /api/plugins, loads pre-built IIFE bundles
 * via script injection, and registers workspace components.
 */

import type { LayoutCatalogContribution } from '@kontourai/station-contracts/layout';
import {
  authenticatedFetch,
  type LayoutComponent,
} from '@kontourai/station-sdk';
import { createElement } from 'react';
import { isolatedPluginLayout } from '../components/plugins/isolatedPluginLayout';
import { nativePlatformPromise } from '../platform/native';
import { resolveCspNonce } from '../utils/csp';
import { log } from '../utils/logger';
import { ensurePluginSharedRuntimeReady } from './pluginSharedRuntime';

interface PluginActivationContext {
  readonly apiBase: string;
}

type PluginDisposer = () => void;

/** Plugin discovery must never block the app shell indefinitely. */
export const PLUGIN_REGISTRY_INVENTORY_TIMEOUT_MS = 8_000;

export type PluginRegistryLoadState = 'loading' | 'ready' | 'degraded';
export type PluginRegistrySettledLoadState = Exclude<
  PluginRegistryLoadState,
  'loading'
>;

export type PluginRegistryFailure =
  | 'remote-isolation'
  | 'registry-unavailable'
  | 'bundle-load-failure';

export interface PluginRegistryLoadStatus {
  readonly state: PluginRegistryLoadState;
  readonly failedPluginNames: readonly string[];
  /** Why contributed extensions are unavailable while the shell remains usable. */
  readonly failure?: PluginRegistryFailure;
}

export interface PluginRegistryConnectionOptions {
  readonly allowRemoteBundles?: boolean;
  /** Saved/native profile not owned by this desktop's supervised service. */
  readonly remoteProfile?: boolean;
}

interface PluginBundleExports {
  readonly components?: Record<string, LayoutComponent>;
  readonly default?: LayoutComponent;
  readonly activate?: (
    context: PluginActivationContext,
  ) => PluginDisposer | undefined;
}

interface RegisteredPluginLayout {
  readonly component: LayoutComponent;
  readonly owner: PluginLayoutOwner;
  readonly isolated?: boolean;
  readonly plugin?: {
    readonly name: string;
    readonly declaredSlug: string;
    readonly granted?: readonly string[];
  };
}

export interface PluginLayoutOwner {
  readonly pluginId: string;
  readonly source: string;
  readonly version: string;
  readonly generation: number;
}

/** The sole authority predicate for mounting and isolated byte transfer. */
export function authorizesPluginLayout(
  owner: PluginLayoutOwner,
  generation: number,
  contribution: LayoutCatalogContribution | undefined,
  isolated = false,
): boolean {
  // Every nested read is optional: this predicate runs over EVERY workspace
  // pane contribution during catalog resolution, and a contribution without
  // sourceIdentity/provenance is unauthorized, not a crash. Dereferencing them
  // eagerly threw during boot and blanked the whole app (no boundary above it).
  return Boolean(
    contribution &&
      owner.generation === generation &&
      contribution.version === owner.version &&
      (contribution.sourceIdentity?.kind === 'local' ||
        (isolated && contribution.sourceIdentity?.kind === 'remote')) &&
      contribution.sourceIdentity?.id === owner.pluginId &&
      contribution.sourceIdentity?.source === owner.source &&
      contribution.provenance?.origin === 'plugin' &&
      contribution.provenance?.pluginId === owner.pluginId,
  );
}

/**
 * Whether a plugin bundle URL is admitted by the shell's own `script-src
 * 'self'` — the single fact that decides whether the bundle can be loaded as a
 * URL or has to be fetched as bytes and executed under the shell nonce.
 */
function isSameOriginBundleUrl(url: string): boolean {
  if (typeof window === 'undefined' || !window.location?.origin) return false;
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * The single read of the plugin registration global.
 *
 * `window.__station_ai_plugins` is a shared mutable window property that any
 * executing bundle can write at any time — including a bundle whose load the
 * registry already reported as failed, which keeps running after the rejection
 * and after `performReload`'s `delete` (archive#4302). So presence of an entry
 * is never on its own evidence that the load the registry awaited produced it;
 * every read here is paired with the admission check in `loadPlugin`.
 */
function readBundleRegistration(name: string): PluginBundleExports | undefined {
  return (window as any).__station_ai_plugins?.[name] as
    | PluginBundleExports
    | undefined;
}

function isLoopbackPluginOrigin(apiBase: string): boolean {
  try {
    const url = new URL(apiBase);
    return (
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' ||
        url.hostname === '127.0.0.1' ||
        url.hostname === '[::1]')
    );
  } catch {
    return false;
  }
}

export class PluginRegistry {
  private layouts = new Map<string, RegisteredPluginLayout>();
  private pluginMeta = new Map<string, any>();
  private pluginDisposers = new Map<string, PluginDisposer>();
  private reloadInFlight: Promise<PluginRegistrySettledLoadState> | undefined;
  private reloadQueued = false;
  private apiBase = '';
  private connectionKey = '';
  private allowRemoteBundles = false;
  private remoteProfile = false;
  private nativeHost = false;
  private apiBaseGeneration = 0;
  /** Every inventory pass mints records that cannot survive a later reload. */
  private registryGeneration = 0;
  private apiBaseAbortController = new AbortController();
  private failedPluginNames: string[] = [];
  private failure: PluginRegistryFailure | undefined;
  private loadListeners = new Set<() => void>();
  private loadStatus: PluginRegistryLoadStatus = {
    state: 'loading',
    failedPluginNames: [],
    failure: undefined,
  };

  constructor(
    private readonly platformPromise: PromiseLike<{
      readonly platform: 'web' | 'tauri';
    }> = nativePlatformPromise,
  ) {}

  subscribe = (listener: () => void) => {
    this.loadListeners.add(listener);
    return () => this.loadListeners.delete(listener);
  };

  getLoadStatus = () => this.loadStatus;

  setApiBase(
    apiBase: string,
    connectionKey = apiBase,
    {
      allowRemoteBundles = false,
      remoteProfile = false,
    }: PluginRegistryConnectionOptions = {},
  ) {
    if (
      this.apiBase !== apiBase ||
      this.connectionKey !== connectionKey ||
      this.allowRemoteBundles !== allowRemoteBundles ||
      this.remoteProfile !== remoteProfile
    ) {
      this.apiBaseAbortController.abort();
      this.apiBaseAbortController = new AbortController();
      this.apiBaseGeneration += 1;
    }
    this.apiBase = apiBase;
    this.connectionKey = connectionKey;
    this.allowRemoteBundles = allowRemoteBundles;
    this.remoteProfile = remoteProfile;
  }

  async initialize(): Promise<PluginRegistrySettledLoadState> {
    const apiBase = this.apiBase;
    const apiBaseGeneration = this.apiBaseGeneration;
    const signal = this.apiBaseAbortController.signal;
    const registryGeneration = ++this.registryGeneration;
    this.failedPluginNames = [];
    this.failure = undefined;
    if (!apiBase) return 'ready';
    this.nativeHost = (await this.platformPromise).platform === 'tauri';
    const remoteBrowserIsolation =
      !isLoopbackPluginOrigin(apiBase) &&
      typeof window !== 'undefined' &&
      !this.nativeHost;
    // A paired/hosted native profile is remote authority even when its
    // selected transport terminates on loopback (for example an SSH forward).
    // Origin shape alone must not promote its plugin bytes into the privileged
    // root WebView.
    const remoteNativeIsolation = this.nativeHost && this.remoteProfile;
    if (
      ((!isLoopbackPluginOrigin(apiBase) && !remoteBrowserIsolation) ||
        remoteNativeIsolation) &&
      !this.allowRemoteBundles &&
      !remoteBrowserIsolation
    ) {
      // Remote Station bundles execute in this root webview and therefore
      // share its authenticated request and native-bridge authority. Until
      // plugins run behind an isolated execution boundary, never load code
      // supplied by a non-loopback saved Station.
      log.plugin(
        '[PluginRegistry] Skipped remote plugin bundles pending plugin isolation.',
      );
      this.failure = 'remote-isolation';
      return 'degraded';
    }

    try {
      const res = await authenticatedFetch(`${apiBase}/api/plugins`, {
        signal,
        timeoutMs: PLUGIN_REGISTRY_INVENTORY_TIMEOUT_MS,
      });
      if (!res.ok) {
        this.failure = 'registry-unavailable';
        return 'degraded';
      }
      const { plugins } = await res.json();
      if (!this.isCurrentConfiguredOrigin(apiBase, apiBaseGeneration)) {
        return 'ready';
      }

      let allBundlesLoaded = true;
      for (const plugin of plugins) {
        if (!plugin.hasBundle) continue;
        if (remoteBrowserIsolation || remoteNativeIsolation) {
          if (!this.registerIsolatedPlugin(plugin, registryGeneration)) {
            allBundlesLoaded = false;
            this.failedPluginNames.push(plugin.name);
          }
          continue;
        }
        if (
          !(await this.loadPlugin(
            plugin,
            apiBase,
            apiBaseGeneration,
            signal,
            registryGeneration,
          ))
        ) {
          allBundlesLoaded = false;
          this.failedPluginNames.push(plugin.name);
        }
      }

      log.plugin(
        `[PluginRegistry] Loaded ${this.pluginMeta.size} plugins, ${this.layouts.size} components`,
      );
      if (!allBundlesLoaded) this.failure = 'bundle-load-failure';
      return allBundlesLoaded ? 'ready' : 'degraded';
    } catch (e) {
      log.api('[PluginRegistry] Failed to initialize:', e);
      this.failure = 'registry-unavailable';
      return 'degraded';
    }
  }

  private registerIsolatedPlugin(pluginMeta: any, generation: number): boolean {
    const declaredSlug = pluginMeta?.layout?.slug;
    if (typeof declaredSlug !== 'string' || !declaredSlug) return false;
    const name = pluginMeta.name;
    const component: LayoutComponent = () =>
      createElement('div', { hidden: true });
    this.layouts.set(declaredSlug, {
      component,
      isolated: true,
      plugin: {
        name,
        declaredSlug,
        granted: pluginMeta.permissions?.granted,
      },
      owner: {
        pluginId: name,
        source: `plugins/${name}`,
        version: pluginMeta.version,
        generation,
      },
    });
    this.pluginMeta.set(name, pluginMeta);
    return true;
  }

  private markIsolatedPluginFailed(name: string): void {
    if (!this.failedPluginNames.includes(name))
      this.failedPluginNames.push(name);
    this.failure = 'bundle-load-failure';
    this.setLoadStatus('degraded', this.failedPluginNames, this.failure);
  }

  private setLoadStatus(
    state: PluginRegistryLoadState,
    failedPluginNames: readonly string[] = [],
    failure: PluginRegistryFailure | undefined = undefined,
  ): void {
    if (
      this.loadStatus.state === state &&
      this.loadStatus.failedPluginNames.length === failedPluginNames.length &&
      this.loadStatus.failedPluginNames.every(
        (name, index) => name === failedPluginNames[index],
      ) &&
      this.loadStatus.failure === failure
    ) {
      return;
    }
    this.loadStatus = {
      state,
      failedPluginNames: [...failedPluginNames],
      failure,
    };
    for (const listener of this.loadListeners) listener();
  }

  private isCurrentConfiguredOrigin(
    apiBase: string,
    apiBaseGeneration: number,
  ): boolean {
    return (
      this.apiBase === apiBase &&
      this.apiBaseGeneration === apiBaseGeneration &&
      (isLoopbackPluginOrigin(apiBase) ||
        this.allowRemoteBundles ||
        (typeof window !== 'undefined' && !this.nativeHost))
    );
  }

  private async loadPlugin(
    pluginMeta: any,
    apiBase: string,
    apiBaseGeneration: number,
    signal: AbortSignal,
    registryGeneration = this.registryGeneration,
  ): Promise<boolean> {
    const name = pluginMeta.name;
    try {
      // Load CSS first, then JS bundle
      await this.loadCSS(
        `${apiBase}/api/plugins/${encodeURIComponent(name)}/bundle.css`,
        apiBase,
        apiBaseGeneration,
        signal,
      );

      // Load JS bundle
      const bundleUrl = `${apiBase}/api/plugins/${encodeURIComponent(name)}/bundle.js`;

      // Whatever is already on the window before this load begins. A bundle
      // the registry disowned (timeout, abort, error) still executes, and it
      // can re-create `window.__station_ai_plugins` after `performReload`'s
      // `delete` has run — so an entry that is merely PRESENT may be the
      // corpse of a load this registry already reported as failed.
      const priorRegistration = readBundleRegistration(name);

      // Load IIFE bundle via script tag — it registers on window.__station_ai_plugins
      const observedRegistration = await this.loadScript(
        bundleUrl,
        name,
        apiBase,
        apiBaseGeneration,
        signal,
      );
      if (!this.isCurrentConfiguredOrigin(apiBase, apiBaseGeneration))
        return true;

      // Admitted only when THIS load was observed to produce it: the value is
      // read at the instant the browser reported the script executed, and it
      // must be a different object from the one that was there beforehand.
      // A late bundle's write lands after that instant, so it cannot be
      // adopted by the pass that was waiting for it; and on any later pass it
      // is identical to `priorRegistration`, so it cannot be adopted there
      // either. That is the property: a plugin the registry reported as
      // failed cannot become live by finishing late (archive#4302).
      const pluginExports =
        observedRegistration && observedRegistration !== priorRegistration
          ? observedRegistration
          : undefined;
      if (!pluginExports) {
        log.api(`[PluginRegistry] Plugin ${name} did not register exports`);
        return false;
      }

      const disposer = pluginExports.activate?.({ apiBase });
      if (disposer) this.pluginDisposers.set(name, disposer);

      // Register named component exports
      if (
        pluginExports.components &&
        typeof pluginExports.components === 'object'
      ) {
        for (const [id, component] of Object.entries(
          pluginExports.components,
        )) {
          this.layouts.set(id, {
            component: component as LayoutComponent,
            owner: {
              pluginId: name,
              source: `plugins/${name}`,
              version: pluginMeta.version,
              generation: registryGeneration,
            },
          });
          log.plugin(`[PluginRegistry] Registered: ${id}`);
        }
      }

      // Also register default export
      if (pluginExports.default) {
        this.layouts.set(name, {
          component: pluginExports.default as LayoutComponent,
          owner: {
            pluginId: name,
            source: `plugins/${name}`,
            version: pluginMeta.version,
            generation: registryGeneration,
          },
        });
      }

      this.pluginMeta.set(name, pluginMeta);
      return true;
    } catch {
      this.disposePlugin(name);
      // Plugin failures can contain provider authorization or signed
      // endpoints. Keep the host log content-free at this trust boundary.
      log.api(`[PluginRegistry] Failed to load plugin ${name}`);
      return false;
    }
  }

  /**
   * Executes one plugin bundle in the shell's own realm.
   *
   * A SAME-ORIGIN bundle is loaded BY URL and is given no nonce
   * (archive#4287). The HTTP shell serves
   * `script-src 'self' 'nonce-<per-response>' 'wasm-unsafe-eval'`; this used to
   * fetch the bundle's bytes and run them as an inline `<script>` carrying that
   * nonce, and code holding a nonce can mint further nonce'd scripts — remote
   * ones included — so the policy constrained everything except the code it was
   * written for. `'self'` admits a same-origin `<script src>` on its own, and
   * the browser sends the shell's HttpOnly device-session cookie with a
   * same-origin subresource request, so the bundle still loads authenticated
   * and the route is unchanged.
   *
   * What this does NOT do, and must not be described as doing: it does not stop
   * a plugin running code it chose after install. A plugin holding
   * `plugin.server` serves its own `/api/plugins/:name/*` routes, which are
   * same-origin and therefore admitted by `'self'` exactly as this bundle is.
   * What it restores is the narrower property the policy already advertises:
   * no UNDECLARED REMOTE script.
   *
   * A CROSS-ORIGIN bundle URL still takes the fetch-and-inline path and still
   * receives the shell nonce. That is the desktop app: its window is Tauri's
   * asset origin (`WebviewUrl::App("index.html")`) while the bundle lives on
   * the supervised server's loopback origin, so `'self'` does not admit the
   * URL; and its credential is held in Rust behind the native transport, so a
   * webview-issued `<script src>` would not be authenticated either. Closing it
   * there needs the desktop host to serve plugin bundles from the shell's own
   * origin — not a looser route here.
   */
  private async loadScript(
    url: string,
    name: string,
    apiBase: string,
    apiBaseGeneration: number,
    signal: AbortSignal,
  ): Promise<PluginBundleExports | undefined> {
    // Plugin-only shared modules are fetched on demand; the bundle's require
    // shim reads them synchronously once it executes, so resolve them first.
    if (!this.isCurrentConfiguredOrigin(apiBase, apiBaseGeneration))
      return undefined;
    await ensurePluginSharedRuntimeReady();
    if (!this.isCurrentConfiguredOrigin(apiBase, apiBaseGeneration))
      return undefined;
    if (!(window as any).require) {
      const shared = (window as any).__station_ai_shared || {};
      (window as any).require = (m: string) => {
        // Alias old package names
        if (shared[m]) return shared[m];
        if (m.startsWith('react')) return shared.react;
        console.warn('[Plugin] Unknown shared module:', m);
        return {};
      };
    }
    if (isSameOriginBundleUrl(url)) {
      return await this.executeBundleByUrl(url, name, signal);
    }
    return await this.executeBundleInline(
      url,
      name,
      apiBase,
      apiBaseGeneration,
      signal,
    );
  }

  /** Same-origin bundle: the browser fetches it, `'self'` admits it, no nonce. */
  private async executeBundleByUrl(
    url: string,
    name: string,
    signal: AbortSignal,
  ): Promise<PluginBundleExports | undefined> {
    // An already-aborted signal never fires `abort`, so without this the
    // script would be appended and run after the caller had given up.
    if (signal.aborted) throw new Error(`Aborted loading: ${url}`);
    const script = document.createElement('script');
    script.src = url;
    // Bundles execute in registry order today because each load is awaited;
    // keep that ordering explicit rather than depending on the await alone.
    script.async = false;
    script.setAttribute('data-station-plugin', url);
    return await new Promise<PluginBundleExports | undefined>(
      (resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settle = (
          error?: Error,
          observed?: PluginBundleExports | undefined,
        ) => {
          if (timer !== undefined) clearTimeout(timer);
          script.removeEventListener('load', handleLoad);
          script.removeEventListener('error', handleError);
          signal.removeEventListener('abort', handleAbort);
          if (!error) {
            resolve(observed);
            return;
          }
          // The element is deliberately LEFT IN PLACE. Removing a `<script src>`
          // does not cancel its pending fetch or its evaluation, so a bundle
          // that timed out or was aborted can still execute afterwards --
          // verified in Chromium. Removing the element would only hide that a
          // load is still in flight, and the reload sweep clears
          // `[data-station-plugin]` anyway.
          //
          // So this rejection means "the registry is not waiting for this any
          // more", NOT "this code will not run". A late bundle still executes in
          // the shell realm and can write `window.__station_ai_plugins` behind
          // the registry's back (archive#4302). The inline path could refuse
          // this because it re-checked the origin between fetch and append; a
          // browser-driven load structurally cannot.
          //
          // What IS in the host's power is refusing to trust the result. The
          // registration is read below at the instant the browser reports this
          // script executed, and `loadPlugin` admits it only if this load
          // produced it — so a write that lands after this settle is never
          // adopted, here or on any later pass.
          reject(error);
        };
        // Read synchronously in the load handler: a `load` event on a classic
        // script fires after its evaluation, so this is the registration THIS
        // script produced. Reading after the `await` instead would let any
        // later write — including a disowned bundle finishing at last — stand
        // in for it.
        const handleLoad = () =>
          settle(undefined, readBundleRegistration(name));
        const handleError = () => settle(new Error(`Failed to load: ${url}`));
        const handleAbort = () => settle(new Error(`Aborted loading: ${url}`));
        // A script element that never fires either event would leave plugin
        // discovery pending forever; the inventory deadline applies here too.
        timer = setTimeout(
          () => settle(new Error(`Timed out loading: ${url}`)),
          PLUGIN_REGISTRY_INVENTORY_TIMEOUT_MS,
        );
        script.addEventListener('load', handleLoad);
        script.addEventListener('error', handleError);
        signal.addEventListener('abort', handleAbort);
        document.head.appendChild(script);
      },
    );
  }

  /** Cross-origin bundle (the desktop shell): bytes fetched, run under the nonce. */
  private async executeBundleInline(
    url: string,
    name: string,
    apiBase: string,
    apiBaseGeneration: number,
    signal: AbortSignal,
  ): Promise<PluginBundleExports | undefined> {
    const response = await authenticatedFetch(url, {
      signal,
      timeoutMs: PLUGIN_REGISTRY_INVENTORY_TIMEOUT_MS,
    });
    if (!response.ok) throw new Error(`Failed to load: ${url}`);
    const source = await response.text();
    if (!this.isCurrentConfiguredOrigin(apiBase, apiBaseGeneration))
      return undefined;
    const script = document.createElement('script');
    script.textContent = `${source}\n//# sourceURL=${url}`;
    script.setAttribute('data-station-plugin', url);
    const nonce = resolveCspNonce();
    if (nonce) script.nonce = nonce;
    document.head.appendChild(script);
    // An inline classic script evaluates synchronously during the append, so
    // this read is the same instant-of-execution capture the URL path gets
    // from its `load` handler.
    return readBundleRegistration(name);
  }

  private async loadCSS(
    url: string,
    apiBase: string,
    apiBaseGeneration: number,
    signal: AbortSignal,
  ): Promise<void> {
    const res = await authenticatedFetch(url, {
      signal,
      timeoutMs: PLUGIN_REGISTRY_INVENTORY_TIMEOUT_MS,
    });
    if (!res.ok) throw new Error(`Failed to load plugin CSS: ${url}`);
    const css = await res.text();
    if (!this.isCurrentConfiguredOrigin(apiBase, apiBaseGeneration)) return;
    if (!css.trim()) return;
    const style = document.createElement('style');
    style.textContent = css;
    style.setAttribute('data-plugin-css', url);
    style.setAttribute('data-station-plugin', url);
    document.head.appendChild(style);
  }

  /** Reload — re-fetch plugin list and load any new bundles */
  reload(): Promise<PluginRegistrySettledLoadState> {
    if (this.reloadInFlight) {
      this.reloadQueued = true;
      return this.reloadInFlight;
    }
    const operation = this.drainReloads();
    this.reloadInFlight = operation;
    void operation.then(
      () => {
        if (this.reloadInFlight === operation) this.reloadInFlight = undefined;
      },
      () => {
        if (this.reloadInFlight === operation) this.reloadInFlight = undefined;
      },
    );
    return operation;
  }

  private async drainReloads(): Promise<PluginRegistrySettledLoadState> {
    let loadState: PluginRegistrySettledLoadState = 'ready';
    do {
      this.reloadQueued = false;
      loadState = await this.performReload();
    } while (this.reloadQueued);
    return loadState;
  }

  private async performReload(): Promise<PluginRegistrySettledLoadState> {
    this.setLoadStatus('loading');
    this.disposePlugins();
    this.layouts.clear();
    this.pluginMeta.clear();
    document
      .querySelectorAll('[data-station-plugin]')
      .forEach((node) => node.remove());
    // A bundle that stops registering an export must not inherit its previous
    // implementation from this window. Each reload rebuilds the registry from
    // the currently fetched bundles only.
    //
    // This `delete` is tidying, not the guarantee: a bundle still in flight
    // from the previous pass re-creates the global right after it runs
    // (archive#4302), so the property is enforced at admission in
    // `loadPlugin`, which requires each pass to observe its own registration
    // rather than trusting whatever the window holds.
    delete (window as any).__station_ai_plugins;
    const loadState = await this.initialize();
    this.setLoadStatus(loadState, this.failedPluginNames, this.failure);
    return loadState;
  }

  private disposePlugins(): void {
    for (const name of [...this.pluginDisposers.keys()]) {
      this.disposePlugin(name);
    }
  }

  private disposePlugin(name: string): void {
    const disposer = this.pluginDisposers.get(name);
    if (!disposer) return;
    this.pluginDisposers.delete(name);
    try {
      disposer();
    } catch {
      // Plugin cleanup is isolated: one broken plugin cannot retain every
      // other plugin's activation or block the host reload lifecycle.
      log.api(`[PluginRegistry] Plugin ${name} cleanup failed`);
    }
  }

  getLayout(name: string): LayoutComponent | null {
    return this.layouts.get(name)?.component ?? null;
  }

  /**
   * Returns a React component only when its active registry record is owned by
   * the exact local contribution bound to the pane occurrence. Component names
   * are intentionally insufficient authority: another contribution may use
   * the same name, or a newer registry generation may have replaced it.
   */
  getTrustedLayout(
    name: string,
    contribution: LayoutCatalogContribution | undefined,
  ): LayoutComponent | null {
    const registration = this.layouts.get(name);
    if (!registration || !contribution) return null;
    const { owner } = registration;
    if (
      !authorizesPluginLayout(
        owner,
        this.registryGeneration,
        contribution,
        registration.isolated,
      )
    )
      return null;
    if (registration.isolated && registration.plugin) {
      const plugin = registration.plugin;
      // The isolated host only renders for a remote Station's plugin Pane, so
      // it must not ride the entry chunk (archive#2467's ratchet). LazyBoundary
      // also gives a failed chunk fetch a contained retry instead of an
      // unhandled rejection.
      return () =>
        isolatedPluginLayout({
          plugin,
          authorize: () =>
            authorizesPluginLayout(
              owner,
              this.registryGeneration,
              contribution,
              true,
            ),
          onObservation: (exports: readonly string[]) => {
            if (!exports.includes(plugin.declaredSlug))
              this.markIsolatedPluginFailed(plugin.name);
          },
          onFailure: () => this.markIsolatedPluginFailed(plugin.name),
        });
    }
    return registration.component;
  }

  getComponent(name: string): LayoutComponent | null {
    return this.layouts.get(name)?.component ?? null;
  }

  hasLayout(name: string): boolean {
    return this.layouts.has(name);
  }

  hasComponent(name: string): boolean {
    return this.layouts.has(name);
  }

  listLayouts(): Array<{ name: string; manifest: any }> {
    return Array.from(this.pluginMeta.entries()).map(([name, manifest]) => ({
      name,
      manifest,
    }));
  }

  listComponents() {
    return this.listLayouts();
  }
  getLayoutManifest(name: string) {
    return this.pluginMeta.get(name) || null;
  }
  getComponentManifest(name: string) {
    return this.getLayoutManifest(name);
  }

  /** Aggregate links from all plugins, optionally filtered by placement */
  getLinks(
    placement?: string,
  ): Array<{ label: string; href: string; icon?: string; placement?: string }> {
    const links: Array<{
      label: string;
      href: string;
      icon?: string;
      placement?: string;
    }> = [];
    for (const meta of this.pluginMeta.values()) {
      for (const link of meta.links || []) {
        if (!placement || link.placement === placement) links.push(link);
      }
    }
    return links;
  }
}

export const pluginRegistry = new PluginRegistry();
