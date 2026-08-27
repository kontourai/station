import {
  captureReturnFocus,
  restoreReturnFocus,
} from '@kontourai/station-shared/return-focus';
import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useNavigation } from '../contexts/NavigationContext';
import { useIsMobile } from '../hooks/useIsMobile';
import { activatable } from '../utils/activatable';
import { Button } from './Button';
import { DetailPaneContext } from './detail-pane-context';
import { DocumentGlyph } from './icons/Glyph';
import {
  useIsPageFramed,
  usePageFrameActionsSlot,
  usePageFrameMobileDetailSlot,
  usePageHeader,
  useRegisterPageFrameMobileDetailSheet,
} from './page-frame';
import {
  collapseSplitPaneState,
  expandSplitPaneState,
  framedBreadcrumbSegments,
  parseSplitPaneState,
  resizePaneFromKeyboard,
  resizePaneFromPointer,
  SPLIT_PANE_MAX_WIDTH,
  SPLIT_PANE_MIN_WIDTH,
  serializeSplitPaneState,
  shouldShowMobileDetailSheet,
  splitPaneStorageKey,
  visibleBreadcrumbSegments,
} from './SplitPaneLayout.logic';
import { useSplitPaneExternalReturnFocus } from './split-pane-return-focus-context';
import {
  describeReadFailure,
  Empty,
  ErrorState,
  FilteredEmpty,
  Skeleton,
  SkeletonBlock,
  SkeletonList,
} from './state';
import './SplitPaneLayout.css';

// Keep the server render free of a layout-effect warning while still moving a
// mobile sheet before the browser's first paint. The SSR shape is the inline
// fallback below; the one unmanaged portal root replaces it during hydration.
const useIsomorphicLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

type DetailPortalPlacement = 'bootstrap' | 'inline' | 'portaled' | 'detached';

function detailRootClassName(
  rightVisible: boolean,
  showMobileDetailSheet: boolean,
  placement: DetailPortalPlacement,
): string {
  return `split-pane__right${rightVisible ? ' split-pane__right--visible' : ''}${showMobileDetailSheet ? ' split-pane__right--sheet' : ''}${placement === 'portaled' ? ' split-pane__right--portaled' : ''}`;
}

interface SplitPaneItem {
  id: string;
  name: string;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  /** Small inline marker rendered next to the name (e.g. an agent-type badge). */
  badge?: React.ReactNode;
  /**
   * Row-level content rendered OUTSIDE the row button, on its trailing edge.
   *
   * Outside, because `badge`/`icon` render inside a `<button>` and a button
   * may not contain interactive content — a control here (the Sessions list's
   * project-filter pill, station#3027) has to be a sibling of the row button,
   * not a descendant. A row without this prop renders exactly the markup it
   * always did; the flex wrapper only appears when there is something to put
   * in it.
   */
  trailing?: React.ReactNode;
  section?: string;
  /**
   * Optional presentation-only collapsible group. A group is emitted by a
   * caller as contiguous items; rows outside a group retain the original
   * markup path exactly.
   */
  group?: {
    id: string;
    label: string;
    /** Optional compact actions rendered beside the group toggle. */
    renderSummary?: (
      focusMember: (memberId: string) => void,
    ) => React.ReactNode;
  };
}

