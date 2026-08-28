import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  type BannerItem,
  type BannerReserveEntry,
  bannerReservedHeight,
  bannerStackCapLabel,
  bannerStore,
  buildBannerStackView,
  useBanner,
  useBanners,
} from '../../contexts/banner-store';
import { isModalDialogOpen } from '../../contexts/KeyboardShortcutsContext';
import './BannerHost.css';

/**
 * Custom property the host publishes onto its own container, consumed by
 * `.main-content` in `BannerHost.css`. Named here so the writer and the
 * reader cannot drift apart silently.
 */
export const BANNER_RESERVED_HEIGHT_PROPERTY = '--banner-stack-height';

/** Per-card measured natural height, the expanded end of the collapse tween. */
const BANNER_NATURAL_HEIGHT_PROPERTY = '--banner-natural-height';

const SWIPE_INTENT_PX = 8;
const SWIPE_MIN_DISMISS_PX = 56;
const SWIPE_MAX_DISMISS_PX = 96;

type SwipeGesture = {
  pointerId: number;
  startX: number;
  startY: number;
  axis: 'horizontal' | 'vertical' | null;
};

function swipeDismissThreshold(width: number): number {
  return Math.min(
    SWIPE_MAX_DISMISS_PX,
    Math.max(SWIPE_MIN_DISMISS_PX, width * 0.24),
  );
}

