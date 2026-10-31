import { getConversationTurnDirectory } from '@kontourai/station-sdk/client';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { Empty, ErrorState, SkeletonList } from '../state';
import type { TranscriptTurnLandmark } from './transcriptTurnLandmarks';
import './TranscriptTurnBrowser.css';

export function TranscriptTurnBrowser({
  conversationId,
  landmarks,
  onJumpLoaded,
  onLoadTurn,
  onClose,
}: {
  conversationId?: string;
  landmarks: readonly TranscriptTurnLandmark[];
  onJumpLoaded(index: number): void;
  onLoadTurn?: (turnId: string, signal: AbortSignal) => Promise<boolean>;
  onClose(): void;
}) {
  const scope = useHostRequestAuthorityScope();
  const directoryEnabled = useSurfaceVisibilityFlags().has('session-cli-reads');
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const directory = useInfiniteQuery({
    queryKey: [
      'conversation-turn-directory',
      scope?.apiBase,
      scope?.authorityKey,
      conversationId,
    ],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) =>
      getConversationTurnDirectory(scope!.apiBase, conversationId!, pageParam, {
        signal,
        requestScope: scope!,
      }),
    getNextPageParam: (page) => page?.nextCursor ?? undefined,
    enabled: directoryEnabled && !!conversationId && !!scope?.isCurrent(),
    retry: false,
    staleTime: 10_000,
  });
  const indexed = directory.data?.pages[0] != null;
  const turns =
    directory.data?.pages.flatMap((page) => page?.turns ?? []) ?? [];
  const openTurn = async (turnId: string) => {
    const loaded = landmarks.findIndex((mark) => mark.turnId === turnId);
    if (loaded >= 0 && !onLoadTurn) {
      onJumpLoaded(loaded);
      onClose();
      return;
    }
    if (!onLoadTurn || pending) return;
    const request = new AbortController();
    controller.current?.abort();
    controller.current = request;
    setPending(turnId);
    setFailure(null);
    try {
      const found = await onLoadTurn(turnId, request.signal);
      if (!request.signal.aborted) {
        if (found) onClose();
        else
          setFailure(
            'Could not reach this turn yet. Try again to continue loading.',
          );
      }
    } catch {
      if (!request.signal.aborted)
        setFailure('Could not load this turn. Try again.');
    } finally {
      if (!request.signal.aborted) setPending(null);
    }
  };
  return (
    <Dialog
      title="Browse turns"
      closeLabel="Close turn browser"
      onClose={onClose}
    >
      <div className="transcript-turn-browser" aria-busy={Boolean(pending)}>
        {directory.isLoading && (
          <SkeletonList count={4} label="Loading turn directory" />
        )}
        {directory.isError && (
          <ErrorState
            variant="compact"
            title="Turn directory unavailable"
            action={
              <Button
                variant="secondary"
                onClick={() => void directory.refetch()}
              >
                Retry
              </Button>
            }
          />
        )}
        {failure && <ErrorState variant="compact" title={failure} />}
        {pending && <p role="status">Loading the selected turn…</p>}
        {indexed ? (
          <ol className="transcript-turn-browser__list">
            {turns.map((turn, index) => (
              <li key={turn.turnId}>
                <Button
                  variant="ghost"
                  disabled={Boolean(pending)}
                  onClick={() => void openTurn(turn.turnId)}
                >
                  <span className="transcript-turn-browser__number">
                    {directory.data!.pages[0]!.session.turnCount - index}
                  </span>
                  <span className="transcript-turn-browser__prompt">
                    {turn.request || 'Turn'}
                  </span>
                  <span
                    role="img"
                    title={turn.outcome}
                    aria-label={turn.outcome}
                  >
                    {turn.outcome === 'completed'
                      ? '✓'
                      : turn.outcome === 'open'
                        ? '◌'
                        : '!'}
                  </span>
                </Button>
              </li>
            ))}
          </ol>
        ) : (
          !directory.isLoading && (
            <ol className="transcript-turn-browser__list">
              {landmarks.map((turn, index) => (
                <li key={turn.rowId}>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      onJumpLoaded(index);
                      onClose();
                    }}
                  >
                    {turn.prompt}
                  </Button>
                </li>
              ))}
            </ol>
          )
        )}
        {indexed && turns.length === 0 && (
          <Empty variant="compact" label="No turns yet" />
        )}
        {directory.hasNextPage && (
          <Button
            variant="ghost"
            disabled={directory.isFetchingNextPage || Boolean(pending)}
            onClick={() => void directory.fetchNextPage()}
          >
            Older turns
          </Button>
        )}
      </div>
    </Dialog>
  );
}