interface SplitPaneLayoutProps {
  /** Stable id for skeleton-owned resize/collapse persistence. */
  paneId?: string;
  /**
   * `data-first-run-anchor` value for the layout root, so a view whose whole
   * body is this skeleton (no root element of its own to hang an anchor on)
   * can still be a first-run tour target. Omitted → no attribute rendered.
   */
  firstRunAnchor?: string;
  // Left panel
  items: SplitPaneItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDeselect?: () => void;
  onSearch: (query: string) => void;
  searchValue?: string;
  searchPlaceholder?: string;
  onAdd?: () => void;
  addLabel?: string;
  /**
   * Extra actions rendered next to the Add button in the sidebar footer —
   * below the list, pinned outside its scroll region.
   *
   * Accepts a render function for the same reason `listIntro` does: a footer
   * that starts new work needs to select the row it just created, and going
   * through the skeleton's own `selectItem` keeps the mobile return-focus
   * capture (station#1259) that a raw `onSelect` call would skip.
   */
  sidebarActions?:
    | React.ReactNode
    | ((selectItem: (id: string) => void) => React.ReactNode);
  /**
   * Page-level actions for this collection (a secondary "Browse Registry", a
   * "Run independent review"). They render beside the Add button in the page
   * header's action cell when the route is framed, and in the list footer
   * when it is not. Anything that is list chrome rather than a page action
   * belongs in `sidebarActions`.
   */
  headerActions?: React.ReactNode;
  /** Show loading spinner in list panel instead of items */
  loading?: boolean;
  /**
   * The list READ failed.
   *
   * Every split-pane route derives its list from a query, and a failed query
   * settles with no data — which `items.length === 0` cannot tell apart from
   * a genuinely empty collection. Guidance therefore asserted "No installed
   * skills yet" over a 500 (review H1). Error is not empty: when this is
   * truthy AND `items` is empty, the list pane renders `ErrorState` with a
   * Retry instead of the empty branch below.
   *
   * station#771 fix round (review HIGH): this used to outrank `items`
   * unconditionally, so a REFETCH failure with cached items still on hand
   * blanked a working list behind an error card — the exact regression #769
   * exists to prevent (`ProjectPage` renders cached data with no banner on a
   * refetch failure). A non-empty `items` now always wins: the list keeps
   * rendering, silently, exactly as it did before the query re-fired.
   *
   * Typed `unknown` because callers hand it React Query's `error` directly;
   * only its truthiness and (if it is an `Error`) its message are read.
   */
  error?: unknown;
  /** Retry handler for the list-read failure above (usually `refetch`). */
  onRetry?: () => void;
  /** Optional custom title for the list-read failure. */
  listErrorTitle?: string;
  /** Optional custom empty-state copy for the left list panel */
  listEmptyTitle?: string;
  listEmptyDescription?: string;
  listFilteredEmptyNoun?: string;
  /**
   * True when the caller's UNFILTERED collection is itself empty — not
   * merely that a search/filter currently matches nothing. When true, an
   * empty `items` always renders the plain list-empty state (never
   * `FilteredEmpty`), even while `searchValue` holds a typed query.
   *
   * Without this, a route whose collection is genuinely empty AND has a
   * stale/typed query attributed the emptiness to the query — "Nothing in
   * X matches your search" with a "Clear filter" action that fixes
   * nothing, because there is nothing regardless of the filter (station#4463
   * slice 2 fix round, M3, delta review round 3). Defaults to `false`
   * (unset callers keep exactly their current behavior).
   */
  collectionEmpty?: boolean;
  /** Optional task-first guidance rendered before list items on every viewport. */
  listIntro?:
    | React.ReactNode
    | ((selectItem: (id: string) => void) => React.ReactNode);
  // Right panel
  children: React.ReactNode;
  emptyIcon?: React.ReactNode;
  emptyTitle?: string;
  emptyDescription?: string;
  /** Custom empty state content — replaces the default icon/title/desc */
  emptyContent?: React.ReactNode;
  /** Open custom emptyContent as the mobile detail sheet (for create flows). */
  unselectedDetailOpen?: boolean;
  // Header
  label: string;
  /** Map of breadcrumb segment text → click handler. Segments not in this map are plain text. */
  breadcrumbLinks?: Record<string, () => void>;
  title: string;
  subtitle?: string;
}

/** Hoisted so the provider's value is referentially stable across renders. */
const DETAIL_PANE_CONTEXT = { inDetailPane: true } as const;

// Station#4463 slice 2: this used to hand-roll its own icon+2-line row
// placeholder — the exact shape `SkeletonList` already owns (its own doc
// comment names this layout as the reason it exists). One shared component,
// one CSS rhythm, for every split-pane list across the app.
function SplitPaneListSkeleton() {
  return <SkeletonList count={7} label="Loading list" />;
}

function SplitPaneDetailSkeleton() {
  return (
    // No role/aria-busy on this wrapper: the header lines below are each
    // already `aria-hidden` (Skeleton's own contract), and `SkeletonBlock`
    // below is itself a `role="status"` region. A second status landmark
    // here would double-announce the same wait to a screen reader.
    <div className="split-pane__detail-skeleton">
      <div className="split-pane__detail-skeleton-header">
        <Skeleton
          variant="line"
          className="split-pane__detail-skeleton-title"
        />
        <Skeleton variant="line" className="split-pane__detail-skeleton-meta" />
      </div>
      {/* The header above is item-specific chrome with no shared equivalent;
          the body is exactly the region-shaped wait `SkeletonBlock` already
          owns, so it delegates rather than repeating three hand-placed
          `<Skeleton variant="block">`s. */}
      <SkeletonBlock
        count={3}
        label="Loading detail"
        className="split-pane__detail-skeleton-blocks"
      />
    </div>
  );
}

