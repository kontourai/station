import { fetchConversationById } from '@kontourai/station-sdk';
import { useEffect, useRef, useState } from 'react';
import type { OpenConversationOptions } from '../../hooks/useChatDockActions';
import {
  getNotificationOpenNotice,
  isNotificationChat,
  markNotificationChat,
  setNotificationOpenNotice,
  takeNotificationChat,
} from '../../lib/notificationStationOpen';
import { type ChatSession } from '../../types';

type ConversationLookup = Awaited<ReturnType<typeof fetchConversationById>>;

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
  beginOpen?: () => {
    current: () => boolean;
    isCurrent: () => boolean;
    beforeFocus: () => boolean;
    finish: () => void;
  };
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
  beginOpen,
}: UseChatDockActiveChatSyncArgs): {
  /**
   * The chat a cold open is still resolving, or null. While it is set the
   * dock shows that it is opening rather than the conversation it showed
   * before (#5: a warm tap used to show the previous thread until the new
   * one opened).
   */
  pendingChat: string | null;
} {
  const [lookupRetryGeneration, setLookupRetryGeneration] = useState(0);
  const [pendingChat, setPendingChat] = useState<string | null>(null);
  /**
   * The lookup in flight, shared by a second attempt for the same chat on
   * the same Station: the catalog loading mid-lookup re-runs the open, not
   * the request (#6).
   */
  const lookupRef = useRef<{
    key: string;
    promise: Promise<ConversationLookup>;
  } | null>(null);
  const attemptRef = useRef<{
    activeChat: string;
    attemptKeys: string[];
    readerCurrent?: () => boolean;
  } | null>(null);
  const requestGenerationRef = useRef(0);
  const openConversationRef = useRef(openConversation);
  const beginOpenRef = useRef(beginOpen);
  beginOpenRef.current = beginOpen;
  const updateParamsRef = useRef(updateParams);
  const showSurfaceRef = useRef(showSurface);
  const sessionsRef = useRef(sessions);
  const apiBaseRef = useRef(apiBase);
  apiBaseRef.current = apiBase;
  openConversationRef.current = openConversation;
  updateParamsRef.current = updateParams;
  showSurfaceRef.current = showSurface;
  sessionsRef.current = sessions;

  // An unreachable notice belongs to the Station whose lookup failed: once
  // another Station is active, its Retry would look the id up there.
  useEffect(() => {
    const notice = getNotificationOpenNotice();
    if (notice?.kind === 'unreachable' && notice.apiBase !== apiBase)
      setNotificationOpenNotice(null);
  }, [apiBase]);

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
    if (!activeChat) {
      attemptRef.current = null;
      setPendingChat(null);
      return;
    }
    if (
      sessionsRef.current.some(
        (session) =>
          session.conversationId === activeChat || session.id === activeChat,
      )
    ) {
      setPendingChat(null);
      // Already open here: nothing a notification could report.
      takeNotificationChat(activeChat);
      return;
    }
    if (attemptRef.current?.activeChat !== activeChat) {
      attemptRef.current = { activeChat, attemptKeys: [] };
    }
    const attempt = attemptRef.current;
    // A retry may renew transport work, never a superseded reader selection.
    if (attempt.readerCurrent?.() === false) return;
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
    setPendingChat(activeChat);
    const requestGeneration = ++requestGenerationRef.current;
    let cancelled = false;
    const request = beginOpenRef.current?.();
    attempt.readerCurrent = request?.current;
    const isCurrent = () =>
      !cancelled &&
      requestGeneration === requestGenerationRef.current &&
      request?.current() !== false;
    const execution = request
      ? {
          isCurrent: request.isCurrent,
          beforeFocus: () => isCurrent() && request.beforeFocus(),
        }
      : {};
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
     * A notification asked for this chat: say why it did not open instead
     * of only clearing the pointer. Any other `?chat=` open (a reload of a
     * draft that was never saved, #1582) stays quiet.
     */
    const reportFailedNotificationOpen = (
      failure: 'not-found' | 'forbidden' | 'unreachable',
    ) => {
      if (!takeNotificationChat(activeChat)) return;
      setNotificationOpenNotice(
        failure === 'unreachable'
          ? {
              kind: 'unreachable',
              apiBase,
              retry: () => {
                // Only on the Station that failed to answer.
                if (apiBaseRef.current !== apiBase) return;
                markNotificationChat(activeChat);
                updateParamsRef.current({ chat: activeChat, dock: 'open' });
              },
            }
          : { kind: failure },
      );
    };
    /**
     * Preserve a recovery surface for an existing or unresolved Session
     * (archive#1284). A definitive missing record must skip this path: #1582
     * otherwise opened an unrequested region full of nonexistent-session
     * skeletons after reloading an unpromoted chat.
     */
    const revealSessionInChat = () => {
      clearDeadChatPointer();
      showSurfaceRef.current('chat', { session: activeChat });
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

    const lookupKey = `${apiBase}\u0000${activeChat}`;
    const lookup =
      lookupRef.current?.key === lookupKey
        ? lookupRef.current.promise
        : fetchConversationById(activeChat, apiBase);
    if (lookupRef.current?.key !== lookupKey) {
      const entry = { key: lookupKey, promise: lookup };
      lookupRef.current = entry;
      // Shared only while in flight: a settled answer is never reused, so a
      // retry asks the Station again.
      const release = () => {
        if (lookupRef.current === entry) lookupRef.current = null;
      };
      lookup.then(release, release);
    }

    (async () => {
      try {
        const conversation = await lookup;
        if (!isCurrent()) return;
        // A persisted tab can hydrate while a cold lookup is in flight. Its
        // durable local identity wins; never reopen it or clear the URL based
        // on the now-stale lookup result.
        if (hydratedLocally()) return;
        if (!conversation) {
          // No record: this Station does not know the id at all (#1582).
          clearDeadChatPointer();
          reportFailedNotificationOpen('not-found');
          return;
        }
        // Hydrating the conversation the URL already names is not a reveal:
        // the URL's own `dock` and `maximize` stand, and so does any pane a
        // phone layer shows over Chat. The reveal rewrote them — a reload
        // then came back docked from a full-screen Chat.
        const opened =
          conversation.acceptedModel || conversation.model
            ? await openConversationRef.current(
                conversation.id,
                conversation.agentSlug,
                {
                  projectSlug: conversation.projectSlug ?? undefined,
                  model: conversation.model,
                  acceptedModel: conversation.acceptedModel,
                  revealDock: false,
                  ...execution,
                },
              )
            : await openConversationRef.current(
                conversation.id,
                conversation.agentSlug,
                {
                  projectSlug: conversation.projectSlug ?? undefined,
                  revealDock: false,
                  ...execution,
                },
              );
        if (!isCurrent()) return;
        // A loaded catalog that refuses the conversation's owner is a real
        // miss (#801). Before it loads, the same refusal may only mean the
        // Agent is not ready; preserve the pointer while a retry remains.
        const retryStillAvailable = attempt.attemptKeys.length < 2;
        const inconclusive = !catalogWasLoadedForThisAttempt;
        if (opened === false && !(inconclusive && retryStillAvailable)) {
          // The lookup returned this conversation; only its owning agent is
          // gone. There is a real session behind the id, so the Chat reader has
          // something to show (archive#801, station#1284).
          revealSessionInChat();
        }
        if (opened !== false) takeNotificationChat(activeChat);
      } catch (error) {
        if (!isCurrent()) return;
        if (hydratedLocally()) return;
        // `StationHttpError.status`, read by shape: tests and older bundles
        // mock the SDK barrel without the class.
        const status =
          typeof error === 'object' && error !== null && 'status' in error
            ? (error as { status: unknown }).status
            : undefined;
        // For a notification's conversation a refusal is the Station's
        // answer, not a transient miss: retrying cannot change it, and the
        // person is told why it did not open. (A 401 is a credential being
        // renewed, which the auth recovery owns.) Any other `?chat=` link
        // keeps the bounded retry and the Chat surface below.
        if (status === 403 && isNotificationChat(activeChat)) {
          clearDeadChatPointer();
          reportFailedNotificationOpen('forbidden');
          return;
        }
        // A just-dispatched runtime conversation can become addressable a
        // moment after its URL/session pointer is written. A single bounded
        // retry keeps a temporary projection miss from erasing the chat the
        // user just opened, while a persistent 404 still gives up on it.
        if (attempt.attemptKeys.length < 2) {
          retryTimer = setTimeout(() => {
            if (isCurrent())
              setLookupRetryGeneration((generation) => generation + 1);
          }, 250);
          return;
        }
        // The lookup never answered, so whether the conversation exists is
        // unknown rather than settled. An unresolved pointer keeps
        // station#1284's reveal; only a definitive miss loses it.
        revealSessionInChat();
        if (status === 401) takeNotificationChat(activeChat);
        else reportFailedNotificationOpen('unreachable');
      } finally {
        request?.finish();
        // A scheduled retry is still opening this chat.
        if (isCurrent() && retryTimer === undefined) setPendingChat(null);
      }
    })();

    return () => {
      cancelled = true;
      request?.finish();
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [
    activeChat,
    agentCatalogKey,
    agentsLoaded,
    apiBase,
    lookupRetryGeneration,
  ]);

  return { pendingChat };
}
