import type { UnifiedSearchMessagePageRequest } from '@kontourai/station-contracts/unified-search';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { Button } from '../Button';
import { MessageContent } from '../chat/message-bubble/MessageContent';
import { Dialog } from '../Dialog';
import { ErrorState, SkeletonBlock } from '../state';

export function ExactMessageInspector({
  locator,
  scope,
  onClose,
  onBack,
}: {
  locator: UnifiedSearchMessagePageRequest;
  scope: NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
  onClose: () => void;
  onBack: () => void;
}) {
  const [cursors, setCursors] = useState<Array<string | undefined>>([
    undefined,
  ]);
  const continuation = cursors.at(-1);
  const request = {
    sessionId: locator.sessionId,
    matchedEventId: locator.matchedEventId,
    ...(continuation ? { continuation } : {}),
  };
  const queryKey = [
    'exact-search-message',
    scope.apiBase,
    scope.authorityKey,
    request,
  ];
  const client = useQueryClient();
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const ownedQuery = client.getQueryCache().find({ queryKey, exact: true });
      const ownedRequest = ownedQuery?.promise;
      try {
        const { readSearchMessage } = await import(
          '@kontourai/station-sdk/client'
        );
        if (signal.aborted || !scope.isCurrent())
          throw new Error('Search authority unavailable');
        return await readSearchMessage(scope.apiBase, request, {
          requestScope: scope,
          signal,
        });
      } catch (error) {
        if (
          ownedRequest &&
          ownedQuery?.promise === ownedRequest &&
          client.getQueryCache().find({ queryKey, exact: true }) === ownedQuery
        )
          ownedQuery.setState({ data: undefined });
        throw error;
      }
    },
    enabled: scope.isCurrent(),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
  });
  const page =
    scope.isCurrent() &&
    query.isFetchedAfterMount &&
    !query.isFetching &&
    !query.isError &&
    query.data?.state === 'available'
      ? query.data.page
      : undefined;
  const contentRef = useRef<HTMLElement>(null);
  const revealed = useRef(false);
  useEffect(() => {
    if (page && !revealed.current) {
      revealed.current = true;
      contentRef.current?.focus();
      contentRef.current?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [page]);
  return (
    <Dialog
      title="Matched message — read-only"
      closeLabel="Close matched message"
      onClose={onClose}
      size="lg"
      subtitle={`Session ${locator.sessionId} · Event ${locator.matchedEventId}`}
      footer={
        <>
          <Button variant="secondary" onClick={onBack}>
            Back to workspace search
          </Button>
          {cursors.length > 1 && (
            <Button
              variant="secondary"
              onClick={() => setCursors((value) => value.slice(0, -1))}
            >
              Previous text page
            </Button>
          )}
          {page?.nextContinuation && (
            <Button
              variant="secondary"
              onClick={() =>
                setCursors((value) => [...value, page.nextContinuation])
              }
            >
              Next text page
            </Button>
          )}
        </>
      }
    >
      {query.isFetching && scope.isCurrent() ? (
        <SkeletonBlock count={2} label="Reading exact message" />
      ) : page ? (
        <>
          <p>
            {page.role === 'user' ? 'User message' : 'Agent message'} ·{' '}
            {page.assignedAgentId
              ? `Agent: ${page.assignedAgentId}`
              : 'No assigned Agent identity available'}
          </p>
          <p role="status">
            Text page {cursors.length}
            {page.nextContinuation
              ? ' · More text available'
              : ' · End of message'}
            . This view does not resume or change the conversation.
          </p>
          <section
            ref={contentRef}
            tabIndex={-1}
            aria-label="Exact matched message"
            data-search-event-id={page.matchedEventId}
          >
            <MessageContent
              textContent={page.text}
              chatFontSize={14}
              showReasoning={false}
              showToolDetails={false}
              isStreamingMessage={false}
            />
          </section>
        </>
      ) : (
        <ErrorState
          title="Message unavailable"
          description="The exact message could not be read under the current authority. No other Session or message was opened."
        />
      )}
    </Dialog>
  );
}
