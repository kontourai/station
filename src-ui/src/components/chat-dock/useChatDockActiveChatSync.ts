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
   * Whether the agent catalog query has resolved SUCCESSFULLY at least once
   * — not merely settled (`useAgentsLoaded` deliberately excludes an errored
   * query; see its doc). `agentCatalogKey` alone cannot carry this: it is
   * built by joining agent slugs, so an unloaded catalog (`agents === []`
   * before the query settles) and a genuinely, durably empty catalog
   * (loaded, zero agents) both stringify to `''` — the same key. Gating the
   * "was this a real miss" decision on key-emptiness therefore could not
   * tell "still loading" from "there is truly nothing here," so a
   * loaded-but-zero-agents catalog could never produce a distinct second key
   * and the #801 deleted-agent clear would never fire for it (#945 MED
   * finding). This flag is threaded through explicitly instead so both
   * cases resolve correctly — and because it specifically requires success
   * (not just "not loading"), a query that errored or is mid-refetch reports
   * `false` here too, so it authorizes neither a definitive clear nor a
   * spent retry budget; it stays in the retry-pending posture until the
   * catalog actually answers (#945 round-2 MED finding).
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
    // The loaded-state is folded into the dedup/scheduling key alongside the
    // catalog contents: an unloaded catalog (`agentsLoaded === false`) and a
    // loaded-but-empty one both produce `agentCatalogKey === ''`, so without
    // this prefix the loaded-empty attempt would look identical to the
    // already-tried unloaded attempt and never actually run — both the
    // dedup check below and this effect's re-run (React only re-fires an
    // effect when a dependency's value actually changes) need the loaded
    // flag as a first-class signal, not folded away inside the string it
    // controls.
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
    // station#1284 (D2c): the definitive-miss fallback — never a silent
    // setActiveChat(null). Mirrors the working pattern ChatDock's own inbox
    // panel already uses (an Activity-region session intent),
    // plus explicitly clearing the `chat` param before revealing Activity —
    // leaving it would re-seed `activeChat` from the URL on the very next
    // render (parseUrl() reads `chat` regardless of pathname) and loop this
    // effect right back into the dead conversation it just gave up on.
    // Clearing `dock` prevents a stale open Chat dock alongside Activity.
    const fallbackToActivityRoute = () => {
      updateParamsRef.current({ chat: null, dock: null });
      showSurfaceRef.current('activity', { session: activeChat });
    };
    /**
     * A persisted tab can hydrate at any point while a cold lookup is in
     * flight. Its durable local identity wins over the lookup either way
     * (station#3782), on the failure path as much as the resolved one.
     *
     * Measured honestly, because #3782 reads this as the failure path routing
     * away from a restored chat: in every ordering a test can stage, the first
     * effect above has already bumped `requestGenerationRef` by then (it fires
     * whenever `sessions` gains this chat) and the generation check discards
     * the stale attempt before either branch is reached — an injection that
     * removes this line does not redden. What is left is the window between
     * `sessionsRef.current = sessions` (assigned during render) and that
     * effect's passive flush, where the ref is already fresh and the
     * generation is not. This closes it, and is deliberately the same
     * belt-and-braces the resolved path carries; it is not covered by a test
     * that could fail without it, which is why it says so here.
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
          fallbackToActivityRoute();
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
        // The lookup now reports the conversation's true owner, which may be
        // an agent that no longer exists. Clear the pointer rather than
        // leaving it aimed at a chat that can never open (#801 review).
        //
        // An unloaded catalog for this attempt means `opened === false` here
        // can mean "the catalog wasn't ready," not "this agent is gone" —
        // clearing on that reading strands the retry this effect exists to
        // grant: the pointer is nulled and the `!activeChat` guard above
        // blocks the very re-run that would have supplied the real catalog.
        // A LOADED catalog (even a durably empty one) that still misses is a
        // definitive result — clear it, exactly like #801 intends. Only a
        // genuinely inconclusive (not-yet-loaded) attempt with budget left
        // gets to wait.
        const retryStillAvailable = attempt.attemptKeys.length < 2;
        const inconclusive = !catalogWasLoadedForThisAttempt;
        if (opened === false && !(inconclusive && retryStillAvailable)) {
          fallbackToActivityRoute();
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
        fallbackToActivityRoute();
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
