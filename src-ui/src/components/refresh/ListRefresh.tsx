import { onlineManager } from '@tanstack/react-query';
import {
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
import { ActionOverflowMenu } from '../ActionOverflowMenu';
import { CheckGlyph, RefreshGlyph, WarningGlyph } from '../icons/Glyph';
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

export function ListRefreshIndicator({
  phase = 'idle',
  updating = false,
}: {
  phase?: RefreshPhase;
  updating?: boolean;
}) {
  const [showBackground, setShowBackground] = useState(false);
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
    updating: 'Updating…',
    refreshing: 'Refreshing…',
    done: 'Updated',
    failed: 'Couldn’t refresh',
    offline: 'Waiting for connection',
  }[state];
  const glyph =
    state === 'done' ? (
      <CheckGlyph />
    ) : state === 'failed' ? (
      <WarningGlyph />
    ) : (
      <RefreshGlyph />
    );
  return (
    <span className="list-refresh__indicator" data-state={state} title={label}>
      {state !== 'idle' && <span aria-hidden="true">{glyph}</span>}
      <span className="sr-only" aria-live="polite">
        {state === 'updating' ? '' : label}
      </span>
    </span>
  );
}

export function ListRefreshActions({
  label,
  refreshLabel,
  refresh,
  updating,
}: {
  label: string;
  refreshLabel: string;
  refresh: ListRefresh;
  updating?: boolean;
}) {
  const coarsePointer = useCoarsePointer();
  return (
    <div
      className="list-refresh__actions"
      data-coarse-pointer={coarsePointer || undefined}
    >
      <ListRefreshIndicator phase={refresh.phase} updating={updating} />
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

export function usePullToRefresh(
  ref: RefObject<HTMLElement | null>,
  refresh?: ListRefresh['run'],
) {
  useEffect(() => {
    const surface = ref.current;
    if (!surface || !refresh) return;

    let origin: Touch | undefined;
    let distance = 0;
    let scroller: Element | null = null;
    const reset = () => {
      origin = undefined;
      distance = 0;
      scroller = null;
      delete surface.dataset.listRefreshPull;
    };
    const start = (event: TouchEvent) => {
      reset();
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
          distance = 0;
          delete surface.dataset.listRefreshPull;
        }
        return;
      }
      if (dy <= dx || (scroller?.scrollTop ?? 0) > 1) {
        reset();
        return;
      }
      event.preventDefault();
      distance = dy;
      surface.dataset.listRefreshPull =
        dy >= PULL_THRESHOLD_PX ? 'ready' : 'pulling';
    };
    const end = () => {
      const armed = distance >= PULL_THRESHOLD_PX;
      reset();
      if (armed) refresh();
    };
    surface.addEventListener('touchstart', start, { passive: true });
    surface.addEventListener('touchmove', move, { passive: false });
    surface.addEventListener('touchend', end, { passive: true });
    surface.addEventListener('touchcancel', reset);
    return () => {
      reset();
      surface.removeEventListener('touchstart', start);
      surface.removeEventListener('touchmove', move);
      surface.removeEventListener('touchend', end);
      surface.removeEventListener('touchcancel', reset);
    };
  }, [refresh, ref]);
}
