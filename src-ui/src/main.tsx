import { ANSWER_SHARE_PERMALINK_PATH } from '@kontourai/station-contracts/answer-share';
import { setClientOriginResolver } from '@kontourai/station-sdk/client-origin';
import React, { lazy } from 'react';
import ReactDOM from 'react-dom/client';
import { buildInfo } from './build-info';
import { installPluginSharedRuntime } from './core/pluginSharedRuntime';
import { installVisualViewportInset } from './hooks/useMobileVisualViewport';
import { installAndroidSafeArea } from './platform/androidSafeArea';
import { clientOriginSurfaceForProfile } from './platform/client-origin-surface';
import { NativeRendererMountCommit } from './platform/native/rendererLiveness';
import { SharedAnswerBoundary } from './views/share/SharedAnswerBoundary';

// Expose shared modules globally for dynamically loaded plugin bundles. This
// publishes only what first paint already ships (React, React Query, debug);
// the rest — the SDK barrel, UserDetailModal, the SDK client, voice SDK, zod,
// dompurify — resolve on demand from the same module, and `PluginRegistry`
// awaits them before the first bundle is injected.
installPluginSharedRuntime();

// Android WebView never populates env(safe-area-inset-*) for system bars —
// project the native WindowInsets onto --safe-* before first paint (archive#2617).
installAndroidSafeArea();
// The visible-viewport bottom inset, on the document element, so every fixed
// surface reads one value instead of the one its own subtree happens to carry.
installVisualViewportInset();

import App from './App';
import './components/editor-controls.css';
import './index.css';
import './tailwind.css';
import { QueryCache, QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { DeferredCapabilityBoundary } from './components/DeferredCapabilityBoundary';
import { LocalUiSessionGate } from './components/LocalUiSessionGate';
import { NotificationContainer } from './components/notifications/NotificationContainer';
import { ActiveChatsProvider } from './contexts/ActiveChatsContext';
import { AnalyticsProvider } from './contexts/AnalyticsContext';
import { ApiBaseProvider } from './contexts/ApiBaseContext';
import { AuthProvider } from './contexts/AuthContext';
import { ConversationsProvider } from './contexts/ConversationsContext';
import { KeyboardShortcutsProvider } from './contexts/KeyboardShortcutsContext';
import { MessageContextContext } from './contexts/MessageContextContext';
import { NavigationProvider } from './contexts/NavigationContext';
import { PreviewProvider } from './contexts/PreviewContext';
import { StreamingProvider } from './contexts/StreamingContext';
import { SyntaxHighlighterProvider } from './contexts/SyntaxHighlighterContext';
import { ToastProvider } from './contexts/ToastContext';
import { VoiceProviderContext } from './contexts/VoiceProviderContext';
import { PermissionManager } from './core/PermissionManager';
import { EXTENSIONS_UNAVAILABLE_LABEL } from './core/pluginRegistryCopy';
import { LocaleProvider, resolveDevelopmentLocale } from './i18n/LocaleContext';
import { applyAccentColor } from './lib/accent-contrast';
import {
  resolveBootAccentColor,
  resolveBootTheme,
} from './lib/device-settings-store';
import { resolveLocalUiSession } from './lib/local-ui-bootstrap';
import {
  applyPersistedQueryGcTimeDefaults,
  buildPersistOptions,
} from './lib/queryPersistence';
import {
  PlatformBootstrap,
  usePlatformProfile,
} from './platform/PlatformProfileContext';
import './providers/context/index';

// Connection onboarding is mounted after the provider shell has booted. Keep
// its recovery/pairing machinery out of the first-paint graph; the gate itself
// preserves the shell once it resolves.
const loadOnboardingGate = () =>
  import('./components/OnboardingGate').then((module) => ({
    default: () => <module.OnboardingGate>{null}</module.OnboardingGate>,
  }));

// Voice providers subscribe through VoiceProviderContext, so they can load off
// the startup bundle and notify the mounted tree when registration completes.
void import('./providers/voice/index');

/**
 * The shared-answer permalink page (archive#1423) is lazy so none of it — nor
 * its CSS — lands in the entry chunk every operator loads. Only the one-line
 * predicate below is paid on first paint.
 */
const SharedAnswerView = lazy(() =>
  import('./views/share/SharedAnswerView').then((module) => ({
    default: module.SharedAnswerView,
  })),
);

// Registry discovery is non-blocking and its client bundle is only needed
// after the shell has mounted. Keeping just its bootstrap lazy preserves the
// shell's single mount while keeping registry diagnostics off first paint.
const loadPluginRegistryBootstrap = () =>
  import('./components/registry/PluginRegistryGate').then((module) => ({
    default: module.PluginRegistryBootstrap,
  }));

/**
 * A share holder is not this Station's operator, so their page is mounted
 * ABOVE the whole provider tree rather than inside it.
 *
 * The share page stays outside the operator provider tree because a share
 * holder must not enter connection-recovery or operator chrome, and because
 * `PersistQueryClientProvider` writes fetched data into the browser's IndexedDB.
 * Mounting it inside would leave a persisted slice of someone else's Station
 * in a stranger's browser. The share page fetches once, holds nothing, and
 * stores nothing.
 */
const isSharedAnswerPath =
  window.location.pathname === ANSWER_SHARE_PERMALINK_PATH ||
  window.location.pathname === `${ANSWER_SHARE_PERMALINK_PATH}/`;
const localUiApiBase =
  (window as Window & { __API_BASE__?: string }).__API_BASE__ ||
  import.meta.env.VITE_API_BASE ||
  window.location.origin;

const isNativeShell =
  Object.getOwnPropertyDescriptor(window, '__TAURI_INTERNALS__') !== undefined;
// A development harness may use `?locale=en-XA` to exercise expansion. The
// resolver rejects that URL in production, and LocaleProvider independently
// keeps its dynamically imported catalog behind its own DEV boundary.
const developmentLocale = resolveDevelopmentLocale(
  window.location.search,
  import.meta.env.DEV,
);

function ClientOriginProfileBridge() {
  const profile = usePlatformProfile();
  const surface = clientOriginSurfaceForProfile(profile);
  React.useEffect(() => {
    setClientOriginResolver(() => ({
      version: 1,
      surface,
      build:
        buildInfo.version === '0.0.0' && buildInfo.commit === 'dev'
          ? null
          : `${buildInfo.version}+${buildInfo.commit}`,
    }));
    return () => setClientOriginResolver(undefined);
  }, [surface]);
  return null;
}

function PlatformSessionGate({ children }: { children: React.ReactNode }) {
  const profile = usePlatformProfile();
  return profile.isTauri ? (
    children
  ) : (
    <LocalUiSessionGate apiBase={localUiApiBase}>{children}</LocalUiSessionGate>
  );
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      if (import.meta.env.DEV)
        console.error(`[query:${query.queryKey}]`, error);
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes
      gcTime: 10 * 60 * 1000, // 10 minutes (renamed from cacheTime in v5)
      refetchOnWindowFocus: false,
      refetchOnMount: false, // Prevent StrictMode double-fetch — if data is in cache, don't refetch on mount
      retry: 1,
    },
  },
});

