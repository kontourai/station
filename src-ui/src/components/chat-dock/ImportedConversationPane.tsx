import { useOrchestrationSessionQuery } from '@kontourai/station-sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useActiveChatActions } from '../../contexts/ActiveChatsContext';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { useSendMessage } from '../../hooks/useActiveChatSessionMessaging';
import { displayProvider } from '../../utils/sessionDisplay';
import { Button } from '../Button';
import { AgentIcon } from '../icons/AgentIcon';
import { SessionDetail } from '../session-detail/SessionDetail';
import { ErrorState, SkeletonBlock } from '../state';
import './ImportedConversationPane.css';

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
  const [openFailed, setOpenFailed] = useState(false);
  const attempted = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const openContinued = useCallback(async () => {
    const session = continued.data?.session;
    if (!session) return;
    setOpenFailed(false);
    let opened = false;
    try {
      opened = await onContinueInDock(
        session.conversationId ?? session.threadId,
        () => mounted.current,
      );
    } catch {
      /* The original reader remains available for retry. */
    }
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
    if (mounted.current && !opened) setOpenFailed(true);
  }, [continued.data, onContinueInDock, sendMessage, updateChat]);
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
      {source.isLoading && (
        <SkeletonBlock count={1} label="Opening conversation" />
      )}
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
          presentation="chat"
          chatFontSize={chatFontSize}
          apiBase={apiBase}
          session={source.data.session}
          continuationCreated={Boolean(continuedThreadId)}
          openingContinuation={
            Boolean(continuedThreadId) && !openFailed && !continued.isError
          }
          onTaskChanged={() => void source.refetch()}
          getSelectionIntent={() => 0}
          onAdopted={(child, _intent, message) => {
            confirmedMessage.current = message ?? '';
            setContinuedThreadId(child.threadId);
          }}
        />
      )}
    </section>
  );
}
