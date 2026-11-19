import { onlineManager } from '@tanstack/react-query';
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useCoarsePointer } from '../../hooks/useCoarsePointer';
import { triggerHaptic } from '../../platform/native/haptics';
import { ActionOverflowMenu } from '../ActionOverflowMenu';
import { RefreshGlyph } from '../icons/Glyph';
import {
  LiveStatusGlyph,
  type LiveStatusGlyphKind,
  trackPageVisibilityForStatusMotion,
} from '../status/LiveStatusGlyph';
import './ListRefresh.css';

const BACKGROUND_DELAY_MS = 300;
const RESULT_HOLD_MS = 1_800;
const PULL_THRESHOLD_PX = 64;
const GESTURE_SLOP_PX = 8;

const subscribeOnline = (listener: () => void) =>
  onlineManager.subscribe(listener);
const isOnline = () =>
  onlineManager.isOnline() &&
  (typeof navigator === 'undefined' || navigator.onLine !== false);

type Refetch = (options: {
  cancelRefetch: boolean;
  throwOnError: boolean;
}) => Promise<unknown>;

export async function refreshListQueries(...reads: Refetch[]): Promise<void> {
  const results = await Promise.allSettled(
    reads.map(async (read) =>
      read({ cancelRefetch: false, throwOnError: true }),
    ),
  );
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
}

type RefreshPhase = 'idle' | 'refreshing' | 'done' | 'failed';

export function useListRefresh({
  scope,
  refresh,
  enabled = true,
}: {
  scope: string;
  refresh: (recover: boolean) => Promise<void>;
  enabled?: boolean;
}) {
  const [state, setState] = useState<{
    scope: string;
    phase: RefreshPhase;
    recovering: boolean;
  }>();
  const inFlight = useRef<symbol | null>(null);
  const clearResult = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const activeScope = useRef<string | null>(null);
  const operation = useRef(refresh);
  useLayoutEffect(() => {
    operation.current = refresh;
  }, [refresh]);
  useLayoutEffect(() => {
    activeScope.current = enabled ? scope : null;
    setState(undefined);
    return () => {
      activeScope.current = null;
      inFlight.current = null;
      clearTimeout(clearResult.current);
    };
  }, [scope, enabled]);

  const run = useCallback(
    (recover = false) => {
      if (activeScope.current !== scope || inFlight.current) return;
      clearTimeout(clearResult.current);
      setState({ scope, phase: 'refreshing', recovering: recover });

      const attempt = Symbol();
      inFlight.current = attempt;
      void (async () => {
        let phase: RefreshPhase = 'done';
        try {
          if (!isOnline()) throw new Error('Offline');
          await operation.current(recover);
        } catch {
          phase = 'failed';
        }
        if (inFlight.current !== attempt) return;
        inFlight.current = null;
        setState({ scope, phase, recovering: false });
        clearResult.current = setTimeout(
          () => setState(undefined),
          RESULT_HOLD_MS,
        );
      })();
    },
    [scope],
  );

  const visibleState = enabled && state?.scope === scope ? state : undefined;
  const phase = visibleState?.phase ?? 'idle';
  const recovering = visibleState?.recovering ?? false;
  return useMemo(() => ({ run, phase, recovering }), [run, phase, recovering]);
}

export type ListRefresh = ReturnType<typeof useListRefresh>;

