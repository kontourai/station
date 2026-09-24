import type {
  BrowserPaneAccessView,
  BrowserSessionView,
} from '@kontourai/station-contracts/workspace-browser-pane';
import { authenticatedFetch } from '@kontourai/station-sdk';
import { useQuery } from '@tanstack/react-query';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Button } from '../components/Button';
import { CloseGlyph, MenuGlyph, MonitorGlyph } from '../components/icons/Glyph';
import { useApiBase } from '../contexts/ApiBaseContext';
import {
  describeOpenInRegionRefusal,
  useOpenBrowserSessionInRegion,
} from '../contexts/useOpenInRegion';
import { useFeatureSettings } from '../hooks/useFeatureSettings';
import {
  LiveSurfaceCanvas,
  type LiveSurfaceControllerTone,
  type LiveSurfaceControlState,
} from '../live-surface/LiveSurfaceCanvas';
import { pickAutoFloatCandidate } from './autoFloatCandidate';
import {
  clampFloatPosition,
  FLOAT_EDGE_GAP,
  FLOAT_MIN_SIZE,
  type FloatFrame,
  type FloatObstacles,
  type FloatResizeDirection,
  type FloatSize,
  isFloatArrowKey,
  nudgeFloatFrame,
  resizeFloatFrame,
  resolveFloatFrame,
} from './floatLayout';
import { type FloatSource, floatSourceKey } from './floatSource';
import {
  closeFloat,
  dismissFloat,
  getFloatingSource,
  getFloatPlacement,
  handOffFloat,
  isFloatDismissed,
  isFloatHandedOff,
  migrateFloatConversation,
  openFloat,
  setFloatPlacement,
  useFloatStoreVersion,
} from './floatStore';
import {
  agentInputOf,
  type RecentAgentInput,
  useRecentDriver,
} from './recentDriver';
import {
  isSourceShown,
  useShownSourcesVersion,
  useSourceShown,
} from './shownSources';
import './FloatOverChat.css';

/**
 * Float over chat (#90 D9): a live surface — a Browser session now, a
 * Device later — floated as a small movable player over the conversation,
 * so a user can watch and drive what an agent is doing without leaving it.
 *
 * - It floats over the chat column, off the composer (measured live), 12px
 *   from every edge, at the source's aspect ratio.
 * - Its chrome is a dot; hovering or focusing it opens a pill with a drag
 *   handle, "Open in right panel" and Close, plus who is in control and
 *   "Take control" when that is not you. Who is in control comes from the
 *   player's own live view (`onControlState`): no second stream, no second
 *   fetch of the lease.
 * - It hides while a pane shows the same source (`shownSources`), which is
 *   also the connection budget: a hidden player has no live view.
 * - It floats on its own when an agent drives a browser in this chat's
 *   Project and no pane shows it (the "Automatically show agent browser
 *   sessions" setting, default on), never re-floating one the user put away
 *   in this conversation.
 * - Too narrow a chat gets a one-line notice with the same two actions
 *   instead of a player that would cover the conversation.
 */

/** Below this chat width a player would cover the conversation. */
export const FLOAT_NARROW_WIDTH = 360;
/** How often the Project's sessions are re-read for auto-float. */
const FLOAT_POLL_MS = 5_000;
/** The ceiling a run of transient failures backs the poll off to. */
const FLOAT_POLL_MAX_MS = 60_000;

/** The SDK's authenticated fetch, or a test's stand-in. */
export type FloatFetch = typeof authenticatedFetch;

/** A browser route answered with something other than a usable 200. */
export class FloatReadError extends Error {
  constructor(readonly status: number) {
    super(`Browser route unavailable (HTTP ${status})`);
    this.name = 'FloatReadError';
  }
}

/**
 * When to read again after a read. A 403 (not the operator or a Project
 * admin) or a 404 (no browser on this Station) is an answer: stop. Any other
 * failure is transient: back off (5 s, 10 s, 20 s … up to a minute) and keep
 * asking, so a restart or a dropped relay never ends auto-float for good.
 * `settled` is for a read that only needs one success (the access check).
 */
