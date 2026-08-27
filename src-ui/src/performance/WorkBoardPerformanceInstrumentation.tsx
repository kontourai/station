import {
  getResolvedSpatialBoard,
  getSpatialBoard,
  spatialBoardQueries,
  useResolvedSpatialBoardQuery,
  useSpatialBoardQuery,
} from '@kontourai/station-sdk/spatial-board';
import { useQueryClient } from '@tanstack/react-query';
import { type RefObject, useEffect, useRef } from 'react';
import {
  registerWorkBoardPerformanceDriver,
  WORK_BOARD_DRIVER_READY_EVENT,
} from './work-board-performance-bridge';
import {
  createWorkBoardPerformanceDriver,
  waitForBoardCommit,
} from './work-board-performance-driver';

/** Loaded only in the dedicated interactive-performance Vite build. */
export function WorkBoardPerformanceInstrumentation({
  rootRef,
}: {
  rootRef: RefObject<HTMLElement | null>;
}) {
  const board = useSpatialBoardQuery();
  const resolved = useResolvedSpatialBoardQuery();
  const queryClient = useQueryClient();
  const latest = useRef({ board, resolved });
  const interactionIteration = useRef(0);
  latest.current = { board, resolved };

  useEffect(() => {
    const restore = async (cold: boolean) => {
      if (cold) {
        const [nextBoard, nextResolved] = await Promise.all([
          getSpatialBoard(),
          getResolvedSpatialBoard(),
        ]);
        queryClient.setQueryData(['spatial-board'], nextBoard);
        queryClient.setQueryData(
          spatialBoardQueries.resolved().queryKey,
          nextResolved,
        );
      } else {
        await Promise.all([
          latest.current.board.refetch(),
          latest.current.resolved.refetch(),
        ]);
      }
      await nextBoardFrame();
    };
    const resolve = async () => {
      await latest.current.resolved.refetch();
      await nextBoardFrame();
    };
    const interaction = async (kind: 'keyboard' | 'pointer') => {
      const before = latest.current.board.data?.revision;
      if (before === undefined)
        throw new Error('Work Board interaction surface is unavailable');
      const driver = window.__stationInteractiveWorkspacePerformanceDriver;
      if (!driver)
        throw new Error('Work Board trusted input driver is unavailable');
      const receipt = await driver({
        kind:
          kind === 'keyboard'
            ? 'work-board-keyboard-move-resize'
            : 'work-board-pointer-move-resize',
        iteration: interactionIteration.current++,
      });
      if (receipt.kind !== 'work-board-interaction-completed')
        throw new Error('Work Board trusted input receipt is unavailable');
      await waitForBoardCommit(() => latest.current.board.data, before);
    };
    const unregister = registerWorkBoardPerformanceDriver(
      createWorkBoardPerformanceDriver({
        board: () => latest.current.board.data,
        coldRestore: () => restore(true),
        warmRestore: () => restore(false),
        resolve,
        keyboardMoveResize: () => interaction('keyboard'),
        pointerMoveResize: () => interaction('pointer'),
        growth: () => {
          const root = rootRef.current;
          return {
            boardDomNodes: root?.querySelectorAll('*').length ?? 0,
            boardListeners:
              root?.querySelectorAll('[data-station-work-board-listener]')
                .length ?? 0,
            boardPendingInteractions:
              root?.querySelectorAll(
                '.spatial-board__move:disabled, .spatial-board__resize:disabled',
              ).length ?? 0,
            boardQueryCacheEntries: queryClient
              .getQueryCache()
              .findAll({ queryKey: ['spatial-board'] }).length,
          };
        },
        physicallyAvailable: () =>
          document.visibilityState === 'visible' && navigator.onLine,
      }),
    );
    // The adapter waits for this one-shot signal rather than sampling the
    // mutable driver registry or any Board state.
    window.dispatchEvent(new Event(WORK_BOARD_DRIVER_READY_EVENT));
    return unregister;
  }, [queryClient, rootRef]);
  return null;
}

function nextBoardFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
