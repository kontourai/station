import { getAssistantQuoteSource } from '@kontourai/station-sdk/quote-source';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useRef, useState } from 'react';
import { useLayoutChatPlacement } from '../../app-shell/chat-placement';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { navigationStore } from '../../contexts/navigation-store';
import { useRegionModel } from '../../contexts/RegionModelContext';
import { useShowSurface } from '../../contexts/useShowSurface';
import { useDockFoldsToOneRegion } from '../../hooks/useIsMobile';
import {
  panesHiddenByReveal,
  resolveRegionSurface,
} from '../../regions/region-model';
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
  const revealChat = useGuardedChatReveal();
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
              revealChat({
                // Asked again once any guard answered: the Station may have
                // changed meanwhile.
                admit: () => scope.isCurrent(),
                open: () => {
                  onClose();
                  navigationStore.navigate(window.location.pathname, {
                    chat: quote.sessionId,
                  });
                },
                after: () => {
                  window.location.hash = `station-message=${encodeURIComponent(source.messageId)}`;
                },
              });
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

/**
 * Show Chat for an explicit "open this conversation" from outside it — a
 * knowledge document, a Task's answer, a plan — through the canonical reveal
 * (`useShowSurface`: the Coding centre's Chat page where it owns Chat, else
 * Chat's region).
 *
 * Every pane that reveal would take off screen and that holds unsaved work —
 * one sharing Chat's region, the pane a phone layer shows over Chat — asks
 * its own guard first, once each, before anything changes. When the last one
 * answers, the open is admitted again and the reveal derived again from the
 * arrangement as it is then: a lost admission, or a guarded pane the reveal
 * would now hide that was not asked, opens nothing. Cancel changes nothing.
 * Nothing is asked where the reveal is no region reveal (the Coding centre's
 * page, or no region shell rendered, when it is a deep link and navigation's
 * own guards apply). Where a Chat workspace layout owns the viewport, Chat is
 * already the page: selecting the conversation shows it, and no reveal runs —
 * the deep link would leave that layout.
 */
function useGuardedChatReveal() {
  // A guard can answer long after the click: what it answers into is the
  // shell as it is then, not as the click's render saw it.
  const current = {
    model: useRegionModel(),
    showSurface: useShowSurface(),
    placement: useLayoutChatPlacement(),
    alone: useDockFoldsToOneRegion(),
  };
  const latest = useRef(current);
  latest.current = current;
  const guardedPanesHidden = (): string[] => {
    const { model, placement, alone } = latest.current;
    const chat = resolveRegionSurface('chat');
    if (placement !== 'none' || !model.canRenderRegionSurfaces || !chat)
      return [];
    return panesHiddenByReveal(
      model.regions,
      'chat',
      chat.defaultRegion,
      alone,
    ).filter((owner) => navigationStore.hasNavigationGuard(owner));
  };
  return (request: {
    admit: () => boolean;
    open: () => void;
    after?: () => void;
  }) => {
    if (!request.admit()) return;
    const asked = guardedPanesHidden();
    const proceed = () => {
      if (!request.admit()) return;
      if (guardedPanesHidden().some((owner) => !asked.includes(owner))) return;
      request.open();
      if (latest.current.placement !== 'viewport')
        latest.current.showSurface('chat');
      request.after?.();
    };
    const ask = (owners: readonly string[]) => {
      const [owner, ...rest] = owners;
      if (owner === undefined) {
        proceed();
        return;
      }
      navigationStore.runNavigationGuards(() => ask(rest), undefined, {
        owner,
      });
    };
    ask(asked);
  };
}