export function floatReadDelay(
  error: unknown,
  failures: number,
  settled: false | number,
): number | false {
  if (error === null) return settled;
  if (
    error instanceof FloatReadError &&
    (error.status === 403 || error.status === 404)
  )
    return false;
  return Math.min(
    FLOAT_POLL_MS * 2 ** Math.max(0, failures - 1),
    FLOAT_POLL_MAX_MS,
  );
}

async function readEnvelope(
  fetcher: FloatFetch,
  url: string,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetcher(url, { signal });
  const envelope = (await response.json().catch(() => null)) as {
    success?: boolean;
    data?: unknown;
  } | null;
  if (!response.ok || envelope?.success !== true)
    throw new FloatReadError(response.status);
  return envelope.data;
}

/**
 * Read here rather than through the Browser pane's `browserPaneApi`: that
 * module lives in the pane's chunks, and importing it from this one splits
 * it into a chunk of its own that the entry bundle then has to name as a
 * preload dependency — bytes on every cold load, for two GETs.
 */
async function readProjectBrowserSessions(
  fetcher: FloatFetch,
  apiBase: string,
  projectSlug: string,
  signal: AbortSignal,
): Promise<BrowserSessionView[]> {
  const data = await readEnvelope(
    fetcher,
    `${apiBase}/api/browser/sessions?projectSlug=${encodeURIComponent(projectSlug)}`,
    signal,
  );
  if (!Array.isArray(data)) throw new FloatReadError(200);
  return data as BrowserSessionView[];
}

/** Whether this viewer may use the browser here, and as which principal. */
async function readBrowserAccess(
  fetcher: FloatFetch,
  apiBase: string,
  projectSlug: string,
  signal: AbortSignal,
): Promise<BrowserPaneAccessView> {
  return (await readEnvelope(
    fetcher,
    `${apiBase}/api/browser/projects/${encodeURIComponent(projectSlug)}/access`,
    signal,
  )) as BrowserPaneAccessView;
}

/**
 * The floater for one chat, mounted by `FloatOverChat` once its marker is in
 * the document. `anchor` is that marker.
 */
