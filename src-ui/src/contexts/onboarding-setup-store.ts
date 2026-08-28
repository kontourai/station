import { useSyncExternalStore } from 'react';
import {
  buildSetupBannerContent,
  type SetupBannerContent,
  shouldShowSetupBanner,
} from '../components/onboardingGateUtils';
import { useSystemStatus } from '../hooks/useSystemStatus';
import { deviceSettingsStore } from '../lib/device-settings-store';

type Listener = () => void;

/**
 * Module-level store for the "has the user dismissed the first-run setup
 * banner" flag. Lifted out of `OnboardingGate` (archive#191) so any consumer
 * (currently `OnboardingGate` and `AppViewContent`) can read/derive the same
 * dismissed state without prop-drilling or duplicating the readiness
 * derivation — mirrors the `activeChatsStore`/`conversationsStore` pattern.
 */
class OnboardingSetupStore {
  /**
   * In-memory only, deliberately: navigating into Connections has to get the
   * blocking launcher out of the way, but it is not evidence that setup
   * succeeded. Persisting it there was how the launcher came to vanish for
   * good the moment a user went to *do* the setup — while Connections still
   * read "chat: setup needed" and New Chat still offered no Station agent, and
   * the launcher's own copy promised it "disappears automatically once chat is
   * ready" (archive#794). Deferred state dies with the page, so a reload with chat
   * still unready brings the launcher back, which is what that copy claims.
   */
  private deferredState = false;
  private listeners = new Set<Listener>();

  constructor() {
    // archive#settings-revamp: `dismissedState` used
    // to be copied out of the device store ONCE at construction and never
    // read again, so an import (or a cross-tab change forwarded by the
    // device store's own `storage` listener) that flips
    // `onboardingSetupDismissed` never reached this store's subscribers —
    // the launcher's visibility silently went stale. `getSnapshot` now
    // reads the device store live on every call (cheap — it's just a
    // resolved-snapshot property read), and this subscription forwards the
    // device store's own change notifications to this store's listeners so
    // `useSyncExternalStore` actually re-renders on that path too.
    deviceSettingsStore.subscribe(() => this.notify());
  }

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () =>
    deviceSettingsStore.get('onboardingSetupDismissed') || this.deferredState;

  dismiss = () => {
    if (deviceSettingsStore.get('onboardingSetupDismissed')) return;
    // `deviceSettingsStore.set` notifies its own subscribers synchronously,
    // which (via the constructor's subscription above) already calls this
    // store's `notify` — no separate call needed here.
    deviceSettingsStore.set('onboardingSetupDismissed', true);
  };

  /**
   * Hide the launcher while the user is off completing setup, without
   * claiming readiness.
   */
  defer = () => {
    if (this.deferredState) return;
    this.deferredState = true;
    this.notify();
  };

  /**
   * Undo a deferral once the user has left the surface they were sent to.
   * Without this the launcher stays hidden for the whole session — a user who
   * abandons setup partway and navigates elsewhere would never see it again
   * even though chat is still unready, which is a session-scoped version of
   * the same bug (archive#794). A persisted `dismiss` is untouched.
   */
  rearm = () => {
    if (!this.deferredState) return;
    this.deferredState = false;
    this.notify();
  };

  reset = () => {
    const wasHidden =
      deviceSettingsStore.get('onboardingSetupDismissed') || this.deferredState;
    // A no-op device-store reset (already at default) does not notify on
    // its own, so `deferredState`'s clear below still needs its own
    // unconditional notify when anything was actually hidden.
    deviceSettingsStore.reset('onboardingSetupDismissed');
    this.deferredState = false;
    if (!wasHidden) return;
    this.notify();
  };

  private notify() {
    this.listeners.forEach((listener) => listener());
  }
}

export const onboardingSetupStore = new OnboardingSetupStore();

/**
 * Whether Home's first-run chapter currently owns the screen
 *
 * ONE piece of state, read by both first-run overlays, so at most one of them
 * can exist. The chapter used to consult `isBlockingFullScreen` only at its
 * one-shot auto-open, while `OnboardingGate` independently re-mounted the
 * launcher whenever the probe flapped back to `cannot_verify` — so a
 * `ready → cannot_verify` transition AFTER the chapter opened produced both,
 * with the launcher stranded underneath the chapter's scrim. That is the
 * inaccessible-under-a-scrim class this branch exists to remove.
 *
 * Module-level and in-memory, matching `OnboardingSetupStore` above: it is a
 * property of what is on screen right now, not of the device or the home.
 */
class FirstRunChapterPresence {
  private open = false;
  private listeners = new Set<Listener>();

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.open;

  set = (open: boolean) => {
    if (this.open === open) return;
    this.open = open;
    this.listeners.forEach((listener) => listener());
  };
}

export const firstRunChapterPresence = new FirstRunChapterPresence();

export function useFirstRunChapterOpen(): boolean {
  return useSyncExternalStore(
    firstRunChapterPresence.subscribe,
    firstRunChapterPresence.getSnapshot,
    firstRunChapterPresence.getSnapshot,
  );
}

