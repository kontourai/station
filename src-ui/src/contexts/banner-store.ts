import { useSyncExternalStore } from 'react';

export type BannerTone = 'info' | 'warning' | 'error' | 'blocked';

type BannerActionBase = {
  label: string;
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

export type BannerPhase = 'live' | 'exiting';

export type BannerItem = {
  id: string;
  /** Identifies the source condition instance for user-dismissal suppression. */
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
   * Everything that did not earn a permanent line — the remedy, the address,
   * the caveats. Rendered behind a "More" disclosure (archive#3297), so a
   * banner can be one line without the detail being lost.
   *
   * A banner with no `detail` renders no disclosure at all: an expander that
   * reveals nothing is worse than no expander.
   */
  detail?: string;
  badge?: string;
  actions?: BannerAction[];
  dismissible?: boolean;
  dismissAriaLabel?: string;
  onDismiss?: () => void;
  /**
   * Float over the content area instead of reserving space for it.
   *
   * The default is to RESERVE: the host measures the space it occupies and
   * the content area is inset by exactly that much (see
   * `bannerReservedHeight` and `--banner-stack-height`), so a banner never
   * covers the top of the view underneath it. That is the correct default
   * because every banner this store carries describes a durable state — a
   * failed connection, an incompatible host, a required credential — which
   * stays on screen until the condition clears or the user acts on it.
   * Content permanently hidden behind one is a defect, not a trade.
   *
   * `overlay: true` is for the opposite case: a notice that will clear
   * itself without the reader doing anything, where a reflow of the whole
   * content area at present and again at dismiss costs more than the
   * momentary occlusion. No source sets it today — transient reachability
   * was deliberately moved out of this host and onto the connection
   * indicator (archive#3297). It exists so that choice is a stated one at
   * the banner, rather than an accident of the host's CSS applying to
   * everything at once, which is how the overlap this fixes arrived.
   */
  overlay?: boolean;
  /**
   * Internal: the user has collapsed this banner to its minimal bar. Sources
   * do not set it (it is excluded from `BannerPresentInput`) — the host
   * toggles it through `bannerStore.setCollapsed`, and the store stamps it
   * onto the snapshot from durable per-occurrence state so a source that
   * re-presents the same banner on every poll does not keep re-opening it.
   */
  collapsed?: boolean;
  /**
   * Fires when the reader taps the card's own collapse chevron TO collapse
   * it (never on expand). Optional — most banners have nothing that cares.
   * archive#4470's two-step "Remove connection" confirm uses it: the
   * confirm's own actions render regardless of `collapsed` (a collapsed
   * card still shows its actions row), so an armed confirm was reachable
   * behind the collapse chevron too — collapsing while armed now disarms
   * the confirm, on the theory that a reader collapsing a pending
   * destructive confirm is cancelling it, not asking to keep it live off
   * screen.
   */
  onCollapse?: () => void;
  /** When true, host applies data-tauri-drag-region (desktop title-bar strip). */
  dragRegion?: boolean;
  /**
   * True when the condition this banner reports IS the user's own action —
   * this navigation, this click — rather than a background condition the
   * app discovered on its own (a dropped connection, a version mismatch, a
   * failed capability). It does not change `tone` or `priority`: a redirect
   * notice for an empty Board is still merely informational. It only breaks
   * a TIE within one priority tier (`sortBanners`, archive#3823), so a
   * notice caused by what the reader just did is not buried behind stale
   * passive chrome that accumulated earlier in the session and happens to
   * share its priority band — while a genuinely higher-priority passive
   * banner (e.g. `connectionBlocking`) is untouched by this field and still
   * wins, exactly as before.
   *
   * Set this from the presenter that reacted to the user's own action
   * (e.g. the route guard that just redirected them). Never infer it from
   * anything else — an id, a message string, a priority band — none of
   * those actually mean "the user caused this."
   */
  userInitiated?: boolean;
  /** Connection progress is informative; do not interrupt current work. */
  ariaLive?: 'polite' | 'assertive' | 'off';
  /** Internal: live vs exit-animating. Sources should not set this. */
  phase?: BannerPhase;
};

/**
 * Priority bands (higher first):
 * - connectionBlocking (100) — credential / pairing required
 * - versionMismatch (90) — incompatible host/client contract
 * - connectionTransient (80) — unreachable / reconnecting
 * - capabilityFailure (70) — a capability failed while the connection is healthy
 * - setup (40) — first-run setup (reserved; launcher still bottom-right)
 * - info (10) — general notices
 */
export const BANNER_PRIORITY = {
  connectionBlocking: 100,
  versionMismatch: 90,
  connectionTransient: 80,
  capabilityFailure: 70,
  setup: 40,
  info: 10,
} as const;

/** Ordered band names for documentation and tests (highest first). */
export const BANNER_PRIORITY_BANDS = [
  'connectionBlocking',
  'versionMismatch',
  'connectionTransient',
  'capabilityFailure',
  'setup',
  'info',
] as const satisfies ReadonlyArray<keyof typeof BANNER_PRIORITY>;

/** Exit animation budget — keep in lockstep with BannerHost.css. */
export const BANNER_EXIT_MS = 160;

/** Stable ids for chrome sources — sources dismiss their own ids on cleanup. */
export const BANNER_IDS = {
  offline: 'chrome:connection:offline',
  compat: 'chrome:connection:compat',
  credential: 'chrome:onboarding:credential',
  deviceConnection: 'chrome:onboarding:device-connection',
  pairingFailure: 'chrome:onboarding:pairing-failure',
  bundledService: 'chrome:onboarding:bundled-service',
  deferredCapability: 'chrome:capability',
  pluginRegistry: 'chrome:plugins:registry',
  resourcePosture: 'chrome:resource-posture',
  updateCheck: 'chrome:update:check',
  updateAvailable: 'chrome:update:available',
} as const;

export type BannerPresentInput = Omit<BannerItem, 'phase' | 'collapsed'>;

/**
 * Public API surface for chrome banners.
 *
 * - `bannerStore.present(item)` / `dismiss(id, { reason })` / `clear(prefix?)`
 * - `useBanners` — live+exiting snapshot, priority-sorted
 * - `useBanner` — present/dismiss helpers for sources
 *
 * Dismiss with `reason: 'user'` runs `onDismiss`. System/cleanup dismisses
 * must omit reason (or use `system`) so effect teardowns do not latch or
 * release suppression. A dismissible banner without an occurrence is keyed
 * by id alone and remains suppressed until `clear`/`reset`.
 *
 * `bannerStore.setCollapsed(id, collapsed)` is the host's own control, not a
 * source affordance, so it is deliberately absent here.
 */
export function useBanner() {
  return {
    present: (item: BannerPresentInput) => bannerStore.present(item),
    dismiss: (id: string, opts?: { reason?: 'user' | 'system' }) =>
      bannerStore.dismiss(id, opts),
    clear: (prefix?: string) => bannerStore.clear(prefix),
  };
}

/**
 * Durable dismissals (SHELL-10: "dismissing it does not clear the notice —
 * after a reload the dismissed banner is back").
 *
 * ONLY banners that carry an `occurrence` are persisted, and that is the
 * whole safety argument. `occurrence` is the source's own statement of "this
 * is the same thing I said last time"; a changed condition is a changed
 * occurrence, so a durable dismissal expires by itself the moment there is
 * something new to read. A banner with NO occurrence is keyed by id alone,
 * and persisting THAT would mean the banner never comes back — the trap this
 * class already names for `userCollapsed` below. Session-scoped suppression
 * remains exactly as it was for those.
 */
const DISMISSED_STORAGE_KEY = 'station.banners.dismissed';
/** Bounds the record: dismissals are a working set, not a history. */
const DISMISSED_STORAGE_LIMIT = 50;

function loadDurableDismissals(): Map<string, string> {
  const durable = new Map<string, string>();
  if (typeof window === 'undefined') return durable;
  try {
    const raw = window.localStorage.getItem(DISMISSED_STORAGE_KEY);
    if (!raw) return durable;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return durable;
    }
    for (const [id, occurrence] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      // A non-string value would re-enter the store as an id-only dismissal,
      // which is the one shape that must never be durable.
      if (typeof occurrence === 'string') durable.set(id, occurrence);
    }
  } catch {
    // Unavailable or malformed storage means no durable dismissals, never a
    // banner that fails to present.
  }
  return durable;
}

class BannerStore {
  private items = new Map<string, BannerItem>();
  private listeners = new Set<() => void>();
  private snapshot: BannerItem[] = [];
  private exitTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private userDismissed = new Map<string, string | undefined>(
    loadDurableDismissals(),
  );
  /**
   * id → the occurrence that was collapsed. Keyed exactly like
   * `userDismissed` (archive#3308's suppression keying) so the two decisions
   * a user can make about a banner expire together: a NEW occurrence of the
   * same condition is a new thing to read, so it arrives expanded, while the
   * same occurrence re-presented on every poll stays as the user left it.
   *
   * Same trap as dismissal, and worth naming because it is the one I hit in
   * archive#3498: a banner with NO occurrence is keyed by id alone, so its
   * collapsed state survives until `clear`/`reset`. For collapse that is
   * benign (the banner is still on screen, still named, still actionable) —
   * unlike dismissal, where it means the banner never comes back.
   */
  private userCollapsed = new Map<string, string | undefined>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  private notify() {
    // `collapsed` is stamped here rather than stored on the item, so a source
    // re-presenting the same banner cannot clear it and does not have to know
    // it exists. Identity is preserved when the flag is unchanged, so React
    // still bails out of re-rendering an untouched card.
    this.snapshot = sortBanners([...this.items.values()]).map((item) => {
      const collapsed = this.isCollapsed(item);
      return collapsed === (item.collapsed ?? false)
        ? item
        : { ...item, collapsed };
    });
    for (const listener of this.listeners) listener();
  }

  private isCollapsed(item: BannerItem): boolean {
    return (
      this.userCollapsed.has(item.id) &&
      this.userCollapsed.get(item.id) === item.occurrence
    );
  }

  /**
   * Collapse or expand one banner. Every banner is collapsible, including a
   * non-dismissible connection-blocking one: archive#3432 made that band
   * non-collapsible in the STACK sense (it must never go behind the cap,
   * where it leaves the DOM and its `role="alert"` never announces), and a
   * banner collapsed to its bar is still mounted, still names the fault, and
   * still carries its actions — so that rule is untouched by this one.
   */
  setCollapsed(id: string, collapsed: boolean) {
    const item = this.items.get(id);
    if (!item) return;
    if (collapsed) {
      if (this.isCollapsed(item)) return;
      this.userCollapsed.set(id, item.occurrence);
    } else {
      if (!this.userCollapsed.has(id)) return;
      this.userCollapsed.delete(id);
    }
    this.notify();
  }

  present(item: BannerPresentInput) {
    if (this.userDismissed.has(item.id)) {
      if (this.userDismissed.get(item.id) === item.occurrence) return;
      this.userDismissed.delete(item.id);
      this.writeDurableDismissals();
    }
    if (
      this.userCollapsed.has(item.id) &&
      this.userCollapsed.get(item.id) !== item.occurrence
    ) {
      this.userCollapsed.delete(item.id);
    }
    this.clearExitTimer(item.id);
    const next: BannerItem = { ...item, phase: 'live' };
    const prev = this.items.get(item.id);
    if (
      prev &&
      prev.phase === 'live' &&
      prev.priority === next.priority &&
      prev.tone === next.tone &&
      prev.message === next.message &&
      prev.detail === next.detail &&
      prev.occurrence === next.occurrence &&
      prev.badge === next.badge &&
      prev.dismissible === next.dismissible &&
      prev.dismissAriaLabel === next.dismissAriaLabel &&
      prev.dragRegion === next.dragRegion &&
      prev.overlay === next.overlay &&
      prev.ariaLive === next.ariaLive &&
      actionsEqual(prev.actions, next.actions)
    ) {
      return;
    }
    this.items.set(item.id, next);
    this.notify();
  }

  /**
   * Remove a banner. User dismiss runs exit animation then `onDismiss`.
   * System dismiss removes immediately (source cleanup / replace).
   */
  dismiss(id: string, opts?: { reason?: 'user' | 'system' }) {
    const item = this.items.get(id);
    if (!item) return;

    if (opts?.reason === 'user' && item.phase !== 'exiting') {
      this.userDismissed.set(id, item.occurrence);
      this.writeDurableDismissals();
      // The user's decision is complete NOW; the exit animation is only
      // presentation. Running onDismiss after the 160ms exit let a system
      // dismiss (profile switch, source teardown) land inside that window,
      // cancel the timer, and silently discard the durable side of the
      // dismissal (archive#2557 finding).
      item.onDismiss?.();
      this.beginExit(item, false);
      return;
    }

    this.clearExitTimer(id);
    this.items.delete(id);
    this.notify();
  }

  clear(prefix?: string) {
    if (!prefix) {
      for (const id of [...this.exitTimers.keys()]) this.clearExitTimer(id);
      const changed =
        this.items.size > 0 ||
        this.userDismissed.size > 0 ||
        this.userCollapsed.size > 0;
      this.items.clear();
      this.userDismissed.clear();
      this.userCollapsed.clear();
      this.writeDurableDismissals();
      if (changed) this.notify();
      return;
    }
    let changed = false;
    for (const id of [...this.items.keys()]) {
      if (id.startsWith(prefix)) {
        this.clearExitTimer(id);
        this.items.delete(id);
        changed = true;
      }
    }
    for (const id of [...this.userDismissed.keys()]) {
      if (id.startsWith(prefix)) {
        this.userDismissed.delete(id);
        changed = true;
      }
    }
    for (const id of [...this.userCollapsed.keys()]) {
      if (id.startsWith(prefix)) {
        this.userCollapsed.delete(id);
        changed = true;
      }
    }
    this.writeDurableDismissals();
    if (changed) this.notify();
  }

  /**
   * Mirrors the occurrence-bearing half of `userDismissed` to storage. Called
   * after every mutation of that map, so the record is a projection of the
   * live state rather than a second source of truth that can drift.
   */
  private writeDurableDismissals() {
    if (typeof window === 'undefined') return;
    const durable: Record<string, string> = {};
    let count = 0;
    for (const [id, occurrence] of this.userDismissed) {
      if (typeof occurrence !== 'string') continue;
      if (count >= DISMISSED_STORAGE_LIMIT) break;
      durable[id] = occurrence;
      count += 1;
    }
    try {
      if (count === 0) {
        window.localStorage.removeItem(DISMISSED_STORAGE_KEY);
      } else {
        window.localStorage.setItem(
          DISMISSED_STORAGE_KEY,
          JSON.stringify(durable),
        );
      }
    } catch {
      // A full or unavailable store degrades to session-scoped suppression.
    }
  }

  /** Test helper */
  reset() {
    for (const id of [...this.exitTimers.keys()]) this.clearExitTimer(id);
    this.items.clear();
    this.userDismissed.clear();
    this.userCollapsed.clear();
    this.writeDurableDismissals();
    this.snapshot = [];
    this.notify();
  }

  /** Test helper: force-complete pending exits immediately. */
  flushExits() {
    for (const [id, timer] of [...this.exitTimers.entries()]) {
      clearTimeout(timer);
      this.exitTimers.delete(id);
      const item = this.items.get(id);
      if (item?.phase === 'exiting') {
        this.items.delete(id);
      }
    }
    this.notify();
  }

  private beginExit(item: BannerItem, runOnDismiss: boolean) {
    const id = item.id;
    if (item.phase === 'exiting') return;
    this.items.set(id, { ...item, phase: 'exiting' });
    this.notify();
    this.clearExitTimer(id);
    this.exitTimers.set(
      id,
      setTimeout(() => {
        this.exitTimers.delete(id);
        const current = this.items.get(id);
        if (current?.phase === 'exiting') {
          this.items.delete(id);
          this.notify();
          if (runOnDismiss) item.onDismiss?.();
        }
      }, BANNER_EXIT_MS),
    );
  }

  private clearExitTimer(id: string) {
    const timer = this.exitTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.exitTimers.delete(id);
    }
  }
}

