import {
  type ComponentProps,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button } from '../Button';
import { ErrorState } from '../state';
import { TranscriptTurnRail, turnStepTarget } from './TranscriptTurnRail';
import type { TranscriptTurnLandmark } from './transcriptTurnLandmarks';
import { useTranscriptTurnDirectory } from './useTranscriptTurnDirectory';

type Props = ComponentProps<typeof TranscriptTurnRail> & {
  conversationId: string;
  onLoadTurn: (turnId: string, signal: AbortSignal) => Promise<boolean>;
  activeStartVisible: boolean;
};

export const IndexedTranscriptTurnRail = memo(
  function IndexedTranscriptTurnRail({
    conversationId,
    onLoadTurn,
    activeStartVisible,
    ...props
  }: Props) {
    const directory = useTranscriptTurnDirectory(conversationId);
    const [failure, setFailure] = useState(false);
    const request = useRef<AbortController | null>(null);
    useEffect(() => () => request.current?.abort(), []);
    // Only metadata is paged here. Transcript bodies stay behind a deliberate jump.
    useEffect(() => {
      if (directory.hasNextPage && !directory.isFetching && !directory.isError)
        void directory.fetchNextPage();
    }, [
      directory.hasNextPage,
      directory.isFetching,
      directory.isError,
      directory.fetchNextPage,
    ]);
    const indexed =
      (directory.data?.pages[0]?.session.turnCount ?? 0) > 0 &&
      !directory.hasNextPage;
    const landmarks = useMemo(() => {
      if (!indexed) return props.landmarks;
      const loaded = new Map(
        props.landmarks.map((mark) => [mark.turnId, mark]),
      );
      const turns = directory
        .data!.pages.flatMap((page) => page?.turns ?? [])
        .toReversed();
      const known = new Set(turns.map((turn) => turn.turnId));
      const mapped = turns.map(
        (turn): TranscriptTurnLandmark => ({
          rowId: loaded.get(turn.turnId)?.rowId ?? `indexed:${turn.turnId}`,
          turnId: turn.turnId,
          rowIndex: 0,
          endRowIndex: 0,
          prompt: turn.request ?? 'Turn',
          reply: loaded.get(turn.turnId)?.reply,
          marker:
            turn.outcome === 'failed'
              ? 'failed'
              : loaded.get(turn.turnId)?.marker,
        }),
      );
      mapped.push(
        ...props.landmarks.filter(
          (mark) => !mark.turnId || !known.has(mark.turnId),
        ),
      );
      return mapped.map((mark, index) => ({
        ...mark,
        rowIndex: index,
        endRowIndex: index + 1,
      }));
    }, [indexed, directory.data, props.landmarks]);
    const activeRow = props.landmarks[props.activeTurn];
    const activeTurn = indexed
      ? Math.max(
          0,
          landmarks.findIndex((mark) => mark.rowId === activeRow?.rowId),
        )
      : props.activeTurn;
    const jump = useCallback(
      async (index: number) => {
        const mark = landmarks[index];
        if (!mark) return;
        request.current?.abort();
        const loaded = props.landmarks.findIndex(
          (item) =>
            item.rowId === mark.rowId ||
            (!!mark.turnId && item.turnId === mark.turnId),
        );
        if (loaded >= 0) {
          props.onJump(loaded);
          return;
        }
        if (!mark.turnId) return;
        const controller = new AbortController();
        request.current = controller;
        setFailure(false);
        try {
          const found = await onLoadTurn(mark.turnId, controller.signal);
          if (!controller.signal.aborted) setFailure(!found);
        } catch {
          if (!controller.signal.aborted) setFailure(true);
        }
      },
      [landmarks, props.landmarks, props.onJump, onLoadTurn],
    );
    useEffect(() => {
      void landmarks;
      props.scrollElement.current?.dispatchEvent(new Event('scroll'));
    }, [landmarks, props.scrollElement]);
    const viewport = { activeTurn, activeStartVisible };
    return (
      <>
        {failure && (
          <ErrorState
            variant="compact"
            title="Could not reach this turn"
            action={<Button onClick={props.onBrowse}>Browse turns</Button>}
          />
        )}
        <TranscriptTurnRail
          {...props}
          landmarks={landmarks}
          indexed={indexed}
          rowCount={indexed ? landmarks.length : props.rowCount}
          activeTurn={activeTurn}
          olderHistory={indexed ? false : props.olderHistory}
          previousTurn={
            indexed
              ? turnStepTarget(viewport, -1, landmarks.length)
              : props.previousTurn
          }
          nextTurn={
            indexed
              ? turnStepTarget(viewport, 1, landmarks.length)
              : props.nextTurn
          }
          onJump={jump}
          onStep={jump}
        />
      </>
    );
  },
);