// Debug: Track all hash changes globally with more detail
let lastHash = window.location.hash;
window.addEventListener('hashchange', () => {
  const newHash = window.location.hash;
  if (newHash === '' && lastHash !== '') {
  }
  lastHash = newHash;
});

// Base resolution is the connect store's job: ApiBaseProvider seeds the
// origin default (web) and folds any CLI `--base` / `window.__API_BASE__`
// override into the store as an injected connection. StationCredentialBridge
// calls `_setApiBase` synchronously in render, so no pre-render bootstrap is
// needed here. Host detection and the macOS overlay-title-bar tagging now live
// in PlatformBootstrap, the single native-adapter resolution path.

// archive#1223 (offline): floor gcTime for the whitelisted, persisted
// query keys so they survive well past this client's ordinary 10-minute
// default — otherwise they can be garbage-collected from the live cache
// (and silently drop out of the persisted snapshot) long before the 24h
// persister maxAge below would ever expire them. Must run before anything
// renders/mounts a query for one of these keys. See queryPersistence.ts.
applyPersistedQueryGcTimeDefaults(queryClient);

// The whitelisted-query persist options (persister, maxAge, buster,
// dehydrate rules) — fed to <PersistQueryClientProvider> below, which both
// persists the cache to IndexedDB AND gates queries from fetching while an
// async restore is in flight (see queryPersistence.ts's doc comment for why
// that gating matters — a bare persistQueryClient call doesn't do it).
const queryPersistOptions = buildPersistOptions();

if (!isSharedAnswerPath && !isNativeShell) {
  void import('../../packages/sdk/src/boot')
    .then(async ({ fetchAndSeedBootPayload }) => {
      // This joins LocalUiSessionGate's page-memoized resolution, including a
      // launcher-token exchange. Never seed protected boot data before that
      // resolution has earned an authenticated browser session.
      const resolution = await resolveLocalUiSession(localUiApiBase);
      if (resolution.kind === 'authenticated') {
        await fetchAndSeedBootPayload(queryClient);
      }
    })
    .catch(() => {});
}

