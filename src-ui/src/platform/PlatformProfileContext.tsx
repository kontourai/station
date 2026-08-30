/**
 * PlatformProfileContext — the single first-paint gate that resolves which host
 * Station is running on before the app shell (and its connection seeding) can
 * make platform-dependent decisions.
 *
 * The profile is derived exclusively from the native platform adapter
 * (`nativePlatformPromise`) plus, on Tauri, its capability report — never from a
 * user agent. Web resolves without awaiting a capability report so the browser
 * does not flash the neutral loader; desktop/mobile await one report so the gate
 * knows the compile target and whether the desktop tray supervises a bundled
 * server.
 */

import { FullScreenLoader } from '@kontourai/station-sdk';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { nativePlatformPromise } from './native';
import { primeNativeNotifications } from './native/notify';
import type { NativeStationProfileStorage } from './native/stationProfileStorage';
import type { NativeCompileTarget } from './native/types';

export interface PlatformProfile {
  /** True when running inside the Tauri native shell (desktop or mobile). */
  isTauri: boolean;
  /** Compile target reported by the host; 'web' for the browser adapter. */
  target: NativeCompileTarget | 'web';
  /** Android or iOS native shell. */
  isMobile: boolean;
  /** macOS, Linux, or Windows native shell. */
  isDesktop: boolean;
  /**
   * The desktop tray reports the selected desktop-owned sidecar or attached
   * durable Station service. Only true on a desktop target with
   * `desktop-tray` enabled.
   */
  supervisesBundledServer: boolean;
  /**
   * A development build of the native shell. The dev app installs beside a
   * real one, so the whole UI is tinted to make which is which unmistakable.
   */
  isDevBuild: boolean;
  /** Configured local Tauri package identity, never remote Station branding. */
  productName?: string;
  channel?: 'stable' | 'dev' | 'beta' | 'nightly';
  /** Native scheme selected by this installed client, never a backend URL. */
  pairingDeepLinkScheme?: string;
  /** Trusted, secret-free mobile bootstrap; explicit saved selection wins. */
  mobileDefaultEndpoint?: string;
}

const WEB_PROFILE: PlatformProfile = {
  isTauri: false,
  target: 'web',
  isMobile: false,
  isDesktop: false,
  supervisesBundledServer: false,
  isDevBuild: false,
  productName: 'Station',
};

const DESKTOP_TARGETS: ReadonlySet<NativeCompileTarget> = new Set([
  'macos',
  'linux',
  'windows',
]);
const MOBILE_TARGETS: ReadonlySet<NativeCompileTarget> = new Set([
  'android',
  'ios',
]);
const DESKTOP_PROFILE_REFRESH_INTERVAL_MS = 5_000;

/**
 * Horizontal clearance for the macOS overlay-title-bar traffic lights
 * (archive#3316). `trafficLightPosition` in src-desktop/tauri.conf.json puts
 * the cluster at x=12 with ~52px of lights and spacing, so 80px clears it
 * with a normal gutter. Keep the two in sync when either moves.
 *
 * What `trafficLightPosition.y` is NOT: a centring instruction. tao's
 * `inset_traffic_lights` (platform_impl/macos/view.rs) resizes the titlebar
 * container to `closeButton.height + y` and rewrites only the buttons' `x`,
 * so the vertical result is `y` minus the buttons' pre-existing offset inside
 * that container — a value this seat cannot read. The delivery commit for
 * #3316 claimed `y: 17` "centers the lights against the 46px toolbar". The
 * toolbar measures 37.6px (Chromium, desktop width, `--safe-top: 0`), so the
 * 46px premise was wrong; on the measured height its midline is 18.8px, which
 * is why 17 is kept rather than raised.
 * NOT_VERIFIED: the vertical alignment itself. Nothing here has seen the
 * lights render — it needs a screenshot from the packaged macOS app, and any
 * adjustment should come from that measurement rather than from arithmetic.
 */
export const MACOS_TITLEBAR_INSET_LEFT = '80px';

/**
 * Defensive fallback when a Tauri host answers but its capability report cannot
 * be read (error/unsupported). The shell still knows it is native, but without a
 * trustworthy compile target it declines mobile/desktop branches and falls
 * through to the web-style connection flow.
 */