/**
 * The highest band a user-initiated notice may be lifted into (archive#3823).
 *
 * Derived from `BANNER_PRIORITY`, not chosen: the three bands ABOVE it —
 * `connectionBlocking`, `versionMismatch`, `connectionTransient` — all say
 * something about whether the product can talk to its Station at all, and one
 * of them is frequently the REASON the user's action did not do what they
 * expected. A notice explaining a redirect must never displace the notice
 * explaining that nothing is reaching the server. Everything at or below
 * `capabilityFailure` describes a background condition the app discovered on
 * its own, which is exactly what a notice the reader just caused should be
 * read before.
 */
const USER_INITIATED_PRIORITY_CEILING = BANNER_PRIORITY.capabilityFailure;

/**
 * The priority a banner SORTS at, which is its own except when the user's own
 * action just caused it.
 *
 * A same-tier tiebreak is not enough on its own: every passive chrome source
 * in the app that lingers — deferred capability, the plugin registry gate,
 * resource posture — presents at `capabilityFailure`, and the mobile
 * connection notice at `setup`, while a redirect explanation is merely
 * `info`. Under a tiebreak alone the redirect still sorts below all four and
 * stays behind the bounded stack's "+N more" cap, which is the defect. So a
 * user-initiated notice is lifted to the ceiling above — never past it — and
 * the `userInitiated` tiebreak below then puts it ahead of the passive
 * banners it now ties with.
 *
 * The lift is a SORT-time derivation and never rewrites `priority` itself:
 * `buildBannerStackView`'s `connectionBlocking` band slice reads the raw
 * field, and a lifted banner can never reach that band (the ceiling is
 * strictly below it), so the two cannot disagree about where the band ends.
 */