export function ListRefreshStatus({
  phase = 'idle',
  updating = false,
  activity,
  dockClearance = false,
}: {
  phase?: RefreshPhase;
  updating?: boolean;
  activity: string;
  dockClearance?: boolean;
}) {
  const [showBackground, setShowBackground] = useState(false);
  useEffect(trackPageVisibilityForStatusMotion, []);
  const online = useSyncExternalStore(subscribeOnline, isOnline, () => true);
  useEffect(() => {
    if (!updating) {
      setShowBackground(false);
      return;
    }
    const timer = setTimeout(
      () => setShowBackground(true),
      BACKGROUND_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [updating]);

  const state =
    !online && (phase === 'refreshing' || phase === 'failed')
      ? 'offline'
      : phase === 'idle' && updating && showBackground
        ? 'updating'
        : phase;
  const label = {
    idle: '',
    updating: activity,
    refreshing: activity,
    done: 'Updated',
    failed: 'Couldn’t refresh',
    offline: 'Waiting for connection',
  }[state];
  const glyphs: Record<typeof state, LiveStatusGlyphKind> = {
    idle: 'idle',
    updating: 'working',
    refreshing: 'working',
    done: 'done',
    failed: 'attention',
    offline: 'attention',
  };

  return (
    <div
      className="list-refresh__status"
      data-dock-clearance={dockClearance || undefined}
      aria-live="polite"
      aria-atomic="true"
    >
      {state !== 'idle' && (
        <div
          className="list-refresh__pill"
          data-state={state}
          aria-hidden={state === 'updating' || undefined}
        >
          <LiveStatusGlyph kind={glyphs[state]} />
          <span>{label}</span>
        </div>
      )}
    </div>
  );
}

export function ListRefreshActions({
  label,
  refreshLabel,
  refresh,
}: {
  label: string;
  refreshLabel: string;
  refresh: ListRefresh;
}) {
  const coarsePointer = useCoarsePointer();
  return (
    <div
      className="list-refresh__actions"
      data-coarse-pointer={coarsePointer || undefined}
    >
      <ActionOverflowMenu
        label={label}
        actions={[
          {
            key: 'refresh',
            label: refreshLabel,
            glyph: <RefreshGlyph />,
            onSelect: () => refresh.run(),
          },
        ]}
      />
    </div>
  );
}

export function ListRefreshPull({
  surfaceRef,
  refresh,
  enabled = true,
  children,
}: {
  surfaceRef: RefObject<HTMLElement | null>;
  refresh?: ListRefresh;
  enabled?: boolean;
  children: ReactNode;
}) {
  usePullToRefresh(surfaceRef, enabled ? refresh?.run : undefined);
  if (!refresh) return children;
  return (
    <>
      <div className="list-refresh__pull" aria-hidden="true">
        <span className="list-refresh__ring-badge">
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <circle
              className="list-refresh__ring-track"
              cx="10"
              cy="10"
              r="7"
            />
            <circle
              className="list-refresh__ring-progress"
              cx="10"
              cy="10"
              r="7"
              pathLength="1"
            />
          </svg>
        </span>
      </div>
      <div className="list-refresh__pull-content">{children}</div>
    </>
  );
}

function scrollOwner(target: Element) {
  for (
    let element: Element | null = target;
    element;
    element = element.parentElement
  ) {
    const style = getComputedStyle(element);
    if (
      /^(auto|scroll|overlay)$/.test(style.overflowY) &&
      (element.scrollHeight > element.clientHeight ||
        style.overscrollBehaviorY === 'contain' ||
        style.overscrollBehaviorY === 'none')
    )
      return element;
  }
  return document.scrollingElement;
}

function usePullToRefresh(
  ref: RefObject<HTMLElement | null>,
  refresh?: ListRefresh['run'],
) {
  useEffect(() => {
    const surface = ref.current;
    if (!surface || !refresh) return;

    let origin: Touch | undefined;
    let distance = 0;
    let pulsed = false;
    let scroller: Element | null = null;
    const clearPull = () => {
      distance = 0;
      delete surface.dataset.listRefreshPull;
      surface.style.removeProperty('--list-refresh-pull');
      surface.style.removeProperty('--list-refresh-stretch');
    };
    const reset = () => {
      origin = undefined;
      scroller = null;
      clearPull();
    };
    const start = (event: TouchEvent) => {
      reset();
      pulsed = false;
      const target = event.target;
      if (
        event.touches.length === 1 &&
        target instanceof Element &&
        !target.closest(
          'input, textarea, select, [contenteditable], [draggable="true"]',
        )
      ) {
        scroller = scrollOwner(target);
        if ((scroller?.scrollTop ?? 0) <= 1) origin = event.touches[0];
      }
    };
    const move = (event: TouchEvent) => {
      if (!origin) return;
      const touch = event.touches[0];
      if (
        event.touches.length !== 1 ||
        touch.identifier !== origin.identifier ||
        !event.cancelable
      ) {
        reset();
        return;
      }
      const dy = touch.clientY - origin.clientY;
      const dx = Math.abs(touch.clientX - origin.clientX);
      if (Math.max(Math.abs(dy), dx) < GESTURE_SLOP_PX) {
        if (distance > 0) {
          event.preventDefault();
          clearPull();
        }
        return;
      }
      if (dy <= dx || (scroller?.scrollTop ?? 0) > 1) {
        reset();
        return;
      }
      event.preventDefault();
      distance = dy;
      const progress = Math.min(dy / PULL_THRESHOLD_PX, 1);
      const beyond = Math.max(0, dy - PULL_THRESHOLD_PX);
      const stretch = progress + 0.3 * (1 - Math.exp(-beyond / 64));
      const ready = progress === 1;
      if (ready && !pulsed) {
        pulsed = true;
        triggerHaptic('selection');
      }
      surface.dataset.listRefreshPull = ready ? 'ready' : 'pulling';
      surface.style.setProperty('--list-refresh-pull', String(progress));
      surface.style.setProperty('--list-refresh-stretch', String(stretch));
    };
    const end = (event: TouchEvent) => {
      const armed =
        distance >= PULL_THRESHOLD_PX &&
        event.touches.length === 0 &&
        Array.from(event.changedTouches).some(
          (touch) => touch.identifier === origin?.identifier,
        );
      reset();
      if (armed) refresh();
    };
    const cancelMultipleTouches = (event: TouchEvent) => {
      if (origin && event.touches.length > 1) reset();
    };
    document.addEventListener('touchstart', cancelMultipleTouches, {
      passive: true,
      capture: true,
    });
    surface.addEventListener('touchstart', start, { passive: true });
    surface.addEventListener('touchmove', move, { passive: false });
    surface.addEventListener('touchend', end, { passive: true });
    surface.addEventListener('touchcancel', reset);
    return () => {
      reset();
      document.removeEventListener('touchstart', cancelMultipleTouches, true);
      surface.removeEventListener('touchstart', start);
      surface.removeEventListener('touchmove', move);
      surface.removeEventListener('touchend', end);
      surface.removeEventListener('touchcancel', reset);
    };
  }, [refresh, ref]);
}