// Boot-time device-settings fast path: apply theme and accent color
// synchronously, before the first React render, so neither one flashes to
// its default and back (archive#settings-revamp). Reads the new
// envelope key first (post-migration browsers), then reads
// each prior raw key, since this runs before `deviceSettingsStore`'s own
// constructor has had a chance to migrate a pre-migration browser's prior setting
// keys — `resolveBootTheme`/`resolveBootAccentColor` are pure and unit
// tested (`lib/__tests__/device-settings-store.test.ts`) precisely because
// this boot-only prior-key read happens before the settings store exists.
const _envelopeRaw = localStorage.getItem('station-device-settings-v1');
const _bootTheme = resolveBootTheme(
  _envelopeRaw,
  localStorage.getItem('theme'),
);
document.documentElement.setAttribute('data-theme', _bootTheme);
const _bootAccent = resolveBootAccentColor(
  _envelopeRaw,
  localStorage.getItem('station-accent-color'),
);
// Accent and its contrast partner are applied together — see accent-contrast.ts.
if (_bootAccent) applyAccentColor(document.documentElement, _bootAccent);

function renderApp(): void {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    isSharedAnswerPath ? (
      <React.StrictMode>
        <NativeRendererMountCommit />
        {/* The boundary is eager (it must exist to catch the page's own chunk
          failing to load) and carries no stylesheet, so the entry cost is a
          few hundred bytes rather than the share page's CSS. */}
        <SharedAnswerBoundary>
          <SharedAnswerView />
        </SharedAnswerBoundary>
      </React.StrictMode>
    ) : (
      <React.StrictMode>
        <NativeRendererMountCommit />
        <PlatformBootstrap>
          <ClientOriginProfileBridge />
          <ApiBaseProvider>
            <PlatformSessionGate>
              <PersistQueryClientProvider
                client={queryClient}
                persistOptions={queryPersistOptions}
                onError={() => {
                  // Degrade gracefully: IndexedDB can be unavailable (Safari private
                  // mode) or throw; the provider's internal restore already discards
                  // the persisted cache in that case (see persistQueryClientRestore's
                  // catch), so this is disclosure only — the app continues without a
                  // persisted cache rather than crashing or hanging first paint.
                  if (import.meta.env.DEV) {
                    console.warn(
                      '[queryPersistence] restore failed; continuing without a persisted cache',
                    );
                  }
                }}
              >
                <SyntaxHighlighterProvider>
                  <AuthProvider>
                    <NavigationProvider>
                      <ToastProvider>
                        <PermissionManager>
                          <KeyboardShortcutsProvider>
                            <ConversationsProvider>
                              <ActiveChatsProvider>
                                <VoiceProviderContext>
                                  <MessageContextContext>
                                    <StreamingProvider>
                                      <AnalyticsProvider>
                                        <PreviewProvider>
                                          <LocaleProvider
                                            developmentLocale={
                                              developmentLocale
                                            }
                                          >
                                            <App />
                                            <NotificationContainer />
                                          </LocaleProvider>
                                        </PreviewProvider>
                                      </AnalyticsProvider>
                                    </StreamingProvider>
                                  </MessageContextContext>
                                </VoiceProviderContext>
                              </ActiveChatsProvider>
                            </ConversationsProvider>
                          </KeyboardShortcutsProvider>
                        </PermissionManager>
                        <DeferredCapabilityBoundary
                          id="connection-recovery"
                          load={loadOnboardingGate}
                          copy={{
                            // The title renders as the banner's badge, which
                            // is uppercased and sits beside two-word badges —
                            // a sentence here reads as shouting. The full
                            // statement is the message below.
                            failureTitle: 'Recovery unavailable',
                            failure:
                              'Saved-Station recovery did not start. The workspace stays usable; reload to verify or restore saved Stations.',
                          }}
                        />
                        <DeferredCapabilityBoundary
                          id="extension-registry"
                          load={loadPluginRegistryBootstrap}
                          copy={{
                            failureTitle: EXTENSIONS_UNAVAILABLE_LABEL,
                            failure:
                              'Station could not start the extension registry. Plugin-provided panes and capabilities remain unavailable until Station is reloaded.',
                          }}
                        />
                      </ToastProvider>
                    </NavigationProvider>
                  </AuthProvider>
                </SyntaxHighlighterProvider>
              </PersistQueryClientProvider>
            </PlatformSessionGate>
          </ApiBaseProvider>
        </PlatformBootstrap>
      </React.StrictMode>
    ),
  );
}

renderApp();
