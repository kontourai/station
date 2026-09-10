import { getAssistantQuoteSource } from '@kontourai/station-sdk/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { navigationStore } from '../../contexts/navigation-store';
import {
  quoteMatchesSource,
  type SavedAnswerQuote,
} from '../../utils/answer-quotes';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { ErrorState, SkeletonBlock } from '../state';

export function QuoteSourceLink({
  quote,
  children = 'Quoted answer',
}: {
  quote: SavedAnswerQuote;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="button button--link"
        onClick={() => setOpen(true)}
      >
        {children}
      </button>
      {open && (
        <QuoteSourceInspection quote={quote} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function QuoteSourceInspection({
  quote,
  onClose,
}: {
  quote: SavedAnswerQuote;
  onClose: () => void;
}) {
  const scope = useHostRequestAuthorityScope();
  const client = useQueryClient();
  const sameOrigin = scope?.apiBase === quote.origin;
  const queryKey = [
    'quoted-answer-source',
    scope?.apiBase,
    scope?.authorityKey,
    quote.sessionId,
    quote.turnId,
  ];
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      if (!scope?.isCurrent() || !sameOrigin)
        throw new Error('Original Station is not selected');
      try {
        const source = await getAssistantQuoteSource(
          scope.apiBase,
          quote.sessionId,
          quote.turnId,
          { signal, requestScope: scope },
        );
        if (!scope.isCurrent()) throw new Error('Source access changed');
        return source;
      } catch (error) {
        client
          .getQueryCache()
          .find({ queryKey, exact: true })
          ?.setState({ data: undefined });
        throw error;
      }
    },
    enabled: Boolean(scope?.isCurrent() && sameOrigin),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
  });
  const source =
    scope?.isCurrent() &&
    sameOrigin &&
    query.isFetchedAfterMount &&
    !query.isError &&
    !query.isFetching
      ? query.data
      : undefined;
  return (
    <Dialog
      title="Quoted answer source"
      closeLabel="Close quote source"
      onClose={onClose}
      size="lg"
      footer={
        source && (
          <Button
            onClick={() => {
              if (!scope?.isCurrent()) return;
              onClose();
              navigationStore.navigate(window.location.pathname, {
                chat: quote.sessionId,
              });
              window.location.hash = `station-message=${encodeURIComponent(source.messageId)}`;
            }}
          >
            Open source conversation
          </Button>
        )
      }
    >
      {!sameOrigin ? (
        <p>
          Select the original Station to inspect this source. The saved quote
          remains in your reply.
        </p>
      ) : query.isFetching && scope?.isCurrent() ? (
        <SkeletonBlock count={2} label="Reading quote source" />
      ) : source ? (
        <>
          <p role="status">
            {quoteMatchesSource(quote, source)
              ? 'Source revision is unchanged. The saved excerpt is user-provided.'
              : 'The source has changed. The saved quote is unchanged.'}{' '}
            Quotation does not establish evidence standing.
          </p>
          <blockquote>{quote.excerpt}</blockquote>
          <details open>
            <summary>Current source text</summary>
            <pre className="source-quote-text">{source.text}</pre>
          </details>
        </>
      ) : (
        <ErrorState
          title="Source unavailable"
          description="The exact answer could not be read under current access. No other answer was substituted."
        />
      )}
    </Dialog>
  );
}