export function FloatOverChatHost({
  anchor,
  projectSlug,
  conversationKey,
  tabId,
  threadIds,
  transport = authenticatedFetch,
}: {
  anchor: HTMLElement;
  projectSlug: string;
  conversationKey: string;
  /** The chat tab's own id: the key before a conversation id exists. */
  tabId: string;
  threadIds: readonly string[];
  transport?: FloatFetch;
}) {
  // A new chat is keyed by its tab id until its conversation id lands; when
  // it does, what was recorded under the tab id moves with it (SF1). A
  // layout effect, so it lands before the auto-float effect of the same
  // commit reads the dismissals.
  const keyRef = useRef(conversationKey);
  useLayoutEffect(() => {
    const previous = keyRef.current;
    keyRef.current = conversationKey;
    if (previous !== conversationKey && previous === tabId)
      migrateFloatConversation(previous, conversationKey);
  }, [conversationKey, tabId]);
  const { apiBase } = useApiBase();
  const { settings } = useFeatureSettings();
  const autoFloat = settings.autoFloatAgentBrowserSessions !== false;
  useFloatStoreVersion();
  const shownVersion = useShownSourcesVersion();
  const source = getFloatingSource(conversationKey);
  // Consecutive failures per read, for the back-off (reset by a success).
  const accessFailures = useRef(0);
  const sessionFailures = useRef(0);
  const access = useQuery({
    queryKey: ['float-over-chat', apiBase, 'access', projectSlug],
    queryFn: async ({ signal }) => {
      try {
        const view = await readBrowserAccess(
          transport,
          apiBase,
          projectSlug,
          signal,
        );
        accessFailures.current = 0;
        return view;
      } catch (error) {
        accessFailures.current += 1;
        throw error;
      }
    },
    enabled: autoFloat || source !== null,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    // One success is the answer; a 403/404 is too; anything else is retried.
    refetchInterval: (query) =>
      floatReadDelay(query.state.error, accessFailures.current, false),
  });
  const principalKey = access.data?.principalKey ?? null;
  const sessions = useQuery({
    queryKey: ['float-over-chat', apiBase, 'sessions', projectSlug],
    queryFn: async ({ signal }) => {
      try {
        const list = await readProjectBrowserSessions(
          transport,
          apiBase,
          projectSlug,
          signal,
        );
        sessionFailures.current = 0;
        // Stamped where the data ARRIVES (review L2): a remount that reads
        // cached data sees how long ago it really came, on the monotonic
        // clock the agent-driving window is measured in.
        return { list, receivedAt: performance.now() };
      } catch (error) {
        sessionFailures.current += 1;
        throw error;
      }
    },
    // Only once the access check says this viewer may use the browser here
    // (the list route answers a 200 with an empty list to anyone, so it
    // cannot say that), and only while it can matter: to auto-float, or to
    // notice that the floated session went away.
    enabled: access.isSuccess && (autoFloat || source !== null),
    retry: false,
    refetchInterval: (query) =>
      floatReadDelay(query.state.error, sessionFailures.current, FLOAT_POLL_MS),
  });
  const list = sessions.data?.list;
  const receivedAt = sessions.data?.receivedAt;
  // Every poll re-decides, even one whose list is unchanged: a hand-off's
  // grace period can run out between two identical reads.
  const polledAt = sessions.dataUpdatedAt;

  // biome-ignore lint/correctness/useExhaustiveDependencies: shownVersion and polledAt are change signals (module stores, and a poll with an unchanged list); threadIds is compared by content.
  useEffect(() => {
    if (!list) return;
    if (source) {
      if (source.kind !== 'browser') return;
      const current = list.find(
        (session) => session.browserSessionId === source.browserSessionId,
      );
      // The session ended, closed or lost its live view: the floater goes
      // with it. Not a dismissal — if an agent drives it live again, it may
      // float again.
      if (current?.state !== 'live' || !current.surfaceId)
        closeFloat(conversationKey);
      else if (current.surfaceId !== source.surfaceId)
        openFloat(conversationKey, { ...source, surfaceId: current.surfaceId });
      return;
    }
    if (!autoFloat || principalKey === null) return;
    const candidate = pickAutoFloatCandidate(
      list,
      { projectSlug, threadIds, principalKey },
      (key) => {
        const shown = isSourceShown(key);
        return (
          isFloatHandedOff(conversationKey, key, shown) ||
          shown ||
          isFloatDismissed(conversationKey, key)
        );
      },
    );
    if (candidate?.surfaceId)
      openFloat(conversationKey, {
        kind: 'browser',
        browserSessionId: candidate.browserSessionId,
        surfaceId: candidate.surfaceId,
      });
  }, [
    list,
    source,
    autoFloat,
    projectSlug,
    conversationKey,
    principalKey,
    threadIds.join('\u0000'),
    shownVersion,
    polledAt,
  ]);

  const sourceKey = source ? floatSourceKey(source) : null;
  const shownInPane = useSourceShown(sourceKey);
  if (!source || shownInPane) return null;
  // TODO(#90 device batch): the Device source's player.
  if (source.kind !== 'browser') return null;
  const session = list?.find(
    (candidate) => candidate.browserSessionId === source.browserSessionId,
  );
  // Until the effect above closes it, a session that stopped being live
  // shows nothing rather than a live view of a surface that is gone.
  if (session?.state !== 'live' || !session.surfaceId) return null;
  return (
    <BrowserFloat
      key={source.surfaceId}
      anchor={anchor}
      conversationKey={conversationKey}
      source={source}
      session={session}
      receivedAt={receivedAt}
      apiBase={apiBase}
      transport={transport}
    />
  );
}

