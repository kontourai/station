import { useSyncExternalStore } from 'react';

export type BannerTone = 'info' | 'warning' | 'error' | 'blocked';

type BannerActionBase = {
  label: string;
  /** Transfers the action to another dialog or a visible outcome surface. */
  closesDetails?: boolean;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  /**
   * Overrides the accessible name (`aria-label`) while `label` stays the
   * short VISIBLE text. Optional — most actions' visible label already is
   * their accessible name. The one case that needs it: a control whose
   * label toggles between two short, ambiguous-out-of-context words
   * ("Remove"/"Confirm") for a two-step destructive confirm — a screen
   * reader user landing on "Confirm" with no visible surrounding sentence
   * has no way to know what it confirms. `ariaLabel` carries the full
   * sentence ("Remove connection"/"Confirm removing this connection")
   * without growing the on-screen button.
   */
  ariaLabel?: string;
  /**
   * Fires when this control loses focus. Optional and rarely needed — the
   * one real use today is a two-step destructive confirm (archive#4470's
   * "Remove connection") disarming itself when the reader looks away
   * without following through, mirroring `PairedDeviceList`'s inline revoke
   * confirm. Not called on dismiss/unmount; sources that need a "the
   * question went away" signal already get one from their own effect
   * cleanup.
   */
  onBlur?: () => void;
};

/**
 * An action either does something or goes somewhere — never neither, which
 * would render an enabled control that silently does nothing.
 *
 * `href` renders a real anchor rather than a scripted open: an Android
 * WebView may ignore `window.open('_blank')`, and an anchor is the shape the
 * rest of the UI already uses for outbound URLs.
 */
export type BannerAction =
  | (BannerActionBase & { onClick: () => void; href?: never })
  | (BannerActionBase & { href: string; onClick?: never });

export type BannerPhase = 'live';

export type BannerItem = {
  id: string;
  /** Identifies the source condition instance. */
  occurrence?: string;
  /** Higher sorts first (renders above lower-priority items). */
  priority: number;
  tone: BannerTone;
  /**
   * The one line that is always visible. Keep it to a sentence: on a phone
   * this is chrome sitting above the content the reader came for.
   */
  message: string;
  /**
   * Supporting context shown in Station details or the owning setup view.
   */
  detail?: string;
  badge?: string;
  actions?: BannerAction[];
  dismissible?: boolean;
  dismissAriaLabel?: string;
  onDismiss?: () => void;
  /** Connection progress is informative; do not interrupt current work. */
  ariaLive?: 'polite' | 'assertive' | 'off';
  /** Internal registry state. */
  phase?: BannerPhase;
};

export const BANNER_PRIORITY = {
  connectionBlocking: 100,
  versionMismatch: 90,
  connectionTransient: 80,
  capabilityFailure: 70,
  setup: 40,
  info: 10,
} as const;

export const BANNER_IDS = {
  homeRecovery: 'chrome:home-recovery',
  offline: 'chrome:connection:offline',
  compat: 'chrome:connection:compat',
  credential: 'chrome:onboarding:credential',
  deviceConnection: 'chrome:onboarding:device-connection',
  pairingFailure: 'chrome:onboarding:pairing-failure',
  bundledService: 'chrome:onboarding:bundled-service',
  deferredCapability: 'chrome:capability',
  pluginRegistry: 'chrome:plugins:registry',
  updateCheck: 'chrome:update:check',
  updateAvailable: 'chrome:update:available',
  serverOlder: 'chrome:update:server-older',
} as const;

export type BannerPresentInput = Omit<BannerItem, 'phase'>;

/** Live local conditions. Sources remove entries only when their condition clears. */
class BannerStore {
  private items = new Map<string, BannerItem>();
  private listeners = new Set<() => void>();
  private snapshot: BannerItem[] = [];

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  private notify() {
    this.snapshot = [...this.items.values()].sort(
      (a, b) => b.priority - a.priority || a.id.localeCompare(b.id),
    );
    for (const listener of this.listeners) listener();
  }

  present(item: BannerPresentInput) {
    this.items.set(item.id, { ...item, phase: 'live' });
    this.notify();
  }

  dismiss(id: string) {
    if (this.items.delete(id)) this.notify();
  }

  clear(prefix?: string) {
    let changed = false;
    for (const id of this.items.keys()) {
      if (!prefix || id.startsWith(prefix)) {
        this.items.delete(id);
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  reset() {
    this.clear();
  }
}

export const bannerStore = new BannerStore();

export function useBanners(): BannerItem[] {
  return useSyncExternalStore(bannerStore.subscribe, bannerStore.getSnapshot);
}