export function effectiveBannerPriority(item: BannerItem): number {
  return item.userInitiated && item.priority < USER_INITIATED_PRIORITY_CEILING
    ? USER_INITIATED_PRIORITY_CEILING
    : item.priority;
}

export function sortBanners(items: BannerItem[]): BannerItem[] {
  return [...items].sort((a, b) => {
    // Live items keep priority order; exiting items keep their slot so
    // remaining live rows reflow past them without a snap (dual-cursor).
    const aPriority = effectiveBannerPriority(a);
    const bPriority = effectiveBannerPriority(b);
    if (bPriority !== aPriority) return bPriority - aPriority;
    // Within one tier, a banner the user's own action just caused outranks
    // one that nothing the user did produced (archive#3823). This is what
    // decides the lifted notice against the passive `capabilityFailure`
    // banners it now ties with, and it also orders two banners that shared a
    // tier to begin with.
    if (Boolean(a.userInitiated) !== Boolean(b.userInitiated)) {
      return a.userInitiated ? -1 : 1;
    }
    return a.id.localeCompare(b.id);
  });
}

export type BannerStackCap = {
  /** Live banners hidden behind the front banner. */
  hiddenCount: number;
  /** Tone of the first hidden live banner — the cap's edge tint mirrors it. */
  tone: BannerTone;
  /** Hidden live banners carrying `tone`. Names the tint in words. */
  toneCount: number;
};