interface FloatLayoutMeasure {
  container: FloatSize;
  obstacles: FloatObstacles;
  /** Where the chat body sits inside the overlay's positioning ancestor. */
  offset: { left: number; top: number };
}

function sameMeasure(a: FloatLayoutMeasure, b: FloatLayoutMeasure): boolean {
  const ca = a.obstacles.composer;
  const cb = b.obstacles.composer;
  return (
    a.container.width === b.container.width &&
    a.container.height === b.container.height &&
    a.offset.left === b.offset.left &&
    a.offset.top === b.offset.top &&
    (ca === cb ||
      (ca !== null &&
        cb !== null &&
        ca.left === cb.left &&
        ca.right === cb.right &&
        ca.height === cb.height))
  );
}

/**
 * The chat body (the marker's parent) and what is docked below the marker
 * (the composer stack), in the body's own coordinates. The stack reserves
 * the body's full width from the marker down: everything under it is kept
 * clear. `offset` places the overlay over the body from whatever ancestor
 * positions it, so the overlay covers the body and not the history
 * sidebar beside it.
 */
function measureFloatLayout(anchor: HTMLElement): FloatLayoutMeasure | null {
  const body = anchor.parentElement;
  if (!body) return null;
  const area = body.getBoundingClientRect();
  const marker = anchor.getBoundingClientRect();
  const positioned = (
    anchor.offsetParent as HTMLElement | null
  )?.getBoundingClientRect();
  const below = Math.max(0, Math.ceil(area.bottom - marker.top));
  return {
    container: { width: area.width, height: area.height },
    obstacles: {
      composer:
        below > 0 ? { left: 0, right: area.width, height: below } : null,
    },
    offset: {
      left: positioned ? area.left - positioned.left : 0,
      top: positioned ? area.top - positioned.top : 0,
    },
  };
}