export function SplitPaneLayout({
  paneId,
  firstRunAnchor,
  items,
  selectedId,
  onSelect,
  onDeselect,
  onSearch,
  searchValue,
  searchPlaceholder = 'Search...',
  onAdd,
  addLabel = 'New item',
  sidebarActions,
  headerActions,
  loading,
  error,
  onRetry,
  listErrorTitle,
  listEmptyTitle = 'No items yet',
  listEmptyDescription,
  listFilteredEmptyNoun = 'items',
  collectionEmpty = false,
  listIntro,
  children,
  emptyIcon = <DocumentGlyph />,
  emptyTitle = 'Nothing selected',
  emptyDescription = 'Select an item from the list',
  emptyContent,
  unselectedDetailOpen = false,
  label,
  breadcrumbLinks,
  title,
  subtitle,
}: SplitPaneLayoutProps) {
  const isMobile = useIsMobile();
  const framed = useIsPageFramed();
  const actionsSlot = usePageFrameActionsSlot();
  const { navigate } = useNavigation();
  const paneRef = useRef<HTMLDivElement | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const collapseButtonRef = useRef<HTMLButtonElement | null>(null);
  const reopenButtonRef = useRef<HTMLButtonElement | null>(null);
  const mobileBackButtonRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const detailInlineHostRef = useRef<HTMLDivElement | null>(null);
  const detailPortalRootRef = useRef<HTMLDivElement | null>(null);
  const itemButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingDesktopFocusRef = useRef<'collapse' | 'reopen' | null>(null);
  const pendingMobileFocusRef = useRef<'dismiss' | 'return' | null>(null);
  const mobileReturnFocusFrameRef = useRef<number | null>(null);
  const returningFromMobileDetailRef = useRef(false);
  const mobileDetailWasShownRef = useRef(false);
  const mobileDetailWasLogicallyOpenRef = useRef(false);
  const externalMobileReturnFocus = useSplitPaneExternalReturnFocus();
  /**
   * station#1259. Only the `'return'` half of the mobile effect below is
   * return-focus; the element it returns to is a list row, and the detail pane
   * the sheet opened is free to delete, rename or filter that row out while it
   * is on screen. A bare ref to the button was then a detached node, and
   * `.focus()` on one is a silent no-op that leaves `<body>` focused — the
   * station#1126 outcome. Capture the row *and its ancestors* while all of them
   * are still attached so the restore has somewhere to fall back to.
   */
  const mobileFocusReturnRef = useRef<HTMLElement[]>([]);
  const [paneState, setPaneState] = useState(() => {
    if (!paneId || typeof window === 'undefined') {
      return parseSplitPaneState(null);
    }
    return parseSplitPaneState(
      window.localStorage.getItem(splitPaneStorageKey(paneId)),
    );
  });
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pendingGroupMemberFocus, setPendingGroupMemberFocus] = useState<
    string | null
  >(null);

  // A route can select a child before the reader opens its run. Selection is
  // an explicit request to reveal that row, so it wins over collapsed chrome.
  useEffect(() => {
    const selectedGroupId = items.find((item) => item.id === selectedId)?.group
      ?.id;
    if (!selectedGroupId) return;
    setCollapsedGroups((current) => {
      if (!current.has(selectedGroupId)) return current;
      const next = new Set(current);
      next.delete(selectedGroupId);
      return next;
    });
  }, [items, selectedId]);

  useEffect(() => {
    if (!pendingGroupMemberFocus) return;
    const target = itemButtonRefs.current.get(pendingGroupMemberFocus);
    if (!target) {
      // Review F3: a missed target (member unmounted between activation and
      // commit) must clear the pending id — leaving it set makes the NEXT
      // activation of the same member a same-value setState that React bails
      // out on, so the effect never re-runs and focus silently dies forever.
      setPendingGroupMemberFocus(null);
      return;
    }
    target.focus();
    setPendingGroupMemberFocus(null);
  }, [pendingGroupMemberFocus]);

  const focusGroupMember = (groupId: string, memberId: string) => {
    setCollapsedGroups((current) => {
      if (!current.has(groupId)) return current;
      const next = new Set(current);
      next.delete(groupId);
      return next;
    });
    setPendingGroupMemberFocus(memberId);
  };
  const storageKey = useMemo(
    () => (paneId ? splitPaneStorageKey(paneId) : null),
    [paneId],
  );
  const showMobileDetailSheet = shouldShowMobileDetailSheet(
    isMobile,
    selectedId,
    unselectedDetailOpen,
  );
  const mobileDetailLogicallyOpen = Boolean(selectedId || unselectedDetailOpen);
  const leftVisible = !isMobile ? !paneState.collapsed : !showMobileDetailSheet;
  const rightVisible = !isMobile || showMobileDetailSheet;
  const mobileDetailSlot = usePageFrameMobileDetailSlot();
  const [detailPortalPlacement, setDetailPortalPlacement] =
    useState<DetailPortalPlacement>('bootstrap');
  const wantsMobilePortal = isMobile && framed && showMobileDetailSheet;
  // Placement is state, rather than a parentNode read during render: an
  // imperative reparent in layout effect otherwise leaves inert/focus one
  // render behind the actual sheet.
  const mobileDetailPortaled =
    detailPortalPlacement === 'portaled' &&
    wantsMobilePortal &&
    Boolean(mobileDetailSlot);
  // Only a rendered portal makes its owning PageFrame inert. A framed route
  // whose slot has not mounted yet renders no inline fallback, so it cannot
  // briefly publish a transformed mobile sheet.
  useRegisterPageFrameMobileDetailSheet(mobileDetailPortaled);
  const mobileDetailRendered =
    showMobileDetailSheet &&
    (mobileDetailPortaled || (!framed && detailPortalPlacement === 'inline'));

  /*
   * Detail children have one React portal target for their entire lifetime.
   * We move that target rather than asking React to switch between an inline
   * subtree and a portal (or between portal targets), which would remount form
   * state whenever the browser crosses the mobile breakpoint.
   */
  useIsomorphicLayoutEffect(() => {
    const inlineHost = detailInlineHostRef.current;
    if (!inlineHost) return;
    let root = detailPortalRootRef.current;
    if (!root) {
      root = inlineHost.ownerDocument.createElement('div');
      detailPortalRootRef.current = root;
    }

    const target = wantsMobilePortal ? mobileDetailSlot : inlineHost;
    const placement: DetailPortalPlacement = target
      ? target === mobileDetailSlot
        ? 'portaled'
        : 'inline'
      : 'detached';
    root.className = detailRootClassName(
      rightVisible,
      showMobileDetailSheet,
      placement,
    );
    if (target && root.parentNode !== target) target.appendChild(root);
    if (!target && root.parentNode) root.remove();
    setDetailPortalPlacement((current) =>
      current === placement ? current : placement,
    );
  }, [
    mobileDetailSlot,
    rightVisible,
    showMobileDetailSheet,
    wantsMobilePortal,
  ]);

  // This is intentionally separate from the reconciliation effect above:
  // changing a slot/breakpoint only reparents; actual component unmount is the
  // one time the unmanaged root is removed. StrictMode reuses the same ref.
  useIsomorphicLayoutEffect(
    () => () => {
      detailPortalRootRef.current?.remove();
    },
    [],
  );

  useEffect(() => {
    if (!storageKey || typeof window === 'undefined') return;
    window.localStorage.setItem(storageKey, serializeSplitPaneState(paneState));
  }, [paneState, storageKey]);

  useEffect(() => {
    return () => {
      resizeCleanupRef.current?.();
      if (mobileReturnFocusFrameRef.current !== null) {
        cancelAnimationFrame(mobileReturnFocusFrameRef.current);
        mobileReturnFocusFrameRef.current = null;
      }
      // A section can unmount while its routed mobile detail is still open.
      // That is navigation away, not a sheet close within this list, so it
      // must abandon its local return intent rather than restore into another
      // section (or leave the old opener available to a later mount).
      pendingMobileFocusRef.current = null;
      mobileFocusReturnRef.current = [];
      returningFromMobileDetailRef.current = false;
      mobileDetailWasShownRef.current = false;
      mobileDetailWasLogicallyOpenRef.current = false;
    };
  }, []);

  useEffect(() => {
    const pendingFocus = pendingDesktopFocusRef.current;
    if (pendingFocus === 'reopen' && paneState.collapsed) {
      reopenButtonRef.current?.focus();
      pendingDesktopFocusRef.current = null;
    } else if (pendingFocus === 'collapse' && !paneState.collapsed) {
      collapseButtonRef.current?.focus();
      pendingDesktopFocusRef.current = null;
    }
  }, [paneState.collapsed]);

  // Two different jobs share this effect. `'dismiss'` is a *control swap*:
  // the sheet just opened and focus moves forward onto its back button, the
  // same shape as the collapse/reopen pair above. `'return'` is the only
  // return-focus move in this file — the sheet closed and focus goes back to
  // whatever opened it. They must not be conflated: a control swap targets a
  // control that exists because the surface is open, so it can never have been
  // destroyed by the surface's own action.
  useEffect(() => {
    const wasMobileDetailShown = mobileDetailWasShownRef.current;
    const wasMobileDetailLogicallyOpen =
      mobileDetailWasLogicallyOpenRef.current;
    if (showMobileDetailSheet && !wasMobileDetailShown) {
      if (mobileReturnFocusFrameRef.current !== null) {
        cancelAnimationFrame(mobileReturnFocusFrameRef.current);
        mobileReturnFocusFrameRef.current = null;
      }
      if (mobileFocusReturnRef.current.length === 0) {
        mobileFocusReturnRef.current =
          externalMobileReturnFocus?.takeExternalReturnFocus() ?? [];
      }
      pendingMobileFocusRef.current ??= 'dismiss';
    }
    // Closing a routed detail (history, Cancel, or another owner changing the
    // route) removes the mobile sheet without invoking its Back handler. It
    // still closes this split pane's surface, so use the same one-shot return
    // path. A desktop breakpoint is only a reparenting transition and must not
    // consume or restore the mobile chain.
    if (
      isMobile &&
      wasMobileDetailShown &&
      !showMobileDetailSheet &&
      pendingMobileFocusRef.current !== 'return'
    ) {
      returningFromMobileDetailRef.current = true;
      pendingMobileFocusRef.current = 'return';
    }
    // A breakpoint preserves an open detail and its prospective return chain,
    // but closing that detail while desktop owns it has no mobile sheet to
    // return from. Abandon the old intent before a later mobile deep link can
    // mistake it for this surface's opener.
    if (
      !isMobile &&
      wasMobileDetailLogicallyOpen &&
      !mobileDetailLogicallyOpen
    ) {
      if (mobileReturnFocusFrameRef.current !== null) {
        cancelAnimationFrame(mobileReturnFocusFrameRef.current);
        mobileReturnFocusFrameRef.current = null;
      }
      pendingMobileFocusRef.current = null;
      mobileFocusReturnRef.current = [];
      returningFromMobileDetailRef.current = false;
    }
    mobileDetailWasShownRef.current = showMobileDetailSheet;
    mobileDetailWasLogicallyOpenRef.current = mobileDetailLogicallyOpen;
    const pendingFocus = pendingMobileFocusRef.current;
    if (pendingFocus === 'dismiss' && mobileDetailRendered) {
      // A framed sheet first waits for its page-level portal ref. Keep the
      // pending request until the Back control exists; otherwise a commit
      // would clear it before the portal's child has mounted.
      if (!mobileBackButtonRef.current) return;
      mobileBackButtonRef.current.focus();
      pendingMobileFocusRef.current = null;
    } else if (
      pendingFocus === 'return' &&
      isMobile &&
      !showMobileDetailSheet
    ) {
      const returnChain = mobileFocusReturnRef.current;
      // Removing the focused Back button can make the browser synchronously
      // rehome focus on `.content-view` before this passive effect. For this
      // explicit Back return, that is the preserved surface's teardown/route
      // fallback, not an unrelated actor claiming focus. Focus outside this
      // content view still retains applyReturnFocus's normal veto.
      const closingSurface =
        returnChain.length > 0 && returningFromMobileDetailRef.current
          ? (paneRef.current?.closest<HTMLElement>('.content-view') ??
            paneRef.current?.ownerDocument.querySelector<HTMLElement>(
              '.content-view',
            ) ??
            null)
          : detailPortalRootRef.current;
      // PageFrame removes inert in its own state transition. Wait one frame
      // so the row/list chain is focusable again rather than silently walking
      // it while inert and falling through to `.content-view`.
      mobileReturnFocusFrameRef.current =
        returnChain.length > 0
          ? restoreReturnFocus(returnChain, closingSurface)
          : requestAnimationFrame(() => listRef.current?.focus());
      mobileFocusReturnRef.current = [];
      returningFromMobileDetailRef.current = false;
      pendingMobileFocusRef.current = null;
    }
  }, [
    externalMobileReturnFocus,
    isMobile,
    mobileDetailLogicallyOpen,
    showMobileDetailSheet,
    mobileDetailRendered,
  ]);

  function collapseListPane() {
    pendingDesktopFocusRef.current = 'reopen';
    setPaneState((current) => collapseSplitPaneState(current));
  }

  function expandListPane() {
    pendingDesktopFocusRef.current = 'collapse';
    setPaneState((current) => expandSplitPaneState(current));
  }

  function selectItem(id: string) {
    if (isMobile) {
      // `listIntro` can call this for a row that has no button of its own; the
      // capture then falls back to whatever the user actually activated, which
      // is the control focus belongs on either way.
      mobileFocusReturnRef.current = captureReturnFocus(
        itemButtonRefs.current.get(id),
      );
      pendingMobileFocusRef.current = 'dismiss';
    }
    onSelect(id);
  }

  function activateAdd(event: React.MouseEvent<HTMLButtonElement>) {
    if (isMobile) {
      mobileFocusReturnRef.current = captureReturnFocus(event.currentTarget);
      pendingMobileFocusRef.current = 'dismiss';
    }
    onAdd?.();
  }

  function dismissMobileDetail() {
    returningFromMobileDetailRef.current = true;
    pendingMobileFocusRef.current = 'return';
    onDeselect?.();
  }

  function startResize(event: React.PointerEvent<HTMLButtonElement>) {
    if (isMobile || paneState.collapsed) return;
    event.preventDefault();
    const paneLeft = paneRef.current?.getBoundingClientRect().left ?? 0;
    const pointerId = event.pointerId;
    const divider = event.currentTarget;
    resizeCleanupRef.current?.();
    divider.setPointerCapture?.(pointerId);

    function onPointerMove(moveEvent: PointerEvent) {
      if (moveEvent.pointerId !== pointerId) return;
      setPaneState((current) => ({
        ...current,
        width: resizePaneFromPointer(moveEvent.clientX, paneLeft),
      }));
    }

    const cleanupResize = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', finishResize);
      window.removeEventListener('pointercancel', finishResize);
      divider.removeEventListener('lostpointercapture', cleanupResize);
      if (divider.hasPointerCapture?.(pointerId)) {
        divider.releasePointerCapture?.(pointerId);
      }
      if (resizeCleanupRef.current === cleanupResize) {
        resizeCleanupRef.current = null;
      }
    };

    function finishResize(finishEvent: PointerEvent) {
      if (finishEvent.pointerId !== pointerId) return;
      cleanupResize();
    }

    resizeCleanupRef.current = cleanupResize;
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', finishResize);
    window.addEventListener('pointercancel', finishResize);
    divider.addEventListener('lostpointercapture', cleanupResize, {
      once: true,
    });
  }

  function resizeWithKeyboard(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (isMobile || paneState.collapsed) return;
    const nextWidth = resizePaneFromKeyboard(paneState.width, event.key, {
      shiftKey: event.shiftKey,
    });
    if (nextWidth === null) return;
    event.preventDefault();
    setPaneState((current) => ({
      ...current,
      width:
        resizePaneFromKeyboard(current.width, event.key, {
          shiftKey: event.shiftKey,
        }) ?? current.width,
    }));
  }

  /**
   * Framed, the eyebrow is the page header's: `framedBreadcrumbSegments`
   * drops the trailing crumb that restates the frame's own `<h1>`
   * unconditionally (station#4463 slice 1 — the 2026-08-26 shell audit
   * retired the self-referential eyebrow this used to render, e.g.
   * `SCHEDULE` above `Schedule`), leaving only real ancestors — none for a
   * top-level route, the parent for a subpage. Unframed, the old dedup
   * stands — there the eyebrow sits directly above the same word at nearly
   * the same size, which is the case it exists to suppress.
   */
  const breadcrumbSegments = framed
    ? framedBreadcrumbSegments(label, title)
    : visibleBreadcrumbSegments(label, title, breadcrumbLinks);
  /**
   * Handlers are read through refs at click time, not captured, so the
   * memoised node below can stay referentially stable across renders while
   * still calling the current `breadcrumbLinks` entry. Capturing them would
   * make the node identity change every render, and `usePageHeader` settles
   * only on values that are `Object.is`-stable.
   */
  const breadcrumbLinksRef = useRef(breadcrumbLinks);
  breadcrumbLinksRef.current = breadcrumbLinks;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const segmentsKey = breadcrumbSegments.join(' / ');
  const linkedKey = breadcrumbSegments
    .map((seg) => (breadcrumbLinks?.[seg.toLowerCase()] ? '1' : '0'))
    .join('');
  const breadcrumb = useMemo(() => {
    const segs = segmentsKey ? segmentsKey.split(' / ') : [];
    return segs.map((seg, i, arr) => {
      const isLast = i === arr.length - 1;
      // The last segment of whatever trail actually gets rendered is
      // terminal and stays inert text unless the view wired an explicit
      // link to it. This is deliberately UNCONDITIONAL on `framed`.
      //
      // station#4463 slice 1 fix round: an earlier version of this made
      // every framed segment "an ancestor by construction" on the theory
      // that `framedBreadcrumbSegments` already drops the one naming the
      // current page — but that only holds when the trailing segment
      // literally restates the title. `framedBreadcrumbSegments` KEEPS the
      // last segment whenever it does NOT restate the title (a real
      // multi-level trail, e.g. an entity slug ahead of an editor tab), and
      // that kept segment is not necessarily a real top-level route —
      // auto-linking it fabricated live `/edit`, `/detail`, `/tools`
      // destinations on the first branch that unsuppressed one. A kept
      // terminal crumb is exactly as uncertain framed as it is unframed, so
      // it gets the same treatment: inert unless `breadcrumbLinks` says
      // otherwise.
      const isTerminal = isLast;
      const hasExplicit = linkedKey[i] === '1';
      const handler =
        hasExplicit || !isTerminal
          ? () => {
              const explicit = breadcrumbLinksRef.current?.[seg.toLowerCase()];
              if (explicit) explicit();
              else if (!isTerminal)
                navigateRef.current(`/${seg.toLowerCase()}`);
            }
          : undefined;
      return (
        <React.Fragment key={i}>
          {handler ? (
            <span
              className="split-pane__label-link"
              {...activatable(handler, { role: 'link' })}
            >
              {seg}
            </span>
          ) : (
            <span>{seg}</span>
          )}
          {!isLast && <span className="split-pane__label-sep"> / </span>}
        </React.Fragment>
      );
    });
  }, [segmentsKey, linkedKey]);
  /**
   * Framed, the collection's title belongs to the page header — the pane
   * keeps its search and its list and stops rendering a page-level heading
   * of its own. This is the whole of SHELL-11's split-pane fork: eight routes
   * substituted a 14.7px panel title for a page header, and no route can do
   * that any more because the layout that made it possible now publishes
   * upward instead.
   */
  const headerContent = useMemo(
    () =>
      framed
        ? {
            eyebrow: breadcrumb.length > 0 ? breadcrumb : undefined,
            title,
            subtitle,
          }
        : null,
    [framed, breadcrumb, title, subtitle],
  );
  usePageHeader(headerContent);
  const collapseButton = (
    <button
      ref={collapseButtonRef}
      type="button"
      className="split-pane__collapse"
      onClick={collapseListPane}
      aria-label="Hide list pane"
      title="Hide list pane"
    >
      <span aria-hidden="true">‹</span>
    </button>
  );
  // Framed, this is the page's primary action and renders as the one shared
  // Button; unframed it keeps the list-pane treatment it has always had. The
  // page-scoped button family it used to reach for has been retired.
  const addButton = onAdd ? (
    framed ? (
      <Button variant="primary" size="sm" onClick={activateAdd}>
        {addLabel}
      </Button>
    ) : (
      <button
        type="button"
        className="split-pane__add-btn"
        onClick={activateAdd}
      >
        {addLabel}
      </button>
    )
  ) : null;
  /**
   * The collection's primary action. Framed, it renders in the page header's
   * action cell — the same place Schedule's `+ Add Job` has always been —
   * through a portal, so `activateAdd`'s mobile return-focus capture
   * (station#1259) is the same code on the same element wherever it lands.
   * Unframed it stays in the list footer, exactly as before.
   *
   * `sidebarActions` deliberately does NOT travel with it: those are list
   * chrome (Activity's delegated-work card), not page actions, and a card in
   * a header cell is how the audit's five primary-button treatments happened.
   *
   * The inline branch below is keyed on `framed`, not on whether a cell is
   * available: inside a frame the action is the page header's, and the two
   * moments when there is no cell to portal into — before the header's ref
   * has published one, and after this view's route has been left — are both
   * moments when putting it back in the list footer would be wrong. The first
   * showed as a visible relocation on mount; the second would leave a
   * departed page's button on screen.
   */
  const framedActions = framed && actionsSlot;
  const headerActionBlock =
    addButton || headerActions ? (
      <>
        {headerActions}
        {addButton}
      </>
    ) : null;
  const detailContents = (
    <>
      {showMobileDetailSheet && (
        <button
          type="button"
          ref={mobileBackButtonRef}
          className="split-pane__back"
          onClick={dismissMobileDetail}
        >
          ← Back to list
        </button>
      )}
      {/*
       * Everything rendered in the detail slot is at ITEM level: the list
       * pane's page-level heading above already owns the collection title
       * (station#2931, docs/design/shell-skeletons.md §2.1). `DetailHeader`
       * reads this and renders one level down, so a view cannot stack a
       * second page-level title on the collection's by forgetting the rule.
       */}
      <DetailPaneContext.Provider value={DETAIL_PANE_CONTEXT}>
        {loading ? (
          <SplitPaneDetailSkeleton />
        ) : selectedId ? (
          children
        ) : emptyContent ? (
          emptyContent
        ) : items.length === 0 && !unselectedDetailOpen ? /*
         * station#4463 slice 2 (the double-empty rule): the list pane just
         * above already rendered its own "nothing here" — either `Empty`
         * (truly empty) or `FilteredEmpty` (search matched nothing). An
         * empty list has no item to select, so "Select an item" here is not
         * a second fact, it is the same fact restated — Review's queue
         * showed both side by side (SHELL audit, 2026-08-26). The detail
         * pane defers to the list's message instead of repeating it.
         * `emptyContent` is a caller's own surface (an install/add flow, a
         * create-first-run card) and is trusted as-is; `unselectedDetailOpen`
         * is an explicit request to show it regardless of the list.
         */
        null : (
          <Empty
            variant="prominent"
            icon={<span className="split-pane__empty-icon">{emptyIcon}</span>}
            label={emptyTitle}
            description={emptyDescription}
          />
        )}
      </DetailPaneContext.Provider>
    </>
  );
  // Before the client has an unmanaged root, keep the server/hydration output
  // inline. This bootstrap-only wrapper is never used again after the layout
  // effect establishes the stable portal target.
  const bootstrapDetail = (
    <div
      className={detailRootClassName(
        rightVisible,
        showMobileDetailSheet,
        'inline',
      )}
    >
      {detailContents}
    </div>
  );

  return (
    <div
      className={`split-pane${paneState.collapsed && !isMobile ? ' split-pane--collapsed' : ''}${showMobileDetailSheet ? ' split-pane--mobile-sheet-open' : ''}`}
      ref={paneRef}
      data-first-run-anchor={firstRunAnchor}
    >
      {!isMobile && paneState.collapsed && (
        <button
          ref={reopenButtonRef}
          type="button"
          className="split-pane__reopen"
          onClick={expandListPane}
          aria-label="Show list pane"
          title="Show list pane"
        >
          <span aria-hidden="true">›</span>
        </button>
      )}
      <div
        className={`split-pane__left${leftVisible ? ' split-pane__left--visible' : ''}`}
        style={
          !isMobile && !paneState.collapsed
            ? { width: paneState.width }
            : undefined
        }
      >
        <div className="split-pane__header">
          {!framed && (
            <div className="split-pane__heading">
              <div>
                {breadcrumbSegments.length > 0 && (
                  <div className="split-pane__label">{breadcrumb}</div>
                )}
                <h2
                  className={`split-pane__title ${selectedId && onDeselect ? 'split-pane__title--clickable' : ''}`}
                  // Only a control when there is a selection to clear — the
                  // same condition the --clickable class already keys on.
                  {...activatable(
                    selectedId && onDeselect ? onDeselect : undefined,
                  )}
                >
                  {title}
                </h2>
                {subtitle && <p className="split-pane__subtitle">{subtitle}</p>}
              </div>
              {!isMobile && collapseButton}
            </div>
          )}
          <div className="split-pane__filter-row">
            <input
              className="list-filter-input"
              type="text"
              placeholder={searchPlaceholder}
              value={searchValue}
              onChange={(e) => onSearch(e.target.value)}
            />
            {framed && !isMobile && collapseButton}
          </div>
        </div>

        <div className="split-pane__list" ref={listRef} tabIndex={-1}>
          {typeof listIntro === 'function' ? listIntro(selectItem) : listIntro}
          {loading ? (
            <SplitPaneListSkeleton />
          ) : error && items.length === 0 ? (
            <ErrorState
              variant="compact"
              title={listErrorTitle ?? `Unable to load ${label}`}
              description={describeReadFailure(error)}
              action={
                onRetry ? (
                  <Button size="sm" onClick={onRetry}>
                    Retry
                  </Button>
                ) : undefined
              }
            />
          ) : items.length === 0 ? (
            // M3 (delta review round 3): a typed query over an ALREADY-empty
            // collection is not what emptied it — `collectionEmpty` says so
            // explicitly, so this never misattributes "nothing here" to the
            // search (and never offers a "Clear filter" that fixes nothing).
            !collectionEmpty && searchValue?.trim() ? (
              <FilteredEmpty
                query={searchValue}
                noun={listFilteredEmptyNoun}
                icon={
                  <span className="split-pane__list-empty-icon">
                    {emptyIcon || <DocumentGlyph />}
                  </span>
                }
                onClear={() => onSearch('')}
              />
            ) : (
              <Empty
                variant="compact"
                icon={
                  <span className="split-pane__list-empty-icon">
                    {emptyIcon || <DocumentGlyph />}
                  </span>
                }
                label={listEmptyTitle}
                description={listEmptyDescription}
              />
            )
          ) : (
            items.map((item, i) => {
              const group = item.group;
              const previousGroupId = items[i - 1]?.group?.id;
              const groupStarts = group && group.id !== previousGroupId;
              const groupExpanded = group
                ? !collapsedGroups.has(group.id)
                : true;
              const row = (
                <button
                  ref={(node) => {
                    if (node) itemButtonRefs.current.set(item.id, node);
                    else itemButtonRefs.current.delete(item.id);
                  }}
                  type="button"
                  className={`split-pane__item${selectedId === item.id ? ' split-pane__item--selected' : ''}`}
                  onClick={() => selectItem(item.id)}
                >
                  {item.icon && (
                    <div className="split-pane__item-icon">{item.icon}</div>
                  )}
                  <div className="split-pane__item-text">
                    <div className="split-pane__item-name">
                      {item.name}
                      {item.badge}
                    </div>
                    {item.subtitle && (
                      <div className="split-pane__item-subtitle">
                        {item.subtitle}
                      </div>
                    )}
                  </div>
                </button>
              );
              const rowContent = item.trailing ? (
                <div className="split-pane__item-row">
                  {row}
                  <div className="split-pane__item-trailing">
                    {item.trailing}
                  </div>
                </div>
              ) : (
                row
              );
              return (
                <React.Fragment key={item.id}>
                  {item.section !== undefined &&
                    item.section !== items[i - 1]?.section && (
                      <div className="split-pane__section-header">
                        {item.section}
                      </div>
                    )}
                  {groupStarts && group && (
                    <div className="split-pane__group-header">
                      <button
                        type="button"
                        className="split-pane__group-toggle"
                        aria-expanded={groupExpanded}
                        onClick={() =>
                          setCollapsedGroups((current) => {
                            const next = new Set(current);
                            if (next.has(group.id)) next.delete(group.id);
                            else next.add(group.id);
                            return next;
                          })
                        }
                      >
                        <span aria-hidden="true">
                          {groupExpanded ? '⌄' : '›'}
                        </span>
                        {group.label}
                      </button>
                      {group.renderSummary?.((memberId) =>
                        focusGroupMember(group.id, memberId),
                      )}
                    </div>
                  )}
                  {group
                    ? groupExpanded && (
                        <div className="split-pane__group-member">
                          {rowContent}
                        </div>
                      )
                    : rowContent}
                </React.Fragment>
              );
            })
          )}
        </div>

        {(headerActionBlock && !framedActions) || sidebarActions ? (
          <div className="split-pane__add">
            {typeof sidebarActions === 'function'
              ? sidebarActions(selectItem)
              : sidebarActions}
            {!framed && headerActionBlock}
          </div>
        ) : null}
      </div>
      {framedActions && headerActionBlock
        ? createPortal(headerActionBlock, actionsSlot)
        : null}

      {!isMobile && !paneState.collapsed && (
        // The suggested <hr> is a decorative rule: not focusable, not
        // operable, and unable to carry aria-valuenow. This is a window
        // splitter — a real button that resizes with the arrow keys
        // (resizeWithKeyboard) and reports its position.
        // biome-ignore lint/a11y/useSemanticElements: an <hr> cannot be a focusable, operable splitter.
        <button
          type="button"
          className="split-pane__divider"
          onPointerDown={startResize}
          onKeyDown={resizeWithKeyboard}
          aria-label="Resize list pane"
          aria-orientation="vertical"
          aria-valuemax={SPLIT_PANE_MAX_WIDTH}
          aria-valuemin={SPLIT_PANE_MIN_WIDTH}
          aria-valuenow={paneState.width}
          role="separator"
          title="Drag to resize"
        />
      )}

      <div className="split-pane__detail-inline-host" ref={detailInlineHostRef}>
        {detailPortalPlacement === 'bootstrap'
          ? bootstrapDetail
          : detailPortalRootRef.current
            ? createPortal(detailContents, detailPortalRootRef.current)
            : null}
      </div>
    </div>
  );
}