/**
 * The word each tone contributes to the cap's accessible name. The tint alone
 * is a colour-only severity signal (WCAG 1.4.1) and reaches no screen reader,
 * so the count of banners carrying it is spoken.
 */
/**
 * `blocking` and `informational` are adjectives and read correctly at any
 * count; `error` and `warning` are nouns and must agree with it. This is a
 * user-visible accessible name, so "3 error" is a defect, not a nit.
 */
export const BANNER_TONE_WORD: Record<BannerTone, [one: string, many: string]> =
  {
    blocked: ['blocking', 'blocking'],
    error: ['error', 'errors'],
    warning: ['warning', 'warnings'],
    info: ['informational', 'informational'],
  };

/** Accessible label for the collapsed cap, e.g. "2 more notices, 1 blocking". */
export function bannerStackCapLabel(cap: BannerStackCap): string {
  const noun = cap.hiddenCount === 1 ? 'notice' : 'notices';
  const tone = BANNER_TONE_WORD[cap.tone][cap.toneCount === 1 ? 0 : 1];
  return `${cap.hiddenCount} more ${noun}, ${cap.toneCount} ${tone}`;
}

export type BannerStackView = {
  /** Banners to render, in store priority order. */
  visible: BannerItem[];
  /** Collapsed-only summary of the hidden remainder; null when nothing hides. */
  cap: BannerStackCap | null;
};