function BannerItemView({ banner }: { banner: BannerItem }) {
  const exiting = banner.phase === 'exiting';
  // An exiting card is mid-flight; forcing it through the collapsed layout on
  // the way out would fight the exit tween for the same height property.
  const collapsed = banner.collapsed === true && !exiting;
  const itemRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<SwipeGesture | null>(null);
  const suppressClickRef = useRef(false);
  const [swipeX, setSwipeX] = useState(0);
  const [isSwiping, setIsSwiping] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  // The disclosure is not rendered while collapsed, so its state is invisible
  // there; keeping it means expanding restores the card the user left.
  const detailVisible = detailOpen && !collapsed;

  /**
   * Measure the card's natural height into a custom property so the collapse
   * can be a real `height` transition (see `BannerHost.css`). `scrollHeight`
   * reports the CONTENT height even while the box is pinned to a smaller
   * height, which is what makes this stable rather than circular: writing the
   * height back does not change what the next measurement reads.
   *
   * Only measured while expanded. Collapsed, the content is clamped to one
   * line, so its `scrollHeight` is the collapsed height — measuring there
   * would overwrite the expanded end of the tween with the collapsed one and
   * the card would never animate back open. The last expanded reading is
   * retained instead, and re-measured on expand before the browser paints.
   *
   * `useLayoutEffect`, not `useEffect`: on expand the class comes off in the
   * same commit, so a passive effect would paint one frame at the stale
   * height and tween in two visible stages.
   *
   * jsdom reports `scrollHeight` 0 and has no `ResizeObserver`; the `> 0`
   * guard means no property is written there and the CSS falls back to
   * `height: auto` — the behaviour every component test already asserts.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: `banner` and `detailVisible` are re-measure triggers, not values this body reads. A `ResizeObserver` only fires when the OBSERVED box changes size, and this box is pinned to the height we ourselves wrote — content growing inside it (a longer message, an action appearing, the detail opening) resizes nothing, so RO never fires and the card stays pinned at a stale height. Re-running on every content change forces the synchronous re-measure that RO cannot deliver; RO then only has to cover what a render cannot see (width, font load). Same reasoning as the stack-scrollable effect below — do not let an automated unsafe-fix pass delete these deps.
  useLayoutEffect(() => {
    const inner = innerRef.current;
    const item = itemRef.current;
    if (!inner || !item || collapsed) return;
    const measure = () => {
      const height = inner.scrollHeight;
      // Written on the card, which is the element the CSS sizes; measured on
      // its content row, which is the only box that knows the natural height.
      if (height > 0) {
        item.style.setProperty(BANNER_NATURAL_HEIGHT_PROPERTY, `${height}px`);
      }
    };
    measure();
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(measure);
    observer?.observe(inner);
    return () => observer?.disconnect();
  }, [collapsed, detailVisible, banner]);

  useEffect(() => {
    if (!banner.dismissible || exiting) return;

    const handlePointerDown = (event: globalThis.PointerEvent) => {
      const item = itemRef.current;
      if (
        !item ||
        event.button !== 0 ||
        event.pointerType === 'mouse' ||
        (event.target instanceof Element &&
          event.target.closest(
            '.banner-host__action, .banner-host__dismiss, .banner-host__disclosure, .banner-host__collapse',
          ) !== null)
      ) {
        return;
      }
      const rect = item.getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      ) {
        return;
      }
      gestureRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        axis: null,
      };
    };

    const handlePointerMove = (event: globalThis.PointerEvent) => {
      const gesture = gestureRef.current;
      const item = itemRef.current;
      if (!gesture || !item || gesture.pointerId !== event.pointerId) return;

      const deltaX = event.clientX - gesture.startX;
      const deltaY = event.clientY - gesture.startY;
      if (gesture.axis === null) {
        if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < SWIPE_INTENT_PX) {
          return;
        }
        gesture.axis =
          Math.abs(deltaX) > Math.abs(deltaY) * 1.15
            ? 'horizontal'
            : 'vertical';
      }
      if (gesture.axis !== 'horizontal') return;

      event.preventDefault();
      setIsSwiping(true);
      const width = item.getBoundingClientRect().width;
      const limit = Math.max(width * 0.92, SWIPE_MAX_DISMISS_PX);
      setSwipeX(Math.max(-limit, Math.min(limit, deltaX)));
    };

    const handlePointerUp = (event: globalThis.PointerEvent) => {
      const gesture = gestureRef.current;
      const item = itemRef.current;
      if (!gesture || !item || gesture.pointerId !== event.pointerId) return;
      gestureRef.current = null;

      if (gesture.axis !== 'horizontal') {
        setIsSwiping(false);
        setSwipeX(0);
        return;
      }

      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
      setIsSwiping(false);
      const width = item.getBoundingClientRect().width;
      const finalSwipeX = event.clientX - gesture.startX;
      if (Math.abs(finalSwipeX) >= swipeDismissThreshold(width)) {
        const direction = finalSwipeX < 0 ? -1 : 1;
        setSwipeX(direction * Math.max(width + 24, SWIPE_MAX_DISMISS_PX));
        bannerStore.dismiss(banner.id, { reason: 'user' });
        return;
      }
      setSwipeX(0);
    };

    const handlePointerCancel = () => {
      gestureRef.current = null;
      setIsSwiping(false);
      setSwipeX(0);
    };
    const handleClick = (event: MouseEvent) => {
      if (!suppressClickRef.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('pointermove', handlePointerMove, {
      capture: true,
      passive: false,
    });
    window.addEventListener('pointerup', handlePointerUp, true);
    window.addEventListener('pointercancel', handlePointerCancel, true);
    window.addEventListener('click', handleClick, true);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('pointermove', handlePointerMove, true);
      window.removeEventListener('pointerup', handlePointerUp, true);
      window.removeEventListener('pointercancel', handlePointerCancel, true);
      window.removeEventListener('click', handleClick, true);
    };
  }, [banner.dismissible, banner.id, exiting]);

  const style = {
    '--banner-swipe-x': `${swipeX}px`,
  } as CSSProperties;

  return (
    <div
      ref={itemRef}
      className={[
        'banner-host__item',
        `banner-host__item--${banner.tone}`,
        banner.dismissible ? 'banner-host__item--dismissible' : '',
        isSwiping ? 'banner-host__item--swiping' : '',
        collapsed ? 'banner-host__item--collapsed' : '',
        exiting ? 'banner-host__item--exiting' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      role={banner.ariaLive === 'polite' ? 'status' : 'alert'}
      aria-live={banner.ariaLive}
      data-banner-id={banner.id}
      data-phase={banner.phase ?? 'live'}
      data-collapsed={collapsed || undefined}
      /* Read back by the host's reservation measurement — an overlay banner
         is measured like any other and then contributes nothing. */
      data-overlay={banner.overlay || undefined}
      data-swipe-dismissible={banner.dismissible || undefined}
      aria-hidden={exiting || undefined}
      style={style}
      {...(banner.dragRegion && !exiting
        ? { 'data-tauri-drag-region': true }
        : {})}
    >
      <div className="banner-host__item-inner" ref={innerRef}>
        <div className="banner-host__message">
          {banner.badge ? (
            <span className="banner-host__badge">{banner.badge}</span>
          ) : null}
          {banner.badge ? ' ' : null}
          {banner.message}
          {/* archive#3297: one line, tap to expand. The detail is rendered
              inside the message cell so it wraps under the summary rather
              than fighting the action column for width.

              Collapsed, the disclosure is not rendered at all rather than
              hidden with CSS: a focusable control inside a clipped box is
              reachable by keyboard and invisible on screen.

              station#4470b (review round): the label used to toggle
              "More"/"Less" — the same verb pair the card-level collapse
              control's OWN accessible name uses ("Expand notice"/"Collapse
              notice"), which is what made this read as a second collapse
              affordance rather than the unrelated "reveal more text"
              control it is. The owner's acceptance was literally "one
              collapse affordance" — the label now stays the constant noun
              "Details" (what it reveals, not a verb that mirrors expand/
              collapse), and only a small directional indicator — its own
              class, its own glyph shape, distinct from `.banner-host__chevron`
              — carries the open/closed state, exactly like the card
              chevron does for the card, but unmistakably a different
              control. `aria-expanded` already carries the state for
              assistive tech regardless of the visible label. */}
          {banner.detail && !collapsed ? (
            <>
              {' '}
              <button
                type="button"
                className="banner-host__disclosure"
                aria-expanded={detailVisible}
                disabled={exiting}
                onClick={() => setDetailOpen((open) => !open)}
              >
                Details
                <span
                  className="banner-host__disclosure-caret"
                  aria-hidden="true"
                />
              </button>
              {detailVisible ? (
                <span className="banner-host__detail">{banner.detail}</span>
              ) : null}
            </>
          ) : null}
        </div>
        {(banner.actions ?? []).length > 0 ? (
          <div className="banner-host__actions">
            {(banner.actions ?? []).map((action, index) => {
              const className = `banner-host__action banner-host__action--${action.variant ?? 'secondary'}`;
              // Keyed by POSITION, not `action.label`: a two-step destructive
              // confirm (archive#4470's "Remove connection") relabels its own
              // button in place ("Remove connection" -> "Confirm removal")
              // rather than swapping in a second control, and a label is not
              // stable identity for a control whose whole point is that its
              // label changes. Keying on it would unmount/remount the
              // button on every arm/disarm, losing focus (and risking a
              // spurious blur mid-transition) for no benefit — the action
              // LIST's order is stable within one banner, which is what a
              // positional key needs to be safe.
              return action.href ? (
                <a
                  key={index}
                  className={className}
                  href={action.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-disabled={exiting || undefined}
                  aria-label={action.ariaLabel}
                >
                  {action.label}
                </a>
              ) : (
                <button
                  key={index}
                  type="button"
                  className={className}
                  disabled={exiting}
                  onClick={action.onClick}
                  onBlur={action.onBlur}
                  aria-label={action.ariaLabel}
                >
                  {action.label}
                </button>
              );
            })}
          </div>
        ) : null}
        {/* Collapse and dismiss share one cell so the card's grid keeps three
            columns whether or not the banner is dismissible — an extra `auto`
            track with nothing in it still pays the column gap. */}
        <div className="banner-host__controls">
          <button
            type="button"
            className="banner-host__collapse"
            aria-expanded={!collapsed}
            /* No `aria-controls`: the only element that could name is the
               card body this button sits INSIDE, and a control pointing at
               its own ancestor is worse than `aria-expanded` on its own,
               which is what actually gets announced. */
            aria-label={collapsed ? 'Expand notice' : 'Collapse notice'}
            title={collapsed ? 'Expand' : 'Collapse'}
            disabled={exiting}
            onClick={() => {
              const nextCollapsed = !collapsed;
              bannerStore.setCollapsed(banner.id, nextCollapsed);
              // archive#4470: fires only on the COLLAPSING press, never on
              // expand — `onCollapse`'s own contract (banner-store.ts).
              if (nextCollapsed) banner.onCollapse?.();
            }}
          >
            <span className="banner-host__chevron" aria-hidden="true" />
          </button>
          {banner.dismissible ? (
            <button
              type="button"
              className="banner-host__dismiss"
              aria-label={banner.dismissAriaLabel ?? 'Dismiss notice'}
              title={banner.dismissAriaLabel ?? 'Dismiss'}
              disabled={exiting}
              onClick={() => bannerStore.dismiss(banner.id, { reason: 'user' })}
            >
              ×
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Chrome-banner overlay under the app toolbar (archive#3308 phase 1).
 *
 * Sources: `useBanner.present` / `bannerStore.present` with a stable id
 * and `BANNER_PRIORITY` band. Host owns stack order, exit reflow, and dismiss.
 * See `BANNER_PRIORITY_BANDS` for the ordered priority table.
 *
 * The host is absolutely positioned over `.main-content` and PUBLISHES the
 * height it occupies as `--banner-stack-height`, which `.main-content` uses
 * to inset itself by exactly that much. Two things follow, and both were the
 * point: the host still owns its own box (no in-flow rail, no per-banner
 * layout row, and nothing reserved when the store is empty — the archive#2268
 * defect was a blank 104px rail on mobile), and content is never underneath
 * it. The overlay-only version of this host had the second property
 * backwards: it never reflowed, and in exchange it permanently covered the
 * top of the view for every banner that describes a durable state, which is
 * all of them. A banner opts out with `overlay: true` (see the field's own
 * docblock) — none does today.
 *
 * Each banner is individually collapsible to a minimal bar, blocking ones
 * included: collapsing keeps the card mounted, named and actionable, so
 * archive#3432's "the connectionBlocking band never collapses" rule — which
 * is about going behind the stack cap, where a card leaves the DOM and its
 * `role="alert"` never announces — is untouched. Multiple banners collapse
 * to the front banner (or, inside the
 * `connectionBlocking` band, every live band member — archive#3432) plus a
 * stack cap tinted by the first hidden banner's severity; the cap expands
 * the stack into a bounded, internally-scrolling list.
 *
 * `view.visible` renders inside `.banner-host__stack`, a dedicated child
 * that owns the bound and the scroll — never the host itself. The host stays
 * `pointer-events: none` and un-bounded in every state so it never reserves
 * or covers space its content doesn't occupy; only the stack (sized to its
 * own content, capped at a max-height) and the cap button opt back into
 * pointer events, for exactly the box they render.
 * `.banner-host__item` is `flex-shrink: 0` so a card is never compressed to
 * fit the bound — real overflow is what makes the stack's `overflow-y: auto`
 * engage (archive#3432; before this, flex children shrank to fit instead of
 * overflowing, so the scroll declaration was inert and content silently
 * clipped).
 *
 * archive#3432: the stack's own `pointer-events: auto` opt-in is
 * conditional on `stackScrollable` below, DERIVED from a real `scrollHeight`
 * vs `clientHeight` comparison (via `ResizeObserver`), not asserted from
 * being in a bounded mode. A bounded stack with nothing to scroll — the
 * common case — stays `pointer-events: none` end to end, so it costs the app
 * underneath it nothing; only a stack that is genuinely scrolling takes
 * pointer events across its box, and only for as long as it is.
 */
export function BannerHost({
  connectionSlot = false,
}: {
  /**
   * Bounds and scrolls the stack. It does not reserve a fixed slot: an empty
   * host renders nothing at all, on every viewport, and the space the content
   * area gives up is the space the live cards actually occupy.
   */
  connectionSlot?: boolean;
}) {
  const banners = useBanners();
  const [expanded, setExpanded] = useState(false);
  const hostRef = useRef<HTMLElement>(null);
  const [stackNode, setStackNode] = useState<HTMLDivElement | null>(null);
  const stackRef = useCallback((node: HTMLDivElement | null) => {
    setStackNode(node);
  }, []);
  const [stackScrollable, setStackScrollable] = useState(false);
  const reservedTargetRef = useRef<HTMLElement | null>(null);

  const liveCount = banners.filter(
    (banner) => banner.phase !== 'exiting',
  ).length;

  // biome-ignore lint/correctness/useExhaustiveDependencies: banners/expanded are intentional triggers (archive#3432) — the body reads live DOM geometry, not either value, but ResizeObserver alone misses a box already pinned at its cap; re-running the effect on every banner-set/mode change forces a synchronous re-measure that does not depend on RO firing. This suppression comment is the only thing standing between this list and `biome check --write --unsafe`, whose FIXABLE suggestion for this diagnostic is to remove the extra deps — do not let an automated unsafe-fix pass delete `banners`/`expanded` here.
  useEffect(() => {
    if (!stackNode) {
      setStackScrollable(false);
      return;
    }
    // archive#3432: `pointer-events: auto` is granted only when the
    // stack ACTUALLY has something to scroll — `ResizeObserver` fires on
    // every real layout change (content added/removed, the expanded/
    // connection-slot bound switching, a card's own height changing), so
    // this tracks the real box, not a declared mode. A 1px tolerance absorbs
    // sub-pixel layout rounding without letting a stack that merely touches
    // its bound (no overflow at all) read as scrollable.
    //
    // archive#3432: `ResizeObserver` only fires when the
    // OBSERVED BOX's own size changes. Once the stack is already pinned at
    // its `max-height` cap, adding more content grows `scrollHeight` without
    // moving `clientHeight` at all — no resize, no callback, and the class
    // gets stuck non-scrollable while content keeps overflowing. Listing
    // `banners`/`expanded` as deps (not just `stackNode`) re-runs `measure`
    // synchronously on every banner-set or mode change regardless of whether
    // RO fires; RO then only has to cover the layout changes a render can't
    // (font load, viewport resize). The extra `measure` call costs two
    // integer reads per render, and React bails out of the re-render when
    // the derived boolean comes out unchanged.
    //
    // `expanded` in this dep list is defensible symmetry with `banners`, not
    // a load-bearing trigger any test exercises: toggling it swaps the cap
    // between `40vh` and `min(48dvh, 520px)`, which resizes the observed box
    // (and so fires RO on its own) at every viewport height except exactly
    // 1300px, where `0.4*1300 === min(0.48*1300, 520)`. No fixture here uses
    // a 1300px-tall viewport, so nothing currently discriminates this dep —
    // keep it rather than "clean it up" on the belief it was proven needed.
    //
    // jsdom (component tests) has no `ResizeObserver`; matching the repo's
    // `ResponsiveDialogSurface.tsx` precedent for the feature-detect only —
    // that surface also pairs its observer with a `window` resize listener
    // and `useLayoutEffect`, neither of which this effect carries over: a
    // cap change here already resizes the observed box itself (nothing a
    // window-resize listener would catch that RO wouldn't), and
    // `useEffect`'s one-frame-later commit costs at most a single frame of
    // `pointer-events: none` on a stack that overflows at first paint —
    // cheaper than the layout-effect cost of matching the dialog exactly.
    // Where `ResizeObserver` is absent, the stack never reports itself
    // scrollable, which also means it is never actually scrollable: nothing
    // is watching for the crossing, so a genuinely overflowing stack stays
    // click-through at its cap, unreachable by wheel or touch — not a
    // fallback, a real gap. No real target lacks `ResizeObserver` (Chrome
    // 64+, Safari 13.1+, Firefox 69+; Tauri's WKWebView, WebView2, and
    // WebKitGTK all have it), so this only applies inside jsdom.
    const measure = () => {
      setStackScrollable(stackNode.scrollHeight > stackNode.clientHeight + 1);
    };
    measure();
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(measure);
    observer?.observe(stackNode);
    return () => observer?.disconnect();
  }, [stackNode, banners, expanded]);

  /**
   * Publish the space the stack occupies onto the host's own container, so
   * `.main-content` can inset itself by exactly that much (`BannerHost.css`).
   *
   * This is the fix for the reported defect. archive#3308 made the host an
   * absolutely-positioned overlay to stop the app reflowing per banner, and
   * that trade is right for a notice that comes and goes — but every banner
   * this host carries names a durable state, so the overlay simply covered
   * the top of the view for as long as the condition lasted. Collapsing a
   * banner makes it shorter; it does not stop it covering what is under it.
   * Reserving the measured height does, in every collapse state, with no
   * per-view padding constant to drift — the same shape `--dock-slot-size`
   * already uses for the dock at the other end of the content area.
   *
   * Written imperatively rather than through React state on purpose: the
   * measurement changes on every frame of a collapse tween, and a state
   * update per frame would re-render every card in the stack to move one
   * number that only CSS reads.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: `banners`/`expanded` are re-measure triggers, not values this body reads — same contract as the stack-scrollable effect above, and the same warning applies: `biome check --write --unsafe` would offer to delete them. `ResizeObserver` fires on the host's own box, which covers a card growing or a tween running, but the host UNMOUNTS when the last banner leaves, and a ref that has already been detached fires no observer callback at all. Re-running on the banner set is what releases the reservation in that case.
  useEffect(() => {
    const host = hostRef.current;
    const target = host?.parentElement ?? null;
    const previous = reservedTargetRef.current;
    if (previous && previous !== target) {
      previous.style.removeProperty(BANNER_RESERVED_HEIGHT_PROPERTY);
    }
    reservedTargetRef.current = target;
    if (!host || !target) return;

    const measure = () => {
      const hostTop = host.getBoundingClientRect().top;
      const entries: BannerReserveEntry[] = [];
      let anyReserving = false;
      for (const node of host.querySelectorAll('[data-banner-id]')) {
        const reserves = node.getAttribute('data-overlay') === null;
        anyReserving ||= reserves;
        entries.push({ reserves, bottom: node.getBoundingClientRect().bottom });
      }
      // The stack cap is chrome for the banners behind it, so it reserves on
      // the same terms they do: with something reserving it is part of the
      // block content must clear, and with nothing reserving it is not.
      const cap = host.querySelector('.banner-host__cap');
      if (cap) {
        entries.push({
          reserves: anyReserving,
          bottom: cap.getBoundingClientRect().bottom,
        });
      }
      const reserved = bannerReservedHeight(hostTop, entries);
      if (reserved > 0) {
        target.style.setProperty(
          BANNER_RESERVED_HEIGHT_PROPERTY,
          `${reserved}px`,
        );
      } else {
        target.style.removeProperty(BANNER_RESERVED_HEIGHT_PROPERTY);
      }
    };
    measure();
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(measure);
    observer?.observe(host);
    return () => observer?.disconnect();
  }, [banners, expanded]);

  useEffect(
    () => () => {
      // Unmount: the container outlives this component, so the reservation
      // has to be handed back explicitly or the app keeps a permanent inset
      // for a host that is no longer there.
      reservedTargetRef.current?.style.removeProperty(
        BANNER_RESERVED_HEIGHT_PROPERTY,
      );
      reservedTargetRef.current = null;
    },
    [],
  );

  useEffect(() => {
    // With one (or zero) live banners there is no stack to hold open.
    if (expanded && liveCount <= 1) setExpanded(false);
  }, [expanded, liveCount]);

  useEffect(() => {
    if (!expanded) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!hostRef.current?.contains(event.target as Node)) {
        setExpanded(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // Escape belongs to whichever dialog-layer surface is open. Collapsing
      // here as well closes two things on one press, and calling
      // `preventDefault` unconditionally suppressed the key's native effects
      // for the whole document — this handler never preventDefaults, matching
      // the toast-stack twin in NotificationContainer.
      //
      // The marker query below is what actually declines; the
      // `defaultPrevented` check above is close to inert, because this
      // listener is capture-phase and therefore runs BEFORE nearly every
      // in-tree handler that could set it. It is kept as the cheap correct
      // posture for anything that preventDefaults earlier in capture, not as
      // a second line of defence — do not read it as one.
      //
      // The modal half of this test is the shell's own derivation, shared
      // rather than re-queried (archive#3767): `isModalDialogOpen` is the
      // same fact the keyboard registry now suppresses global chords on, so
      // this stack and the shortcut dispatcher cannot come to disagree about
      // whether a modal is up.
      const target = event.target;
      const ownerDocument =
        (target instanceof Element ? target.ownerDocument : null) ?? document;
      if (
        isModalDialogOpen(ownerDocument) ||
        ownerDocument.querySelector('[data-escape-owner]')
      ) {
        return;
      }
      setExpanded(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [expanded]);

  if (banners.length === 0) return null;

  const view = buildBannerStackView(banners, expanded);
  // One button plays both roles so toggling never unmounts the control the
  // keyboard user's focus is sitting on.
  const showToggle = expanded || view.cap !== null;

  return (
    <section
      ref={hostRef}
      className={[
        'banner-host',
        connectionSlot ? 'banner-host--connection-slot' : '',
        expanded ? 'banner-host--expanded' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-testid="banner-host"
      data-expanded={expanded || undefined}
      aria-label="System notices"
    >
      <div
        ref={stackRef}
        className={[
          'banner-host__stack',
          stackScrollable ? 'banner-host__stack--scrollable' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {view.visible.map((banner) => (
          <BannerItemView key={banner.id} banner={banner} />
        ))}
      </div>
      {showToggle ? (
        <button
          type="button"
          className={[
            'banner-host__cap',
            view.cap ? `banner-host__cap--${view.cap.tone}` : '',
          ]
            .filter(Boolean)
            .join(' ')}
          data-testid="banner-stack-cap"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? 'Collapse notices' : bannerStackCapLabel(view.cap!)}
        </button>
      ) : null}
    </section>
  );
}

// Re-export the frozen source API next to the host for discoverability.
export { useBanner };
