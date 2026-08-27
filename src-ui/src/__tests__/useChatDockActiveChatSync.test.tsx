/**
 * @vitest-environment jsdom
 */

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatDockActiveChatSync } from '../components/chat-dock/useChatDockActiveChatSync';

const fetchConversationById = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
  fetchConversationById: (...args: unknown[]) => fetchConversationById(...args),
}));

describe('useChatDockActiveChatSync', () => {
  beforeEach(() => {
    fetchConversationById.mockReset();
    fetchConversationById.mockResolvedValue({
      id: 'thread-1',
      agentSlug: 'claude',
      projectSlug: 'default',
    });
  });

  it('retries a cold deep link when the agent-backed opener becomes ready', async () => {
    const firstOpener = vi.fn().mockResolvedValue(undefined);
    const readyOpener = vi.fn().mockResolvedValue(undefined);
    const navigate = vi.fn();
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
          navigate,
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
    expect(navigate).not.toHaveBeenCalled();
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
        navigate: vi.fn(),
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
        navigate: vi.fn(),
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
    const navigate = vi.fn();
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
          navigate,
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
    expect(navigate).not.toHaveBeenCalled();
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
          navigate: vi.fn(),
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
          navigate: vi.fn(),
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
    const navigate = vi.fn();
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
          navigate,
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
    expect(navigate).not.toHaveBeenCalled();
  });

  // #801 review: the lookup now reports the conversation's true owner, which
  // can be an agent that no longer exists (deleting an agent leaves its
  // conversations on disk). The opener cannot open one, so the pointer has to
  // be cleared rather than left aimed at a chat that will never render.
  //
  // station#1284 (D2c/AC5): the clear is no longer silent -- it must
  // navigate to /activity?session=<id> (clearing the dead `chat` param in
  // the same call) instead of only calling setActiveChat(null), or the dock
  // is left showing nothing with no way back to the conversation.
  it('navigates to /activity instead of silently clearing when the owning agent can no longer be opened', async () => {
    const opener = vi.fn().mockResolvedValue(false);
    const navigate = vi.fn();
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
        navigate,
      }),
    );

    await waitFor(() => expect(opener).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/activity', {
        chat: null,
        dock: null,
        session: 'thread-1',
      }),
    );
  });

  it('leaves the active chat alone when the opener succeeds', async () => {
    const opener = vi.fn().mockResolvedValue(true);
    const navigate = vi.fn();
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
        navigate,
      }),
    );

    await waitFor(() => expect(opener).toHaveBeenCalledTimes(1));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('retries one transient cold-lookup failure before giving up on the active chat', async () => {
    fetchConversationById
      .mockRejectedValueOnce(new Error('Conversation not found'))
      .mockResolvedValueOnce({ id: 'thread-1', agentSlug: 'claude' });
    const opener = vi.fn().mockResolvedValue(true);
    const navigate = vi.fn();

    renderHook(() =>
      useChatDockActiveChatSync({
        activeChat: 'thread-1',
        agentCatalogKey: 'claude',
        agentsLoaded: true,
        apiBase: '/api',
        sessions: [],
        openConversation: opener,
        setActiveSessionId: vi.fn(),
        navigate,
      }),
    );

    await waitFor(() => expect(fetchConversationById).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(opener).toHaveBeenCalledTimes(1));
    expect(navigate).not.toHaveBeenCalled();
  });

  // A cold `/?dock=open&chat=` load races the agent catalog fetch: the
  // opener genuinely reports `false` (not `undefined`) on the first attempt
  // because `agents.find` has nothing to match yet, exactly like the #801
  // "owning agent no longer exists" case below -- but here a second attempt
  // with the real catalog is still available and must get the chance to
  // resolve the chat instead of the pointer being nulled out first.
  it('does not navigate away when only the not-yet-loaded attempt reports false', async () => {
    const notYetLoadedOpener = vi.fn().mockResolvedValue(false);
    const readyOpener = vi.fn().mockResolvedValue(true);
    const navigate = vi.fn();
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
          navigate,
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
    expect(navigate).not.toHaveBeenCalled();

    rerender({
      openConversation: readyOpener,
      agentCatalogKey: 'claude',
      agentsLoaded: true,
    });

    await waitFor(() => expect(readyOpener).toHaveBeenCalledTimes(1));
    expect(navigate).not.toHaveBeenCalled();
  });

  // If the retry itself also reports false (the agent genuinely does not
  // exist in the now-loaded catalog), the two-attempt budget is spent and
  // the pointer must still clear -- via the /activity fallback navigate,
  // not a silent null -- rather than leave the dock stuck forever.
  it('navigates to /activity once the retry with a loaded catalog also fails', async () => {
    const notYetLoadedOpener = vi.fn().mockResolvedValue(false);
    const loadedCatalogOpener = vi.fn().mockResolvedValue(false);
    const navigate = vi.fn();
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
          navigate,
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
    expect(navigate).not.toHaveBeenCalled();

    rerender({
      openConversation: loadedCatalogOpener,
      agentCatalogKey: 'claude',
      agentsLoaded: true,
    });

    await waitFor(() => expect(loadedCatalogOpener).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/activity', {
        chat: null,
        dock: null,
        session: 'thread-1',
      }),
    );
  });

  // #945 MED finding: `agentCatalogKey` is built by joining agent slugs, so
  // an unloaded catalog and a durably, legitimately EMPTY one (zero agents
  // ever configured) both stringify to `''` -- the same key. Gating the
  // "was this a real miss" decision (and the retry's re-run) on
  // key-emptiness alone meant a loaded-but-zero-agents catalog could never
  // produce a second, distinct attempt, so the #801 deleted-agent clear
  // never fired for it -- a stale `activeChat` pointer forever. `agentsLoaded`
  // must be the signal that actually gates this, independent of the key.
  it('navigates away for a loaded-but-empty catalog, not just a nonempty miss', async () => {
    const opener = vi.fn().mockResolvedValue(false);
    const navigate = vi.fn();
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
          navigate,
        }),
      { initialProps: { agentsLoaded: false } },
    );

    // Still loading: the miss is inconclusive, so nothing is cleared yet and
    // the retry budget is preserved.
    await waitFor(() => expect(opener).toHaveBeenCalledTimes(1));
    expect(navigate).not.toHaveBeenCalled();

    // The catalog resolves to durably empty -- same key, but `agentsLoaded`
    // flips true. This must still re-run the lookup and, on this definitive
    // miss, navigate away per #801/station#1284.
    rerender({ agentsLoaded: true });

    await waitFor(() => expect(opener).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/activity', {
        chat: null,
        dock: null,
        session: 'thread-1',
      }),
    );
  });

  // #945 round-2 MED finding: `useAgentsLoaded()`'s first cut derived
  // "loaded" from `!isLoading`, which react-query also clears on an ERRORED
  // query -- so a network outage on the agent-catalog fetch would read
  // identically to a durably empty catalog, and this hook would treat the
  // outage as a definitive #801 miss and permanently drop a perfectly valid
  // `activeChat` pointer it could have retried past once the catalog
  // recovered. `agentsLoaded` must only ever go `true` on an actual
  // successful resolution (`useAgentsLoaded` now derives from `isSuccess`,
  // not `!isLoading`); from this hook's point of view that means a
  // sustained error keeps `agentsLoaded` at `false` indefinitely, so it must
  // stay in the retry-pending posture -- never clearing -- no matter how many
  // times the surrounding app re-renders while the catalog is still down.
  it('an errored agent catalog never authorizes navigating away from the active chat pointer', async () => {
    const opener = vi.fn().mockResolvedValue(false);
    const navigate = vi.fn();
    const setActiveSessionId = vi.fn();

    const { rerender } = renderHook(() =>
      useChatDockActiveChatSync({
        activeChat: 'thread-1',
        // An errored `useAgentsQuery()` resolves `agents` to `[]` (see
        // `useAgents()`), so this stays `''` for as long as the error
        // persists -- same as the unloaded case.
        agentCatalogKey: '',
        // `useAgentsLoaded()` reports `false` for an errored query even
        // though `isLoading` has already cleared -- this is exactly that
        // signal, sustained across every render below.
        agentsLoaded: false,
        apiBase: '/api',
        sessions: [],
        openConversation: opener,
        setActiveSessionId,
        navigate,
      }),
    );

    await waitFor(() => expect(opener).toHaveBeenCalledTimes(1));
    expect(navigate).not.toHaveBeenCalled();

    // Unrelated re-renders (e.g. the surrounding app polling, a keystroke
    // elsewhere) must not be misread as "the catalog changed" and must not
    // eventually wear down into a clear -- the error is still live, so the
    // attempt key is unchanged and no new lookup (and no navigate) happens.
    rerender();
    rerender();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(opener).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  // station#1284 (D2c/AC5): the conversation simply doesn't resolve at all
  // (deleted, or the ORIGINAL ground-truth bug -- `!conversation` at
  // useChatDockActiveChatSync.ts:148-150 used to silently null the pointer
  // here without ever trying `openConversation`).
  it('navigates to /activity when the conversation cannot be found at all', async () => {
    fetchConversationById.mockResolvedValue(null);
    const openConversation = vi.fn();
    const navigate = vi.fn();
    const setActiveSessionId = vi.fn();

    renderHook(() =>
      useChatDockActiveChatSync({
        activeChat: 'dead-chat',
        agentCatalogKey: '__agent:claude-runtime',
        agentsLoaded: true,
        apiBase: '/api',
        sessions: [],
        openConversation,
        setActiveSessionId,
        navigate,
      }),
    );

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/activity', {
        chat: null,
        dock: null,
        session: 'dead-chat',
      }),
    );
    expect(openConversation).not.toHaveBeenCalled();
  });

  // station#1284 (D2c/AC5): the lookup itself throwing (e.g. a network
  // error) is a resolution failure exactly like a definitive miss -- it
  // must not be a silent no-op either.
  it('navigates to /activity when the conversation lookup throws', async () => {
    fetchConversationById.mockRejectedValue(new Error('network down'));
    const navigate = vi.fn();
    const setActiveSessionId = vi.fn();

    renderHook(() =>
      useChatDockActiveChatSync({
        activeChat: 'thread-network-error',
        agentCatalogKey: '__agent:claude-runtime',
        agentsLoaded: true,
        apiBase: '/api',
        sessions: [],
        openConversation: vi.fn(),
        setActiveSessionId,
        navigate,
      }),
    );

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/activity', {
        chat: null,
        dock: null,
        session: 'thread-network-error',
      }),
    );
  });
});