function stackCap(hiddenLive: BannerItem[]): BannerStackCap | null {
  const first = hiddenLive[0];
  if (!first) return null;
  return {
    hiddenCount: hiddenLive.length,
    tone: first.tone,
    toneCount: hiddenLive.filter((banner) => banner.tone === first.tone).length,
  };
}

/**
 * Stack view for the overlay host (archive#3308 phase 1). Collapsed shows the
 * front banner plus a cap describing what hides behind it; expanded shows
 * everything. Exiting banners never drive the cap: they are already leaving,
 * so counting or tinting by them would advertise a notice the user is about
 * to not have.
 *
 * archive#3432: the `connectionBlocking` band (credential/pairing-required —
 * states the product does not work without) never collapses. Every banner in
 * that band stays in `visible`, live or exiting; the cap describes only the
 * bands below it. This is a priority-BAND slice, not an index slice, so it
 * holds regardless of how many band members are live at once — a collapsed
 * banner is not in the DOM at all, so its `role="alert"` never announces, and
 * before this rule the band could never express two simultaneous blocking
 * states (one always went behind the cap).
 *
 * When the band is empty, or every member in it is exiting, there is no live
 * band banner to anchor on — fall back to the original single-front
 * selection over the whole stack (first LIVE banner, not `banners[0]`).
 * Under `prefers-reduced-motion` an exiting item is `display: none`, so
 * taking the head unconditionally left the host rendering nothing but its
 * cap for the whole exit budget after the front was dismissed. Exiting
 * banners ahead of the front are still rendered — that is what animates
 * their collapse when motion is allowed, and it costs nothing when it is
 * not.
 */
