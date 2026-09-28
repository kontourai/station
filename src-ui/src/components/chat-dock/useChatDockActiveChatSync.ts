import { fetchConversationById } from '@kontourai/station-sdk';
import { useEffect, useRef, useState } from 'react';
import type { OpenConversationOptions } from '../../hooks/useChatDockActions';
import { type ChatSession } from '../../types';

interface UseChatDockActiveChatSyncArgs {
  activeChat: string | null;
  agentCatalogKey: string;
  updateParams: (params: Record<string, string | null>) => void;
  showSurface: (
    surfaceId: string,
    intent?: { session?: string; focus?: 'evidence' },
  ) => void;
  /**
   * A successful catalog observation, not merely a settled query. Unloaded
   * and confirmed-empty catalogs both have an empty key. Errors/refetches
   * remain false so they cannot authorize a missing-agent decision or spend
   * its retry budget (#945).
   */
  agentsLoaded: boolean;
  apiBase: string;
  sessions: ChatSession[];
  openConversation: (
    conversationId: string,
    agentSlug: string,
    options?: OpenConversationOptions,
  ) => Promise<boolean | undefined> | boolean | undefined;
  setActiveSessionId: (value: string | null) => void;
}

export function useChatDockActiveChatSync({
  activeChat,
  agentCatalogKey,
  agentsLoaded,
  apiBase,
  sessions,
  openConversation,
  setActiveSessionId,
  updateParams,
  showSurface,
}: UseChatDockActiveChatSyncArgs) {
  const [lookupRetryGeneration, setLookupRetryGeneration] = useState(0);
  const attemptRef = useRef<{
    activeChat: string;
    attemptKeys: string[];
  } | null>(null);
  const requestGenerationRef = useRef(0);
  const openConversationRef = useRef(openConversation);
  const updateParamsRef = useRef(updateParams);
  const showSurfaceRef = useRef(showSurface);
  const sessionsRef = useRef(sessions);
  openConversationRef.current = openConversation;
  updateParamsRef.current = updateParams;
  showSurfaceRef.current = showSurface;
  sessionsRef.current = sessions;

  useEffect(() => {
    if (!activeChat) return;
    const existing = sessions.find(
      (session) =>
        session.conversationId === activeChat || session.id === activeChat,
    );
    if (!existing) return;
    requestGenerationRef.current += 1;
    setActiveSessionId(existing.id);
  }, [activeChat, sessions, setActiveSessionId]);

  useEffect(() => {
    if (!activeChat) return;
    if (
      sessionsRef.current.some(
        (session) =>
          session.conversationId === activeChat || session.id === activeChat,
      )
    )
      return;
    if (attemptRef.current?.activeChat !== activeChat) {
      attemptRef.current = { activeChat, attemptKeys: [] };
    }
    const attempt = attemptRef.current;
    // Loading and confirmed-empty catalogs share a key; include successful
    // load state so the latter gets its own attempt (#945).
    const attemptKey = `${agentsLoaded}:${agentCatalogKey}:${lookupRetryGeneration}`;
    if (
      attempt.attemptKeys.includes(attemptKey) ||
      attempt.attemptKeys.length >= 2
    )
      return;

    // A cold URL can resolve before the agent catalog. Permit one retry only
    // when that catalog's actual contents (or loaded state) change; callback
    // identity changes must never create an unbounded reopen loop.
    attempt.attemptKeys.push(attemptKey);
    const requestGeneration = ++requestGenerationRef.current;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const catalogWasLoadedForThisAttempt = agentsLoaded;
    /**
     * Clear the URL or parseUrl reopens the same dead conversation. A
     * dock:null update also clears maximize in the navigation owner
     * (#1613, archive#795); this helper does not duplicate that rule.
     */
    const clearDeadChatPointer = () => {
      updateParamsRef.current({ chat: null, dock: null });
    };
    /**
     * Preserve a recovery surface for an existing or unresolved Session
     * (archive#1284). A definitive missing record must skip this path: #1582
     * otherwise opened an unrequested region full of nonexistent-session
     * skeletons after reloading an unpromoted chat.
     */
    const revealActivityForSession = () => {
      clearDeadChatPointer();
      showSurfaceRef.current('activity', { session: activeChat });
    };
    /**
     * A locally hydrated tab wins over a cold lookup (#3782). The generation
     * guard covers tested orderings. This additional check covers the window
     * after the render updates sessionsRef but before the passive effect
     * advances the generation; removing it did not fail the existing tests.
     */
    const hydratedLocally = () =>
      sessionsRef.current.some(
        (session) =>
          session.conversationId === activeChat || session.id === activeChat,
      );

    (async () => {
      try {
        const conversation = await fetchConversationById(activeChat, apiBase);
        if (cancelled || requestGeneration !== requestGenerationRef.current)
          return;
        // A persisted tab can hydrate while a cold lookup is in flight. Its
        // durable local identity wins; never reopen it or clear the URL based
        // on the now-stale lookup result.
        if (hydratedLocally()) return;
        if (!conversation) {
          // No record: this Station does not know the id at all (#1582).
          clearDeadChatPointer();
          return;
        }
        const opened =
          conversation.acceptedModel || conversation.model
            ? await openConversationRef.current(
                conversation.id,
                conversation.agentSlug,
                {
                  projectSlug: conversation.projectSlug ?? undefined,
                  model: conversation.model,
                  acceptedModel: conversation.acceptedModel,
                },
              )
            : await openConversationRef.current(
                conversation.id,
                conversation.agentSlug,
                {
                  projectSlug: conversation.projectSlug ?? undefined,
                },
              );
        // A loaded catalog that refuses the conversation's owner is a real
        // miss (#801). Before it loads, the same refusal may only mean the
        // Agent is not ready; preserve the pointer while a retry remains.
        const retryStillAvailable = attempt.attemptKeys.length < 2;
        const inconclusive = !catalogWasLoadedForThisAttempt;
        if (opened === false && !(inconclusive && retryStillAvailable)) {
          // The lookup returned this conversation; only its owning agent is
          // gone. There is a real session behind the id, so Activity has
          // something to show (archive#801, station#1284).
          revealActivityForSession();
        }
      } catch {
        if (cancelled || requestGeneration !== requestGenerationRef.current)
          return;
        if (hydratedLocally()) return;
        // A just-dispatched runtime conversation can become addressable a
        // moment after its URL/session pointer is written. A single bounded
        // retry keeps a temporary projection miss from erasing the chat the
        // user just opened, while a persistent 404 still gives up on it.
        if (attempt.attemptKeys.length < 2) {
          retryTimer = setTimeout(() => {
            if (!cancelled)
              setLookupRetryGeneration((generation) => generation + 1);
          }, 250);
          return;
        }
        // The lookup never answered, so whether the conversation exists is
        // unknown rather than settled. An unresolved pointer keeps
        // station#1284's reveal; only a definitive miss loses it.
        revealActivityForSession();
      }
    })();

    return () => {
      cancelled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [
    activeChat,
    agentCatalogKey,
    agentsLoaded,
    apiBase,
    lookupRetryGeneration,
  ]);
}
