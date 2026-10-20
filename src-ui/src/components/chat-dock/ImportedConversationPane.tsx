import type { EngineId } from '@kontourai/station-contracts/agent-identity';
import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
import { useOrchestrationSessionQuery } from '@kontourai/station-sdk';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useActiveChatActions } from '../../contexts/ActiveChatsContext';
import { useAuthorityPersistence } from '../../contexts/AuthorityPersistenceContext';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { useSendMessage } from '../../hooks/useActiveChatSessionMessaging';
import {
  attachedContinuationScope,
  discardAttachedContinuationHandoff,
} from '../../lib/attached-continuation-handoff';
import { displayProvider } from '../../utils/sessionDisplay';
import { Button } from '../Button';
import { AgentIcon } from '../icons/AgentIcon';
import { SessionDetail } from '../session-detail/SessionDetail';
import { ErrorState, SkeletonBlock } from '../state';
import './ImportedConversationPane.css';

function engineName(provider: EngineId): string {
  return engineDisplayLabel(provider) ?? provider;
}

/** A conversation reader in the dock, not a separate inspector or dialog. */
export default function ImportedConversationPane({
  threadId,
  apiBase,
  onContinueInDock,
  chatFontSize = 14,
  originLabel,
  showOrigin = false,
  onDetails,
}: {
  chatFontSize?: number;
  originLabel?: string;
  showOrigin?: boolean;
  onDetails?: () => void;
  threadId: string;
  apiBase: string;
  onContinueInDock: (
    conversationId: string,
    isCurrent: () => boolean,
  ) => Promise<boolean>;
}) {
  const authority = useAuthorityPersistence();
  const station =
    authority.status === 'verified'
      ? (authority.observation?.environmentId ?? null)
      : null;
  const scope = attachedContinuationScope(station, apiBase);
  const sourceIdentity = useRef({ scope, threadId });
  const intent = useRef(0);
  const continuedIntent = useRef(-1);
  const sendMessage = useSendMessage(apiBase);
  const { updateChat } = useActiveChatActions();
  const confirmedMessage = useRef('');
  const dispatched = useRef(false);
  const source = useOrchestrationSessionQuery(threadId, {
    retry: false,
    cancelWhenInactive: true,
  });
  const [continuedThreadId, setContinuedThreadId] = useState<string | null>(
    null,
  );
  const continued = useOrchestrationSessionQuery(continuedThreadId ?? '', {
    enabled: Boolean(continuedThreadId),
    retry: false,
    cancelWhenInactive: true,
  });
  const refetchContinued = continued.refetch;
  const [openFailed, setOpenFailed] = useState(false);
  /** #3429: the engine of a continuation that has no Agent, when known. */
  const [unboundEngine, setUnboundEngine] = useState<EngineId | null>(null);
  const attempted = useRef<string | null>(null);
  const mounted = useRef(true);
  useLayoutEffect(() => {
    sourceIdentity.current = { scope, threadId };
    intent.current += 1;
    mounted.current = true;
    confirmedMessage.current = '';
    dispatched.current = false;
    attempted.current = null;
    continuedIntent.current = -1;
    setContinuedThreadId(null);
    setOpenFailed(false);
    setUnboundEngine(null);
    return () => {
      mounted.current = false;
      intent.current += 1;
    };
  }, [scope, threadId]);
  // #3552: a draft handed over from Activity belongs to this visit only. It
  // is dropped once this pane has settled whether it could show the reader
  // that takes it, so a dev-mode effect rehearsal while still loading keeps it.
  const settled = useRef(false);
  settled.current = Boolean(source.data) || source.isError;
  useEffect(
    () => () => {
      if (settled.current) discardAttachedContinuationHandoff(threadId, scope);
    },
    [threadId, scope],
  );
  const openContinued = useCallback(async () => {
    const session = continued.data?.session;
    if (
      !session ||
      !mounted.current ||
      station === null ||
      continuedIntent.current !== intent.current
    )
      return;
    const heldIntent = intent.current;
    const current = () => mounted.current && intent.current === heldIntent;
    setOpenFailed(false);
    let opened = false;
    try {
      opened = await onContinueInDock(
        session.conversationId ?? session.threadId,
        current,
      );
    } catch {
      /* The original reader remains available for retry. */
    }
    if (!current()) return;
    if (opened && confirmedMessage.current.trim() && !dispatched.current) {
      const conversationId = session.conversationId ?? session.threadId;
      const target = Object.entries(activeChatsStore.getSnapshot()).find(
        ([, chat]) => chat.conversationId === conversationId,
      );
      if (target) {
        dispatched.current = true;
        const [tabId, chat] = target;
        const message = confirmedMessage.current;
        // The normal sender owns optimistic UI, rejection recovery and retry.
        updateChat(tabId, { input: message });
        if (chat.agentSlug) {
          void sendMessage(tabId, chat.agentSlug, conversationId, message);
        } else {
          updateChat(tabId, {
            error:
              'Your message is saved. Resolve this conversation before sending.',
          });
        }
      }
    }
    if (!opened && mounted.current) {
      // #3429: a chat tab runs as an Agent. A continuation Station could not
      // give one (its engine had no Agent here) can never open as a tab, so
      // say that instead of offering a retry that cannot succeed. Read
      // fresh: the child's Agent arrives with its start event, which can
      // land after the first read of the child.
      let fresh: Awaited<ReturnType<typeof refetchContinued>> | undefined;
      try {
        fresh = await refetchContinued();
      } catch {
        /* Unknown is not unbound: the ordinary retry stays available. */
      }
      if (!current()) return;
      if (fresh?.data?.session && !fresh.data.session.assignedAgentSlug)
        setUnboundEngine(fresh.data.session.provider);
      else setOpenFailed(true);
    }
  }, [
    continued.data,
    refetchContinued,
    onContinueInDock,
    sendMessage,
    updateChat,
    station,
  ]);
  useEffect(() => {
    if (!continued.data || attempted.current === continuedThreadId) return;
    attempted.current = continuedThreadId;
    void openContinued();
  }, [continued.data, continuedThreadId, openContinued]);
  return (
    <section className="imported-conversation-pane" aria-label="Conversation">
      {showOrigin && (
        <div className="imported-conversation-pane__origin">
          <span className="imported-conversation-pane__origin-label">
            {source.data && (
              <AgentIcon
                agent={{
                  name: displayProvider(source.data.session),
                  slug: source.data.session.provider,
                }}
                size={18}
              />
            )}
            {originLabel}
          </span>
          {onDetails && (
            <Button size="sm" variant="secondary" onClick={onDetails}>
              Details
            </Button>
          )}
        </div>
      )}
      {source.isLoading && <SkeletonBlock count={1} label="Opening chat" />}
      {source.isError && (
        <ErrorState
          className="imported-conversation-pane__error"
          variant="compact"
          title={
            source.data
              ? 'Could not refresh this conversation'
              : 'Could not load this conversation'
          }
          description={
            source.data
              ? 'Showing the history already loaded. New messages may be missing until Station reconnects.'
              : 'Station could not retrieve the history. Try again when the connection is available.'
          }
          action={
            <Button
              pending={source.isFetching}
              pendingLabel="Retrying…"
              onClick={() => void source.refetch()}
            >
              Retry
            </Button>
          }
        />
      )}
      {unboundEngine && (
        <ErrorState
          className="imported-conversation-pane__error"
          variant="compact"
          title="This continuation can't open as a chat"
          description={`Station has no ${engineName(unboundEngine)} agent, so the continuation was created without one. Open it from Activity to keep going, or set up ${engineName(unboundEngine)} in New Chat before continuing another conversation.`}
        />
      )}
      {(continued.isError || openFailed) && (
        <ErrorState
          className="imported-conversation-pane__error"
          variant="compact"
          title="Could not open the continuation"
          description="The continuation was created. Your original history and message are still here; retry opening to continue."
          action={
            <Button
              pending={continued.isFetching}
              onClick={() => {
                if (continued.isError) void continued.refetch();
                else void openContinued();
              }}
            >
              Retry opening
            </Button>
          }
        />
      )}
      {source.data && (
        <SessionDetail
          key={`${scope}\0${threadId}`}
          draftScope={`attached:${scope}`}
          handoffScope={scope}
          presentation="chat"
          chatFontSize={chatFontSize}
          apiBase={apiBase}
          session={source.data.session}
          continuationCreated={Boolean(continuedThreadId)}
          openingContinuation={
            Boolean(continuedThreadId) &&
            !openFailed &&
            !unboundEngine &&
            !continued.isError
          }
          onTaskChanged={() => void source.refetch()}
          getSelectionIntent={() => intent.current}
          onAdopted={(child, adoptedIntent, message) => {
            if (
              !mounted.current ||
              station === null ||
              sourceIdentity.current.scope !== scope ||
              sourceIdentity.current.threadId !== threadId ||
              adoptedIntent !== intent.current
            )
              return;
            continuedIntent.current = adoptedIntent;
            confirmedMessage.current = message ?? '';
            setContinuedThreadId(child.threadId);
          }}
        />
      )}
    </section>
  );
}