export function buildBannerStackView(
  banners: readonly BannerItem[],
  expanded: boolean,
): BannerStackView {
  if (banners.length === 0) return { visible: [], cap: null };
  if (expanded) return { visible: [...banners], cap: null };

  const bandEnd = banners.findIndex(
    (banner) => banner.priority < BANNER_PRIORITY.connectionBlocking,
  );
  const bandItems = bandEnd === -1 ? banners : banners.slice(0, bandEnd);
  const rest = bandEnd === -1 ? [] : banners.slice(bandEnd);
  const bandHasLive = bandItems.some((banner) => banner.phase !== 'exiting');

  if (bandHasLive) {
    // Every band member renders, including one that is exiting AFTER a live
    // one — a behaviour change from the old single-front selection, which
    // only ever rendered items up to (and including) the first live index
    // and silently dropped a later exiting sibling with no animation. Now
    // that band membership rather than array position decides `visible`, an
    // exiting band member gets to animate out wherever it sorts.
    return {
      visible: [...bandItems],
      cap: stackCap(rest.filter((banner) => banner.phase !== 'exiting')),
    };
  }

  // Band empty or fully exiting: fall back to whole-stack front selection.
  const frontIndex = banners.findIndex((banner) => banner.phase !== 'exiting');
  // Nothing live left: render the remaining exits so they still animate out.
  if (frontIndex === -1) return { visible: [...banners], cap: null };
  return {
    visible: banners.slice(0, frontIndex + 1),
    cap: stackCap(
      banners
        .slice(frontIndex + 1)
        .filter((banner) => banner.phase !== 'exiting'),
    ),
  };
}