const TAURI_UNKNOWN_PROFILE: PlatformProfile = {
  isTauri: true,
  target: 'unknown',
  isMobile: false,
  isDesktop: false,
  supervisesBundledServer: false,
  // Unreadable report: claim release, so a real install is never mistinted.
  isDevBuild: false,
  productName: 'Station',
};

async function nativeProductName(): Promise<string> {
  const { configuredNativeProductName } = await import('./native/productName');
  return (await configuredNativeProductName()) ?? 'Station';
}

async function resolvePlatformProfile(): Promise<PlatformProfile> {
  const adapter = await nativePlatformPromise;
  // Web needs no capability report: skipping the second await keeps the browser
  // from lingering on the neutral loader beyond the adapter microtask.
  if (adapter.platform !== 'tauri') return WEB_PROFILE;

  const [report, productName] = await Promise.all([
    adapter.getCapabilityReport(),
    nativeProductName(),
  ]);
  if (report.status !== 'ok') {
    return { ...TAURI_UNKNOWN_PROFILE, productName };
  }

  const target = report.value.platform;
  const isMobile = MOBILE_TARGETS.has(target);
  const isDesktop = DESKTOP_TARGETS.has(target);
  const trayEnabled = report.value.capabilities.some(
    (capability) =>
      capability.id === 'desktop-tray' && capability.state === 'enabled',
  );
  return {
    isTauri: true,
    target,
    isMobile,
    isDesktop,
    supervisesBundledServer: isDesktop && trayEnabled,
    isDevBuild: report.value.devBuild === true,
    productName,
    channel:
      report.value.channel ??
      (report.value.devBuild === true ? 'dev' : 'stable'),
    pairingDeepLinkScheme: report.value.pairingDeepLinkScheme,
    ...(isMobile && report.value.mobileDefaultEndpoint
      ? { mobileDefaultEndpoint: report.value.mobileDefaultEndpoint }
      : {}),
  };
}

// Kick off resolution eagerly at module load so a mount that happens after the
// adapter microtask settles can render the profile without a loader frame.
/**
 * Pairing credentials for the native shell, persisted by the host.
 *
 * Reads are synchronous, so this has to be hydrated before anything asks for a
 * credential — a read that lands early looks like "not paired" and sends the
 * user back through pairing. Bootstrap already blocks on the profile, so the
 * hydration rides along with it.
 */
let profileRepository: NativeStationProfileStorage | null = null;
let nativeBootstrapRecoveryError: string | undefined;

export function nativeProfileRepository(): NativeStationProfileStorage {
  if (!profileRepository)
    throw new Error('The native Station list is not ready yet.');
  return profileRepository;
}

/** A one-boot, safe-to-display native credential recovery failure. */
export function nativeProfileBootstrapRecoveryError(): string | undefined {
  return nativeBootstrapRecoveryError;
}

let cachedProfile: PlatformProfile | null = null;
const profileReady: Promise<PlatformProfile> = resolvePlatformProfile().then(
  async (profile) => {
    if (profile.isTauri) {
      const [{ nativeStationProfileStorage }] = await Promise.all([
        import('./native/stationProfileStorage'),
      ]);
      profileRepository = nativeStationProfileStorage();
      await profileRepository.hydrate();
      if (profile.isDesktop) {
        const [{ bootstrapBundledLocalProfile }, { invokeTauri }] =
          await Promise.all([
            import('./native/bundledLocalProfileBootstrap'),
            import('./native/tauriInvoke'),
          ]);
        const adapter = await nativePlatformPromise;
        const bootstrap = await bootstrapBundledLocalProfile({
          adapter,
          repository: profileRepository,
          invoke: invokeTauri,
        });
        nativeBootstrapRecoveryError = bootstrap.recoveryError;
      }
      // Rust's active-profile authority is process-local. Desktop bootstrap
      // already selected this runtime's owner (or the confirmed-unowned shared
      // default); mobile still binds the shared default here before any health
      // probe. The OS credential never crosses this boundary.
      // A failed replacement write leaves the profile intentionally in its
      // requires-auth transition. Do not throw the shell back into its loader
      // by trying to authorize it; let OnboardingGate present the concrete
      // keychain remedy recorded above.
      if (!profile.isDesktop && !nativeBootstrapRecoveryError) {
        await profileRepository.authorizeDefaultProfile();
      }
    }
    if (profile.isTauri) {
      // Ask for notification permission here rather than when one arrives: a
      // permission dialog that appears because a stranger's device asked to
      // pair is confusing, and it nudges the user to tap through whatever is
      // behind it. Failure is not fatal — notifications degrade to in-app.
      void primeNativeNotifications();
    }
    cachedProfile = profile;
    return profile;
  },
);
let cachedProfileBootstrapError: string | null = null;
const profileResolution = profileReady.then(
  (profile) => ({ status: 'ok' as const, profile }),
  (error) => {
    const message = error instanceof Error ? error.message : String(error);
    cachedProfileBootstrapError = message;
    return { status: 'error' as const, message };
  },
);