export interface OnboardingSetupState {
  /** Whether the setup banner content should currently render at all. */
  visible: boolean;
  /**
   * True only for the true first-run case (`visible && !dismissed`) — today
   * the only setup-banner presentation is the full-screen `SetupLauncher`,
   * so this is identical to `visible`. Kept as its own field so a future
   * non-blocking banner variant can diverge from it without another
   * readiness derivation.
   */
  isBlockingFullScreen: boolean;
  /**
   * What the PROBE says about the launcher, before the first-run chapter's
   * suppression is applied
   *
   * The chapter's own auto-open gate reads this, not `visible`: `visible` is
   * false *because the chapter is open*, so gating on it would be circular.
   * Nothing else should — a consumer asking "is the launcher on screen" wants
   * `visible`, which is the one that can answer honestly.
   */
  launcherWouldShow: boolean;
  content: SetupBannerContent | null;
  /**
   * Connect is genuinely FINISHED — the user made a durable choice to skip it,
   * or the system reports setup complete.
   *
   * Deliberately NOT `!visible` (archive#2652). `visible`
   * is also false for a `defer`, and `defer` is what the launcher's own
   * "Open Connections" / action-target buttons call — the user who is actively
   * DOING the setup. Reading hidden as resolved therefore fires on the primary
   * setup path, mid-setup. It is also false while `status` is momentarily
   * absent, which is a loading state, not a resolution.
   *
   * Anything that gates on "the first-run connect chapter is behind us" must
   * read this, not the launcher's visibility.
   */
  resolved: boolean;
  /** Persisted "do not show me this again". */
  dismiss: () => void;
  /**
   * Hide the launcher while the user completes setup elsewhere, which must not
   * be recorded as if setup had succeeded (archive#794).
   */
  defer: () => void;
  /** Undo a deferral once the user has left that surface (archive#794). */
  rearm: () => void;
}

/**
 * The one presentation decision shared by the launcher and route overlays.
 * Keeping it here prevents a hidden launcher from also hiding the only route
 * content beneath it.
 */
export function shouldRenderSetupLauncher({
  credentialRequired,
  setupVisible,
  setupContent,
  pathname,
}: {
  credentialRequired: boolean;
  setupVisible: boolean;
  setupContent: SetupBannerContent | null;
  pathname: string;
}): boolean {
  return (
    !credentialRequired &&
    setupVisible &&
    setupContent !== null &&
    !pathname.startsWith('/connections')
  );
}

/**
 * Whether the STANDALONE usage-telemetry disclosure modal may mount.
 *
 * Same rule as the launcher above, applied to the third overlay that reaches
 * the first screen: at most one at a time. `OnboardingGate` renders it after
 * its children, so it lands on top of whatever else is up — on a fresh home
 * that was the first-run chapter, two modals deep, with the one underneath
 * unreadable (reproduced live). Two things follow:
 *
 * - On a `pending` home the disclosure is the first STEP of the first-run
 *   chapter (`UsageTelemetryDisclosureStep`), so this modal must not exist at
 *   all; mounting it would be the same interruption by another route.
 * - Everywhere else — an upgraded home, a deferred one, a completed one — the
 *   modal is exactly what shipped, except that it waits for the launcher and
 *   for a chapter opened from Home's card to be out of the way first.
 */
export function shouldRenderUsageTelemetryDisclosure({
  firstRunStatus,
  setupLauncherVisible,
  firstRunChapterOpen,
}: {
  firstRunStatus: string | undefined;
  setupLauncherVisible: boolean;
  firstRunChapterOpen: boolean;
}): boolean {
  if (firstRunStatus === 'pending') return false;
  return !setupLauncherVisible && !firstRunChapterOpen;
}

export function useOnboardingSetupState(): OnboardingSetupState {
  const { data: status } = useSystemStatus();
  const dismissed = useSyncExternalStore(
    onboardingSetupStore.subscribe,
    onboardingSetupStore.getSnapshot,
    onboardingSetupStore.getSnapshot,
  );
  const chapterOpen = useFirstRunChapterOpen();
  const launcherWouldShow =
    !!status && shouldShowSetupBanner(status) && !dismissed;
  // AT MOST ONE FIRST-RUN OVERLAY. The chapter is the newer, modal surface and
  // it is already on top; a launcher rendered under its scrim is unreachable,
  // which is worse than not rendering it at all. When the chapter closes this
  // flips back, so a Station that genuinely still needs connecting gets its
  // launcher the moment the chapter is out of the way.
  const visible = launcherWouldShow && !chapterOpen;
  const content = status ? buildSetupBannerContent(status) : null;
  // Read the DURABLE dismissal, not `dismissed` above — that one folds in the
  // page-lifetime `deferredState`, which is exactly the mid-setup signal this
  // must not treat as a resolution. Reading the device store here is live and
  // reactive: this hook already re-renders on its changes via the
  // `useSyncExternalStore` subscription above.
  const resolved =
    deviceSettingsStore.get('onboardingSetupDismissed') === true ||
    (!!status && !shouldShowSetupBanner(status));

  return {
    visible,
    isBlockingFullScreen: visible,
    launcherWouldShow,
    resolved,
    content,
    dismiss: onboardingSetupStore.dismiss,
    defer: onboardingSetupStore.defer,
    rearm: onboardingSetupStore.rearm,
  };
}
