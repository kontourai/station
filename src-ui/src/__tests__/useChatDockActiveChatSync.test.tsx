/**
 * @vitest-environment jsdom
 */

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatDockActiveChatSync } from '../components/chat-dock/useChatDockActiveChatSync';

const fetchConversationById = vi.fn();
const updateParams = vi.fn();
const showSurface = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
  fetchConversationById: (...args: unknown[]) => fetchConversationById(...args),
}));

describe('useChatDockActiveChatSync', () => {
  beforeEach(() => {
    fetchConversationById.mockReset();
    updateParams.mockReset();
    showSurface.mockReset();
    fetchConversationById.mockResolvedValue({
      id: 'thread-1',
      agentSlug: 'claude',
      projectSlug: 'default',
    });
  });

  it('retries a cold deep link when the agent-backed opener becomes ready', async () => {
    const firstOpener = vi.fn().mockResolvedValue(undefined);
    const readyOpener = vi.fn().mockResolvedValue(undefined);
    const setActiveSessionId = vi.fn();

    const { rerender } = renderHook(
      ({ openConversation, agentCatalogKey, agentsLoaded }) =>
        useChatDockActiveChatSync({
          activeChat: 'thread-1',
          agentCatalogKey,
          agentsLoaded,
          apiBase: '/api',
          sessions: [],
          openConversation,
          setActiveSessionId,
          updateParams,
          showSurface,
        }),
      {
        initialProps: {
          openConversation: firstOpener,
          agentCatalogKey: '',
          agentsLoaded: false,
        },
      },
    );

    await waitFor(() => expect(firstOpener).toHaveBeenCalledTimes(1));

    rerender({
      openConversation: readyOpener,
      agentCatalogKey: 'claude',
      agentsLoaded: true,
    });

    await waitFor(() => expect(readyOpener).toHaveBeenCalledTimes(1));
    expect(fetchConversationById).toHaveBeenCalledTimes(2);
  });

  it('restores the server-projected accepted model on a cold reopen', async () => {
    fetchConversationById.mockResolvedValueOnce({
      id: 'durable-conversation',
      agentSlug: 'claude',
      projectSlug: 'default',
      model: 'engine-reported-model',
      acceptedModel: 'adapter-accepted-model',
      environmentId: 'station-environment-a',
    });
    const openConversation = vi.fn();

    renderHook(() =>
      useChatDockActiveChatSync({
        activeChat: 'durable-conversation',
        agentCatalogKey: 'claude',
        agentsLoaded: true,
        apiBase: '/api',
        sessions: [],
        openConversation,
        setActiveSessionId: vi.fn(),
        updateParams,
        showSurface,
      }),
    );

    await waitFor(() =>
      expect(openConversation).toHaveBeenCalledWith(
        'durable-conversation',
        'claude',
        {
          projectSlug: 'default',
          model: 'engine-reported-model',
          acceptedModel: 'adapter-accepted-model',
        },
      ),
    );
  });

  it('does not look up or reopen a conversation that already has a session', () => {
    const openConversation = vi.fn();
    const setActiveSessionId = vi.fn();

    renderHook(() =>
      useChatDockActiveChatSync({
        activeChat: 'thread-1',
        agentCatalogKey: 'claude',
        agentsLoaded: true,
        apiBase: '/api',
        sessions: [
          {
            id: 'session-1',
            conversationId: 'thread-1',
          } as never,
        ],
        openConversation,
        setActiveSessionId,
        updateParams,
        showSurface,
      }),
    );

    expect(setActiveSessionId).toHaveBeenCalledWith('session-1');
    expect(fetchConversationById).not.toHaveBeenCalled();
    expect(openConversation).not.toHaveBeenCalled();
  });

  it('does not clear an active chat when its persisted session hydrates during lookup', async () => {
    let resolveLookup: (value: unknown) => void = () => undefined;
    fetchConversationById.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLookup = resolve;
      }),
    );
    const setActiveSessionId = vi.fn();
    const { rerender } = renderHook(
      ({ sessions }) =>
        useChatDockActiveChatSync({
          activeChat: 'thread-1',
          agentCatalogKey: 'claude',
          agentsLoaded: true,
          apiBase: '/api',
          sessions,
          openConversation: vi.fn(),
          setActiveSessionId,
          updateParams,
          showSurface,
        }),
      { initialProps: { sessions: [] as never[] } },
    );

    rerender({
      sessions: [
        {
          id: 'thread-1',
          conversationId: 'thread-1',
        } as never,
      ],
    });
    resolveLookup(null);

    await waitFor(() =>
      expect(setActiveSessionId).toHaveBeenCalledWith('thread-1'),
    );
  });

  it('does not retry merely because the opener callback changes', async () => {
    const firstOpener = vi.fn();
    const secondOpener = vi.fn();
    const { rerender } = renderHook(
      ({ openConversation }) =>
        useChatDockActiveChatSync({
          activeChat: 'thread-1',
          agentCatalogKey: 'stable-catalog',
          agentsLoaded: true,
          apiBase: '/api',
          sessions: [],
          openConversation,
          setActiveSessionId: vi.fn(),
          updateParams,
          showSurface,
        }),
      { initialProps: { openConversation: firstOpener } },
    );

    await waitFor(() => expect(firstOpener).toHaveBeenCalledTimes(1));
    rerender({ openConversation: secondOpener });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondOpener).not.toHaveBeenCalled();
    expect(fetchConversationById).toHaveBeenCalledTimes(1);
  });

  it('finishes an in-flight lookup with the latest opener after an unrelated rerender', async () => {
    let resolveLookup: (value: unknown) => void = () => undefined;
    fetchConversationById.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLookup = resolve;
      }),
    );
    const firstOpener = vi.fn();
    const latestOpener = vi.fn();
    const { rerender } = renderHook(
      ({ openConversation, sessions }) =>
        useChatDockActiveChatSync({
          activeChat: 'thread-1',
          agentCatalogKey: 'stable-catalog',
          agentsLoaded: true,
          apiBase: '/api',
          sessions,
          openConversation,
          setActiveSessionId: vi.fn(),
          updateParams,
          showSurface,
        }),
      {
        initialProps: {
          openConversation: firstOpener,
          sessions: [] as never[],
        },
      },
    );

    rerender({
      openConversation: latestOpener,
      sessions: [] as never[],
    });
    resolveLookup({
      id: 'thread-1',
      agentSlug: 'claude',
    });

    await waitFor(() => expect(latestOpener).toHaveBeenCalledTimes(1));
    expect(firstOpener).not.toHaveBeenCalled();
    expect(fetchConversationById).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale cold-load response after the active chat changes', async () => {
    let resolveFirst: (value: unknown) => void = () => undefined;
    fetchConversationById
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValueOnce({
        id: 'thread-2',
        agentSlug: 'claude',
      });
    const openConversation = vi.fn();
    const { rerender } = renderHook(
      ({ activeChat }) =>
        useChatDockActiveChatSync({
          activeChat,
          agentCatalogKey: 'claude',
          agentsLoaded: true,
          apiBase: '/api',
          sessions: [],
          openConversation,
          setActiveSessionId: vi.fn(),
          updateParams,
          showSurface,
        }),
      { initialProps: { activeChat: 'thread-1' as string | null } },
    );

    rerender({ activeChat: 'thread-2' });
    await waitFor(() =>
      expect(openConversation).toHaveBeenCalledWith('thread-2', 'claude', {
        projectSlug: undefined,
      }),
    );
    resolveFirst({
      id: 'thread-1',
      agentSlug: 'claude',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(openConversation).toHaveBeenCalledTimes(1);
  });

  // archive#801: the lookup now reports the conversation's true owner, which
  // can be an agent that no longer exists (deleting an agent leaves its
  // conversations on disk). The opener cannot open one, so the pointer has to
  // be cleared rather than left aimed at a chat that will never render.
  //
  // archive#1284: the clear is no longer silent -- it must
  // reveal Activity with the session (clearing the dead `chat` param first)
  // instead of only calling setActiveChat(null), or the dock
  // is left showing nothing with no way back to the conversation.
  it('reveals Activity with the session instead of silently clearing when the owning agent can no longer be opened', async () => {
    const opener = vi.fn().mockResolvedValue(false);
    const setActiveSessionId = vi.fn();

    renderHook(() =>
      useChatDockActiveChatSync({
        activeChat: 'thread-1',
        agentCatalogKey: 'claude',
        agentsLoaded: true,
        apiBase: '/api',
        sessions: [],
        openConversation: opener,
        setActiveSessionId,
        updateParams,
        showSurface,
      }),
    );

    await waitFor(() => expect(opener).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(showSurface).toHaveBeenCalledWith('activity', {
        session: 'thread-1',
      }),
    );
    expect(updateParams).toHaveBeenCalledWith({ chat: null, dock: null });
  });

  it('leaves the active chat alone when the opener succeeds', async () => {
    const opener = vi.fn().mockResolvedValue(true);
    const setActiveSessionId = vi.fn();

    renderHook(() =>
      useChatDockActiveChatSync({
        activeChat: 'thread-1',
        agentCatalogKey: 'claude',
        agentsLoaded: true,
        apiBase: '/api',
        sessions: [],
        openConversation: opener,
        setActiveSessionId,
        updateParams,
        showSurface,
      }),
    );

    await waitFor(() => expect(opener).toHaveBeenCalledTimes(1));
    expect(showSurface).not.toHaveBeenCalled();
  });

  it('retries one transient cold-lookup failure before giving up on the active chat', async () => {
    fetchConversationById
      .mockRejectedValueOnce(new Error('Conversation not found'))
      .mockResolvedValueOnce({ id: 'thread-1', agentSlug: 'claude' });
    const opener = vi.fn().mockResolvedValue(true);

    renderHook(() =>
      useChatDockActiveChatSync({
        activeChat: 'thread-1',
        agentCatalogKey: 'claude',
        agentsLoaded: true,
        apiBase: '/api',
        sessions: [],
        openConversation: opener,
        setActiveSessionId: vi.fn(),
        updateParams,
        showSurface,
      }),
    );

    await waitFor(() => expect(fetchConversationById).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(opener).toHaveBeenCalledTimes(1));
  });

  // A cold `/?dock=open&chat=` load races the agent catalog fetch: the
  // opener genuinely reports `false` (not `undefined`) on the first attempt
  // because `agents.find` has nothing to match yet, exactly like the archive#801
  // "owning agent no longer exists" case below -- but here a second attempt
  // with the real catalog is still available and must get the chance to
  // resolve the chat instead of the pointer being nulled out first.
  it('does not reveal Activity when only the not-yet-loaded attempt reports false', async () => {
    const notYetLoadedOpener = vi.fn().mockResolvedValue(false);
    const readyOpener = vi.fn().mockResolvedValue(true);
    const setActiveSessionId = vi.fn();

    const { rerender } = renderHook(
      ({ openConversation, agentCatalogKey, agentsLoaded }) =>
        useChatDockActiveChatSync({
          activeChat: 'thread-1',
          agentCatalogKey,
          agentsLoaded,
          apiBase: '/api',
          sessions: [],
          openConversation,
          setActiveSessionId,
          updateParams,
          showSurface,
        }),
      {
        initialProps: {
          openConversation: notYetLoadedOpener,
          agentCatalogKey: '',
          agentsLoaded: false,
        },
      },
    );

    await waitFor(() => expect(notYetLoadedOpener).toHaveBeenCalledTimes(1));

    rerender({
      openConversation: readyOpener,
      agentCatalogKey: 'claude',
      agentsLoaded: true,
    });

    await waitFor(() => expect(readyOpener).toHaveBeenCalledTimes(1));
    expect(showSurface).not.toHaveBeenCalled();
  });

  // If the retry itself also reports false (the agent genuinely does not
  // exist in the now-loaded catalog), the two-attempt budget is spent and
  // the pointer must still clear -- via the Activity reveal fallback,
  // not a silent null -- rather than leave the dock stuck forever.
  it('reveals Activity with the session once the retry with a loaded catalog also fails', async () => {
    const notYetLoadedOpener = vi.fn().mockResolvedValue(false);
    const loadedCatalogOpener = vi.fn().mockResolvedValue(false);
    const setActiveSessionId = vi.fn();

    const { rerender } = renderHook(
      ({ openConversation, agentCatalogKey, agentsLoaded }) =>
        useChatDockActiveChatSync({
          activeChat: 'thread-1',
          agentCatalogKey,
          agentsLoaded,
          apiBase: '/api',
          sessions: [],
          openConversation,
          setActiveSessionId,
          updateParams,
          showSurface,
        }),
      {
        initialProps: {
          openConversation: notYetLoadedOpener,
          agentCatalogKey: '',
          agentsLoaded: false,
        },
      },
    );

    await waitFor(() => expect(notYetLoadedOpener).toHaveBeenCalledTimes(1));

    rerender({
      openConversation: loadedCatalogOpener,
      agentCatalogKey: 'claude',
      agentsLoaded: true,
    });

    await waitFor(() => expect(loadedCatalogOpener).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(showSurface).toHaveBeenCalledWith('activity', {
        session: 'thread-1',
      }),
    );
    expect(updateParams).toHaveBeenCalledWith({ chat: null, dock: null });
  });

  // archive#945 MED finding: `agentCatalogKey` is built by joining agent slugs, so
  // an unloaded catalog and a durably, legitimately EMPTY one (zero agents
  // ever configured) both stringify to `''` -- the same key. Gating the
  // "was this a real miss" decision (and the retry's re-run) on
  // key-emptiness alone meant a loaded-but-zero-agents catalog could never
  // produce a second, distinct attempt, so the archive#801 deleted-agent clear
  // never fired for it -- a stale `activeChat` pointer forever. `agentsLoaded`
  // must be the signal that actually gates this, independent of the key.
  it('reveals Activity for a loaded-but-empty catalog, not just a nonempty miss', async () => {
    const opener = vi.fn().mockResolvedValue(false);
    const setActiveSessionId = vi.fn();

    const { rerender } = renderHook(
      ({ agentsLoaded }) =>
        useChatDockActiveChatSync({
          activeChat: 'thread-1',
          // The catalog key never changes -- it is `''` both before load and
          // after resolving to a durably empty catalog.
          agentCatalogKey: '',
          agentsLoaded,
          apiBase: '/api',
          sessions: [],
          openConversation: opener,
          setActiveSessionId,
          updateParams,
          showSurface,
        }),
      { initialProps: { agentsLoaded: false } },
    );

    // Still loading: the miss is inconclusive, so nothing is cleared yet and
    // the retry budget is preserved.
    await waitFor(() => expect(opener).toHaveBeenCalledTimes(1));

    // The catalog resolves to durably empty -- same key, but `agentsLoaded`
    // flips true. This must still re-run the lookup and, on this definitive
    // miss, reveal Activity for the session per archive#801/archive#1284.
    rerender({ agentsLoaded: true });

    await waitFor(() => expect(opener).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(showSurface).toHaveBeenCalledWith('activity', {
        session: 'thread-1',
      }),
    );
    expect(updateParams).toHaveBeenCalledWith({ chat: null, dock: null });
  });

  // archive#945 MED finding: `useAgentsLoaded`'s first cut derived
  // "loaded" from `!isLoading`, which react-query also clears on an ERRORED
  // query -- so a network outage on the agent-catalog fetch would read
  // identically to a durably empty catalog, and this hook would treat the
  // outage as a definitive archive#801 miss and permanently drop a perfectly valid
  // `activeChat` pointer it could have retried past once the catalog
  // recovered. `agentsLoaded` must only ever go `true` on an actual
  // successful resolution (`useAgentsLoaded` now derives from `isSuccess`,
  // not `!isLoading`); from this hook's point of view that means a
  // sustained error keeps `agentsLoaded` at `false` indefinitely, so it must
  // stay in the retry-pending posture -- never clearing -- no matter how many
  // times the surrounding app re-renders while the catalog is still down.
  it('an errored agent catalog never authorizes navigating away from the active chat pointer', async () => {
    const opener = vi.fn().mockResolvedValue(false);
    const setActiveSessionId = vi.fn();

    const { rerender } = renderHook(() =>
      useChatDockActiveChatSync({
        activeChat: 'thread-1',
        // An errored `useAgentsQuery` resolves `agents` to `[]` (see
        // `useAgents`), so this stays `''` for as long as the error
        // persists -- same as the unloaded case.
        agentCatalogKey: '',
        // `useAgentsLoaded` reports `false` for an errored query even
        // though `isLoading` has already cleared -- this is exactly that
        // signal, sustained across every render below.
        agentsLoaded: false,
        apiBase: '/api',
        sessions: [],
        openConversation: opener,
        setActiveSessionId,
        updateParams,
        showSurface,
      }),
    );

    await waitFor(() => expect(opener).toHaveBeenCalledTimes(1));

    // Unrelated re-renders (e.g. the surrounding app polling, a keystroke
    // elsewhere) must not be misread as "the catalog changed" and must not
    // eventually wear down into a clear -- the error is still live, so the
    // attempt key is unchanged and no new lookup (and no reveal) happens.
    rerender();
    rerender();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(opener).toHaveBeenCalledTimes(1);
    expect(showSurface).not.toHaveBeenCalled();
  });

  // station#1582: a lookup that answers "no such conversation" is the one
  // outcome that carries no session to show. `?chat=` holds a chat's durable
  // id (`activeChatDurableId`), which for a chat never promoted to a
  // conversation is its client session id -- and `serializeActiveChats` never
  // persists such a chat, so a reload of that URL is a guaranteed definitive
  // miss. Revealing Activity for it opened a region the user never opened and
  // filled it with skeletons for an id that resolves to nothing. The pointer
  // still clears (archive#1284's real requirement: the effect must not loop
  // back into the dead conversation); no surface is placed.
  it('clears the dead pointer WITHOUT placing a surface when the conversation cannot be found at all', async () => {
    fetchConversationById.mockResolvedValue(null);
    const openConversation = vi.fn();
    const setActiveSessionId = vi.fn();

    renderHook(() =>
      useChatDockActiveChatSync({
        activeChat: 'dead-chat',
        agentCatalogKey: '__agent:claude',
        agentsLoaded: true,
        apiBase: '/api',
        sessions: [],
        openConversation,
        setActiveSessionId,
        updateParams,
        showSurface,
      }),
    );

    await waitFor(() =>
      expect(updateParams).toHaveBeenCalledWith({ chat: null, dock: null }),
    );
    expect(showSurface).not.toHaveBeenCalled();
    expect(openConversation).not.toHaveBeenCalled();
  });

  // archive#1284: the lookup itself throwing (e.g. a network
  // error) is a resolution failure exactly like a definitive miss -- it
  // must not be a silent no-op either.
  it('reveals Activity for the session when the conversation lookup throws', async () => {
    fetchConversationById.mockRejectedValue(new Error('network down'));
    const setActiveSessionId = vi.fn();

    renderHook(() =>
      useChatDockActiveChatSync({
        activeChat: 'thread-network-error',
        agentCatalogKey: '__agent:claude',
        agentsLoaded: true,
        apiBase: '/api',
        sessions: [],
        openConversation: vi.fn(),
        setActiveSessionId,
        updateParams,
        showSurface,
      }),
    );

    await waitFor(() =>
      expect(showSurface).toHaveBeenCalledWith('activity', {
        session: 'thread-network-error',
      }),
    );
    expect(updateParams).toHaveBeenCalledWith({ chat: null, dock: null });
  });
});