function useFloatLayout(anchor: HTMLElement): FloatLayoutMeasure | null {
  const [layout, setLayout] = useState<FloatLayoutMeasure | null>(null);
  useLayoutEffect(() => {
    const body = anchor.parentElement;
    const measure = () => {
      const next = measureFloatLayout(anchor);
      setLayout((current) =>
        current && next && sameMeasure(current, next) ? current : next,
      );
    };
    measure();
    window.addEventListener('resize', measure);
    // The composer stack grows on its own (drafts, attachments, quotes), and
    // what is docked below the marker comes and goes: the body, and each of
    // its children, are observed, and re-observed when they change.
    const resize =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(measure);
    const observeAll = () => {
      if (!resize || !body) return;
      resize.disconnect();
      resize.observe(body);
      for (const child of Array.from(body.children)) resize.observe(child);
    };
    observeAll();
    const mutations =
      typeof MutationObserver === 'undefined' || !body
        ? null
        : new MutationObserver(() => {
            observeAll();
            measure();
          });
    if (body) mutations?.observe(body, { childList: true });
    return () => {
      window.removeEventListener('resize', measure);
      resize?.disconnect();
      mutations?.disconnect();
    };
  }, [anchor]);
  return layout;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * The width to remember for a resize: never below the minimum. A chat too
 * tight for the minimum shows a smaller player (the container wins), but
 * that is the chat's size, not the user's choice, and must not be what the
 * player comes back at when there is room again.
 */
function chosenWidth(width: number): number {
  return Math.max(width, FLOAT_MIN_SIZE.width);
}

const CONTROLLER_TEXT: Record<LiveSurfaceControllerTone, string> = {
  agent: 'An agent is driving',
  you: 'You are in control',
  other: 'Someone else is in control',
  none: 'No one is in control',
};

/** Invisible grab zones straddling each edge; the cursor is the only affordance. */
const RESIZE_ZONES: readonly FloatResizeDirection[] = [
  'north',
  'south',
  'west',
  'east',
  'northwest',
  'northeast',
  'southwest',
  'southeast',
];

interface Gesture {
  pointerId: number;
  pointerX: number;
  pointerY: number;
  frame: FloatFrame;
  direction: FloatResizeDirection | null;
}

function BrowserFloat({
  anchor,
  conversationKey,
  source,
  session,
  receivedAt,
  apiBase,
  transport,
}: {
  anchor: HTMLElement;
  conversationKey: string;
  source: Extract<FloatSource, { kind: 'browser' }>;
  session: BrowserSessionView;
  /** When the list carrying `session` arrived (`performance.now()`). */
  receivedAt: number | undefined;
  apiBase: string;
  transport: FloatFetch;
}) {
  const layout = useFloatLayout(anchor);
  const agentInput = agentInputOf(session, receivedAt);
  const sourceKey = floatSourceKey(source);
  const host = hostOf(session.url);
  const openBrowser = useOpenBrowserSessionInRegion();
  const [notice, setNotice] = useState<string | null>(null);
  const [control, setControl] = useState<LiveSurfaceControlState | null>(null);

  const close = useCallback(
    () => dismissFloat(conversationKey, sourceKey),
    [conversationKey, sourceKey],
  );
  const openInPanel = useCallback(() => {
    if (!openBrowser) return;
    const request = {
      projectId: session.projectId,
      browserSessionId: session.browserSessionId,
    };
    let outcome = openBrowser(request, { region: 'right' });
    // A device whose fold offers no right region still has a dock: the
    // Browser pane's own default placement is the next best panel.
    if (!outcome.ok && outcome.reason === 'region-unavailable')
      outcome = openBrowser(request);
    // Not a dismissal: the pane is about to show it (and `shownSources`
    // keeps the floater away while it does); closing that pane later is not
    // the user saying "never float this here again". The hand-off only keeps
    // it from re-floating in the moment before the pane has mounted.
    if (outcome.ok) handOffFloat(conversationKey, sourceKey);
    else setNotice(describeOpenInRegionRefusal(outcome.reason));
  }, [openBrowser, session, conversationKey, sourceKey]);

  if (!layout) return null;
  // The overlay covers exactly the chat body, from whatever ancestor
  // positions it; it passes every pointer through except to its children.
  const overlay = {
    left: layout.offset.left,
    top: layout.offset.top,
    width: layout.container.width,
    height: layout.container.height,
  };
  if (layout.container.width < FLOAT_NARROW_WIDTH)
    return (
      <div className="float-over-chat" style={overlay}>
        <NarrowFloatNotice
          maxHeight={Math.max(
            0,
            layout.container.height -
              (layout.obstacles.composer?.height ?? 0) -
              FLOAT_EDGE_GAP * 2,
          )}
          host={host}
          agentInput={agentInput}
          notice={notice}
          canOpen={openBrowser !== null}
          onOpen={openInPanel}
          onClose={close}
        />
      </div>
    );
  return (
    <div className="float-over-chat" style={overlay}>
      <FloatPlayer
        layout={layout}
        sourceKey={sourceKey}
        sourceSize={{
          width: session.viewport.width,
          height: session.viewport.height,
        }}
        label={`Floating browser: ${host}`}
        control={control}
        agentInput={agentInput}
        notice={notice}
        canOpen={openBrowser !== null}
        onOpen={openInPanel}
        onClose={close}
      >
        <LiveSurfaceCanvas
          apiBase={apiBase}
          surfaceId={source.surfaceId}
          label={`Browser: ${host}`}
          transport={transport}
          hostControls
          inputRequiresLease
          onControlState={setControl}
        />
      </FloatPlayer>
    </div>
  );
}

/**
 * The narrow-width fallback: no player (it would cover the conversation, and
 * a live view nobody can use is a stream for nothing), but the source is
 * still discoverable here with the same two actions.
 */
function NarrowFloatNotice({
  maxHeight,
  host,
  agentInput,
  notice,
  canOpen,
  onOpen,
  onClose,
}: {
  /** The rows above the composer stack: the notice stays off it too. */
  maxHeight: number;
  host: string;
  /** No live view here, so no lease reading: the same derivation, holder unknown. */
  agentInput: RecentAgentInput;
  notice: string | null;
  canOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const agentDriving = useRecentDriver(null, agentInput) === 'agent';
  return (
    <section
      className="float-over-chat__narrow"
      aria-label={`Floating browser: ${host}`}
      style={{ maxHeight }}
    >
      <p className="float-over-chat__narrow-text">
        {agentDriving ? 'An agent is driving a browser' : 'A browser is open'}{' '}
        at {host}. The chat is too narrow to float it here.
      </p>
      {notice ? (
        <p className="float-over-chat__notice" role="status">
          {notice}
        </p>
      ) : null}
      <div className="float-over-chat__narrow-actions">
        <Button
          size="sm"
          className="float-over-chat__action"
          disabled={!canOpen}
          title={canOpen ? undefined : 'No panel can open here'}
          onClick={onOpen}
        >
          Open in right panel
        </Button>
        <Button size="sm" className="float-over-chat__action" onClick={onClose}>
          Close
        </Button>
      </div>
    </section>
  );
}

function FloatPlayer({
  layout,
  sourceKey,
  sourceSize,
  label,
  control,
  agentInput,
  notice,
  canOpen,
  onOpen,
  onClose,
  children,
}: {
  layout: FloatLayoutMeasure;
  sourceKey: string;
  sourceSize: FloatSize;
  label: string;
  control: LiveSurfaceControlState | null;
  /** What the agent-driving window is derived from (`agentInputOf`). */
  agentInput: RecentAgentInput;
  notice: string | null;
  canOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  useFloatStoreVersion();
  const placement = getFloatPlacement();
  const { container, obstacles } = layout;
  const frame = resolveFloatFrame({
    width: placement.width,
    position: placement.position,
    source: sourceSize,
    container,
    obstacles,
  });
  const gestureRef = useRef<Gesture | null>(null);
  const pillId = useId();
  const dotRef = useRef<HTMLButtonElement>(null);
  const [pillOpen, setPillOpen] = useState(false);
  /** Escape closed the pill: focus returning to the dot must not reopen it. */
  const suppressRef = useRef(false);
  // Who is driving, derived with the narrow notice's own rule: the live
  // lease, or an agent that drove within the recent window.
  const tone = useRecentDriver(control?.tone ?? null, agentInput);
  const canClaim =
    control !== null && control.status === 'live' && tone !== 'you';

  const beginGesture = (
    event: ReactPointerEvent<HTMLElement>,
    direction: FloatResizeDirection | null,
  ) => {
    if (event.button !== 0) return;
    gestureRef.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      frame,
      direction,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const moveGesture = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const delta = {
      x: event.clientX - gesture.pointerX,
      y: event.clientY - gesture.pointerY,
    };
    if (gesture.direction === null) {
      setFloatPlacement(
        {
          width: placement.width, // a move keeps the width the user CHOSE, not a tight chat's
          position: clampFloatPosition(
            { x: gesture.frame.x + delta.x, y: gesture.frame.y + delta.y },
            container,
            gesture.frame,
            obstacles,
          ),
        },
        { persist: false },
      );
      return;
    }
    const next = resizeFloatFrame({
      start: gesture.frame,
      direction: gesture.direction,
      delta,
      source: sourceSize,
      container,
      obstacles,
    });
    setFloatPlacement(
      { width: chosenWidth(next.width), position: { x: next.x, y: next.y } },
      { persist: false },
    );
  };

  const endGesture = (event: ReactPointerEvent<HTMLElement>) => {
    if (gestureRef.current?.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    // Written for this device once the gesture settles, not per move.
    setFloatPlacement(getFloatPlacement(), { persist: true });
  };

  const onHandleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!isFloatArrowKey(event.key)) return;
    event.preventDefault();
    const next = nudgeFloatFrame({
      frame,
      key: event.key,
      resize: event.shiftKey,
      source: sourceSize,
      container,
      obstacles,
    });
    setFloatPlacement(
      {
        width: event.shiftKey ? chosenWidth(next.width) : placement.width,
        position: { x: next.x, y: next.y },
      },
      { persist: true },
    );
  };

  const onChromeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || !pillOpen) return;
    event.stopPropagation();
    suppressRef.current = true;
    setPillOpen(false);
    dotRef.current?.focus();
  };

  const status = control ? CONTROLLER_TEXT[tone] : 'Connecting…';
  return (
    <section
      className="float-over-chat__player"
      aria-label={label}
      data-float-source={sourceKey}
      data-tone={tone}
      style={{
        left: frame.x,
        top: frame.y,
        width: frame.width,
        height: frame.height,
      }}
    >
      <div className="float-over-chat__surface">{children}</div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the chrome only routes hover and Escape to its own buttons, which carry the semantics. */}
      <div
        className="float-over-chat__chrome"
        onPointerEnter={() => setPillOpen(true)}
        onPointerLeave={(event) => {
          if (!event.currentTarget.contains(document.activeElement))
            setPillOpen(false);
        }}
        onFocus={() => {
          if (!suppressRef.current) setPillOpen(true);
        }}
        onBlur={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node)) return;
          suppressRef.current = false;
          setPillOpen(false);
        }}
        onKeyDown={onChromeKeyDown}
      >
        {/* Who is in control, announced whether or not the pill is open:
              the region is always mounted, so a change is never missed. */}
        <p className="sr-only" aria-live="polite">
          {status}
        </p>
        <button
          ref={dotRef}
          type="button"
          className="float-over-chat__dot"
          data-tone={tone}
          aria-label={`Floating browser controls. ${status}.`}
          aria-expanded={pillOpen}
          aria-controls={pillOpen ? pillId : undefined}
          onClick={() => {
            suppressRef.current = false;
            // Idempotent: focus already opened the pill, so the Enter or Space
            // that follows (a click) must not close it. Escape and leaving do.
            setPillOpen(true);
          }}
        >
          <span className="float-over-chat__dot-mark" aria-hidden="true" />
        </button>
        {pillOpen ? (
          <div
            id={pillId}
            className="float-over-chat__pill"
            role="toolbar"
            aria-label="Floating browser"
          >
            <button
              type="button"
              className="float-over-chat__handle"
              aria-label="Move floating browser. Arrow keys move it; Shift and an arrow key resize it."
              title="Drag to move"
              onPointerDown={(event) => beginGesture(event, null)}
              onPointerMove={moveGesture}
              onPointerUp={endGesture}
              onPointerCancel={endGesture}
              onKeyDown={onHandleKeyDown}
            >
              <MenuGlyph />
            </button>
            <p
              className="float-over-chat__controller"
              data-tone={tone}
              aria-hidden="true"
            >
              {status}
            </p>
            {canClaim ? (
              <Button
                size="sm"
                className="float-over-chat__action"
                onClick={() => void control?.claimControl()}
              >
                Take control
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              className="float-over-chat__action float-over-chat__icon"
              aria-label="Open in right panel"
              title={canOpen ? 'Open in right panel' : 'No panel can open here'}
              disabled={!canOpen}
              onClick={onOpen}
            >
              <MonitorGlyph />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="float-over-chat__action float-over-chat__icon"
              aria-label="Close floating browser"
              title="Close"
              onClick={onClose}
            >
              <CloseGlyph />
            </Button>
            {notice ? (
              <p className="float-over-chat__notice" role="status">
                {notice}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
      {RESIZE_ZONES.map((direction) => (
        <div
          key={direction}
          role="presentation"
          className={`float-over-chat__resize float-over-chat__resize--${direction}`}
          data-float-resize={direction}
          onPointerDown={(event) => beginGesture(event, direction)}
          onPointerMove={moveGesture}
          onPointerUp={endGesture}
          onPointerCancel={endGesture}
        />
      ))}
    </section>
  );
}