const PlatformProfileContext = createContext<PlatformProfile>(WEB_PROFILE);
const NativeProfileStoreEpochContext = createContext(0);
const NativeProfileSelectionContext = createContext<
  (connectionId: string) => Promise<void>
>(async () => {});

export function PlatformBootstrap({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<PlatformProfile | null>(
    () => cachedProfile,
  );
  const [profileBootstrapError, setProfileBootstrapError] = useState<
    string | null
  >(() => cachedProfileBootstrapError);
  const [profileStoreEpoch, setProfileStoreEpoch] = useState(0);
  const nativeSelectionTail = useRef<Promise<void>>(Promise.resolve());

  // Native credential access is serial: select the host-authorized profile,
  // then publish a new secret-free connection snapshot. Rust reads the keyring
  // for every request; no renderer hydration occurs.
  // This is intentionally separate from `makeDefault`, which is the only path
  // allowed to change the CLI-owned shared default.
  const prepareNativeActiveConnection = useCallback(
    (connectionId: string): Promise<void> => {
      const next = nativeSelectionTail.current
        .catch(() => undefined)
        .then(async () => {
          if (!profile?.isTauri) return;
          const repository = nativeProfileRepository();
          const authorized = await repository.authorizeActiveConnection(
            connectionId,
            true,
          );
          if (!authorized) return;
          setProfileStoreEpoch((epoch) => epoch + 1);
        });
      nativeSelectionTail.current = next;
      return next;
    },
    [profile?.isTauri],
  );

  useEffect(() => {
    if (profile || profileBootstrapError) return;
    let active = true;
    void profileResolution.then((resolved) => {
      if (!active) return;
      if (resolved.status === 'ok') setProfile(resolved.profile);
      else setProfileBootstrapError(resolved.message);
    });
    return () => {
      active = false;
    };
  }, [profile, profileBootstrapError]);

  // `profiles.json` is shared with the CLI, so native Desktop cannot assume
  // its bootstrap snapshot remains current. Poll the secret-free metadata at a
  // deliberately modest cadence; a changed document remounts the connection
  // subtree so its initial projection and active default update together.
  //
  // A read failure is fail-closed: retain the last known-good projection rather
  // than presenting an empty list or attempting credential-vault recovery.
  // Refresh is single-flight and cleanup prevents an unmounted shell from
  // committing a late result.
  useEffect(() => {
    if (!profile?.isDesktop) return;
    let active = true;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        if ((await nativeProfileRepository().refresh()) && active) {
          setProfileStoreEpoch((epoch) => epoch + 1);
        }
      } catch (error) {
        console.warn(
          'Saved Station refresh failed; retaining the last known-good list.',
          error,
        );
      } finally {
        refreshing = false;
      }
    };
    const interval = window.setInterval(
      () => void refresh(),
      DESKTOP_PROFILE_REFRESH_INTERVAL_MS,
    );
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [profile?.isDesktop]);

  /**
   * Stamp the resolved platform on the root so CSS and copy can both branch on
   * it without re-deriving the answer.
   *
   * The distinction that matters is native-mobile: an APK/IPA build is the one
   * target that never has a local server, so language implying "the server on
   * this device" is simply wrong there. JS reads this through
   * `usePlatformProfile`; this attribute exists so stylesheets can too.
   * Toggled, not only added, for the same reason as the dev-build tint below —
   * the profile can resolve after a first render and a stale value would lie.
   */
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.platform = profile
      ? profile.isTauri
        ? `native-${profile.target}`
        : 'web'
      : 'unknown';
    root.dataset.platformClass = profile
      ? profile.isMobile
        ? 'mobile-native'
        : profile.isTauri
          ? 'desktop-native'
          : 'web'
      : 'unknown';
  }, [profile]);

  // Consolidated macOS overlay-title-bar tagging (moved out of main.tsx for DRY):
  // the native traffic lights float over web content, so tag the root and let
  // CSS inset the sidebar header around them. macOS-only, class name unchanged.
  //
  // `--titlebar-inset-left` (archive#3316) rides the same detection: the
  // toolbar consumes it via `max` where it spans the window's full width
  // (index.css), so its first control clears the traffic-light cluster.
  // Stamped as a root variable rather than hardcoded in CSS so non-mac shells
  // and the browser resolve to 0. Known accepted gap: macOS hides the lights
  // in native fullscreen and the inset does not collapse there — minor dead
  // space, not an overlap.
  //
  // Toggled, and unwound on teardown, for the same reason as the dev-build tint
  // below. `<html>` outlives this component, so an add-only effect can never
  // take the tag back off: a profile that resolves to macOS and then stops
  // being mounted leaves "this is a macOS desktop shell" asserted for whatever
  // renders next. That is what made archive#1079's two profile tests fail as an
  // inverted pair — one read the tag before its own effect stamped it, the next
  // read the leftover tag from the first.
  useEffect(() => {
    const root = document.documentElement;
    const isMacDesktopShell = profile?.target === 'macos';
    root.classList.toggle('is-desktop-mac', isMacDesktopShell);
    if (isMacDesktopShell) {
      root.style.setProperty(
        '--titlebar-inset-left',
        MACOS_TITLEBAR_INSET_LEFT,
      );
    } else {
      root.style.removeProperty('--titlebar-inset-left');
    }
    return () => {
      root.classList.remove('is-desktop-mac');
      root.style.removeProperty('--titlebar-inset-left');
    };
  }, [profile]);

  // A dev build sits next to a real install under a near-identical name, so
  // tint the whole app rather than relying on the launcher icon alone. Toggled
  // rather than only added: the profile can resolve after a release-build
  // render, and a stale tint would be a lie about which app is on screen.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.appChannel = profile?.channel ?? 'stable';
    root.classList.toggle('is-dev-build', profile?.isDevBuild === true);
    return () => {
      delete root.dataset.appChannel;
      root.classList.remove('is-dev-build');
    };
  }, [profile]);

  if (profileBootstrapError) {
    return (
      <FullScreenLoader
        label="Station"
        message="Station couldn’t finish starting"
        action={
          <div role="alert" aria-label="Station couldn’t finish starting">
            <pre>{profileBootstrapError}</pre>
            <button type="button" onClick={() => window.location.reload()}>
              Reload Station
            </button>
          </div>
        }
      />
    );
  }
  if (!profile) return <FullScreenLoader label="Station" />;

  return (
    <PlatformProfileContext.Provider value={profile}>
      <NativeProfileSelectionContext.Provider
        value={prepareNativeActiveConnection}
      >
        <NativeProfileStoreEpochContext.Provider value={profileStoreEpoch}>
          {children}
        </NativeProfileStoreEpochContext.Provider>
      </NativeProfileSelectionContext.Provider>
    </PlatformProfileContext.Provider>
  );
}

export function usePlatformProfile(): PlatformProfile {
  return useContext(PlatformProfileContext);
}

/**
 * Changes only when Desktop has accepted a newer saved-Station-store snapshot.
 * Connection consumers use it to republish their projected connections without
 * remounting unrelated application state.
 */
export function useNativeProfileStoreEpoch(): number {
  return useContext(NativeProfileStoreEpochContext);
}

/**
 * Host-owned preparation for a transient native Station selection. Consumers
 * await it before starting a probe so the credential provider is current.
 */
export function useNativeProfileSelection(): (
  connectionId: string,
) => Promise<void> {
  return useContext(NativeProfileSelectionContext);
}