/** One rendered box the host measured, and whether it reserves space. */
export type BannerReserveEntry = {
  /** False for an `overlay` banner — it is measured but claims nothing. */
  reserves: boolean;
  /** Viewport-space bottom edge (`getBoundingClientRect.bottom`). */
  bottom: number;
};

/**
 * Height the content area must be inset by so that no reserving banner
 * covers it — the fix for "banners overlap content" (archive#3308 made the
 * host an overlay, which stopped the app reflowing per banner and, in the
 * same move, put every banner permanently on top of the top of the view).
 *
 * It is derived from live geometry rather than declared, for the reason
 * `--dock-slot-size` already exists next door: a per-view padding constant
 * drifts the moment a banner wraps to two lines, a second banner arrives, or
 * one is collapsed. Measuring the boxes means the inset is correct in every
 * one of those states without any of them being enumerated.
 *
 * The derivation is the BOTTOM-MOST reserving edge, not a sum of heights:
 * space is reserved down to the last banner that wants it, which is what
 * makes a mixed stack behave. An `overlay` banner above a reserving one is
 * inside the reserved region anyway (you cannot clear the lower one without
 * clearing the space the upper one occupies); an `overlay` banner BELOW the
 * last reserving one adds nothing, which is exactly what it asked for. With
 * nothing reserving, the result is 0 and the content area is not inset at
 * all — the host reserves no space when it has nothing to reserve for, the
 * property archive#2268's blank 104px rail lost.
 */
export function bannerReservedHeight(
  hostTop: number,
  entries: readonly BannerReserveEntry[],
): number {
  let bottom = hostTop;
  for (const entry of entries) {
    if (entry.reserves && entry.bottom > bottom) bottom = entry.bottom;
  }
  // A negative reading is not a fact about the layout: it is a box that has
  // not been laid out yet (or a stale rect mid-teardown). Reserve nothing.
  return Math.max(0, bottom - hostTop);
}

function actionsEqual(
  a: BannerAction[] | undefined,
  b: BannerAction[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every(
    (action, i) =>
      action.label === b[i]?.label &&
      action.variant === b[i]?.variant &&
      // Without this, re-presenting the same id with a corrected URL is
      // treated as no change and the action keeps pointing at the old one.
      action.href === b[i]?.href,
  );
}

export const bannerStore = new BannerStore();

/**
 * TEST-ONLY (archive#3823). A Playwright spec drives the real running app
 * through a `Page`, not the module graph, so it cannot `import { bannerStore }`
 * the way every vitest suite in `__tests__/` already does. This exposes the
 * same clearing primitive as a `window` global a spec reaches with
 * `page.evaluate( => window.__stationClearPassiveChromeBannersForTestsOnly?.)`,
 * so a spec whose assertion is about ONE notice it caused itself is not at the
 * mercy of whatever chrome the instance accumulated around it.
 *
 * It clears PASSIVE banners only, and that is not a nicety — it is what makes
 * it safe to call. A blanket `reset` raced with the very thing under test:
 * a spec can only call this AFTER a navigation (the hook does not exist on
 * `about:blank`, and a full page load re-executes the bundle), and by then the
 * notice the spec is waiting for may already have been presented. Clearing on
 * the `userInitiated` field — the same field the sort order derives from —
 * means the call can land at any moment and never remove the banner the
 * reader's own action produced.
 *
 * Nothing in product code reads this property: it is written once, here, and
 * called only by a test reaching for it by this exact name.
 */
declare global {
  interface Window {
    __stationClearPassiveChromeBannersForTestsOnly?: () => void;
  }
}
if (typeof window !== 'undefined') {
  window.__stationClearPassiveChromeBannersForTestsOnly = () => {
    for (const banner of bannerStore.getSnapshot()) {
      if (!banner.userInitiated) {
        bannerStore.dismiss(banner.id, { reason: 'system' });
      }
    }
  };
}

export function useBanners(): BannerItem[] {
  return useSyncExternalStore(bannerStore.subscribe, bannerStore.getSnapshot);
}
