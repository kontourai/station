import { useCallback } from 'react';
import { useActiveChatActions } from '../contexts/ActiveChatsContext';
import type { AgentData } from '../contexts/AgentsContext';
import { useApiBase } from '../contexts/ApiBaseContext';
import { activeChatDurableId } from '../contexts/active-chats-state';
import { useNavigation } from '../contexts/NavigationContext';
import type { FileAttachment } from '../types';
import {
  type ChatExecutionMetadata,
  type EffectiveModelSource,
  resolveAgentExecution,
} from '../utils/execution';
import { reopenedSessionExecution } from './reopenedSessionExecution';
import {
  useCreateChatSession,
  useOpenConversation,
} from './useActiveChatSessions';

interface DerivedSession {
  id: string;
  conversationId?: string;
  agentSlug: string;
}

interface UseChatDockActionsOptions {
  sessions: DerivedSession[];
  agents: AgentData[];
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
}

export interface OpenConversationOptions {
  projectSlug?: string;
  projectName?: string;
  model?: string;
  acceptedModel?: string;
  revealDock?: boolean;
  conversationUpdatedAt?: string;
  modelSource?: EffectiveModelSource;
  defaultModel?: string;
  defaultModelSource?: EffectiveModelSource;
  providerOptions?: Record<string, unknown>;
  providerId?: string;
  providerType?: string;
  /** Fetch the deterministic copied transcript of a newly replay-seeded fork. */
  hydrateMessages?: boolean;
  /** Cancels only client hydration/focus; server idempotency owns request retry. */
  signal?: AbortSignal;
  /** Synchronous route commit immediately before focus; false cancels reentry. */
  beforeFocus?: () => boolean;
}

export function useChatDockActions({
  sessions,
  agents,
  activeSessionId,
  setActiveSessionId,
}: UseChatDockActionsOptions) {
  const { apiBase } = useApiBase();
  const { lastDockMaximized, setDockState, setActiveChat } = useNavigation();
  const { updateChat, removeChat } = useActiveChatActions();
  const createChatSession = useCreateChatSession();
  const openConversationAction = useOpenConversation(apiBase);

  const focusSession = useCallback(
    (sessionId: string, revealDock = true) => {
      setActiveSessionId(sessionId);
      // archive#3782: the chat's durable identity, never `null` — focusing a
      // chat that has not been promoted to a conversation yet must still leave
      // `?chat=` pointing at something the dock can resolve (its session id,
      // which `useChatDockActiveChatSync` matches on).
      setActiveChat(
        activeChatDurableId(
          sessionId,
          sessions.find((session) => session.id === sessionId),
        ),
      );
      // Restore the dock's last stated maximize preference, not the
      // momentarily-live `isDockMaximized` — a round trip through a closed
      // dock (e.g. revealing Activity for a delegated task) always
      // clears the URL's `maximize` flag by design, so reading the live
      // value here would silently drop a maximized dock back to normal size
      // on return instead of restoring it.
      if (revealDock) setDockState(true, lastDockMaximized);
      updateChat(sessionId, { hasUnread: false });
    },
    [
      sessions,
      setActiveSessionId,
      setActiveChat,
      setDockState,
      lastDockMaximized,
      updateChat,
    ],
  );

  const removeSession = useCallback(
    (sessionId: string) => {
      removeChat(sessionId);
      if (activeSessionId === sessionId) {
        const remaining = sessions.filter((s) => s.id !== sessionId);
        const next = remaining[remaining.length - 1] ?? null;
        setActiveSessionId(next?.id ?? null);
        setActiveChat(next?.conversationId ?? null);
      }
    },
    [removeChat, activeSessionId, sessions, setActiveSessionId, setActiveChat],
  );

  const openChatForAgent = useCallback(
    (
      agent: AgentData,
      projectSlug?: string,
      projectName?: string,
      initialMessage?: string,
      modelOverride?: string,
      modelSource?: EffectiveModelSource,
      defaultModel?: string,
      defaultModelSource?: EffectiveModelSource,
      providerOptions?: Record<string, unknown>,
      revealDock = true,
      initialAttachments?: FileAttachment[],
      providerId?: string,
      providerType?: string,
    ) => {
      const execution = resolveAgentExecution(agent);
      const sessionExecution =
        modelOverride || providerOptions || providerId
          ? {
              ...execution,
              model: modelOverride,
              modelSource,
              defaultModel,
              defaultModelSource,
              providerOptions: providerOptions ?? execution.providerOptions,
              ...(providerId
                ? {
                    providerId,
                    defaultProviderId:
                      execution.defaultProviderId ?? execution.providerId,
                    provider: providerType as ChatExecutionMetadata['provider'],
                  }
                : {}),
            }
          : execution;
      const sessionId = createChatSession(
        agent.slug,
        agent.name,
        undefined,
        projectSlug,
        projectName,
        sessionExecution,
      );
      setActiveSessionId(sessionId);
      setActiveChat(sessionId);
      if (revealDock) setDockState(true, lastDockMaximized);
      if (initialMessage?.trim() || initialAttachments?.length) {
        updateChat(sessionId, {
          ...(initialMessage?.trim() ? { input: initialMessage } : {}),
          ...(initialAttachments?.length
            ? { attachments: initialAttachments }
            : {}),
        });
      }
      return sessionId;
    },
    [
      createChatSession,
      setActiveSessionId,
      setActiveChat,
      setDockState,
      lastDockMaximized,
      updateChat,
    ],
  );

  const openConversation = useCallback(
    async (
      conversationId: string,
      agentSlug: string,
      options: OpenConversationOptions = {},
    ) => {
      if (options.signal?.aborted) return false;
      // archive#801: report whether the conversation could actually be
      // opened. Its owning agent can legitimately no longer exist — deleting
      // an agent leaves its conversations on disk — and a silent no-op here
      // strands the caller's `activeChat` pointing at a chat that will never
      // render.
      const agent = agents.find((a) => a.slug === agentSlug);
      if (!agent) return false;

      const existing = sessions.find(
        (s) => s.conversationId === conversationId,
      );
      if (existing) {
        if (options.signal?.aborted) return false;
        if (options.beforeFocus && !options.beforeFocus()) return false;
        focusSession(existing.id, options.revealDock ?? true);
        return true;
      }

      const agentExecution = resolveAgentExecution(agent);
      // Reopening with no known model must seed NO model, not the agent
      // default. `resolveAgentExecution` fills `model` from the agent's own
      // default, so the composer showed that until an orchestration snapshot
      // corrected it — and a send inside that window dispatched
      // `override: <agent default>`, a model the user never chose for this
      // conversation. On an engine that cannot take a per-turn override that
      // is an error for someone else's choice; on one that can, it silently
      // switches the model mid-conversation and the per-turn provenance
      // faithfully records a switch the user never made (archive#3165).
      //
      // Unset is honest: resolveTurnModel treats a missing model as
      // engine-selected and sends no override at all.
      const reopenedExecution = reopenedSessionExecution(
        agentExecution,
        options.acceptedModel ?? options.model,
        options.modelSource ??
          (options.acceptedModel ? 'session override' : 'runtime'),
      );
      const sessionExecution =
        options.providerId || options.providerType || options.providerOptions
          ? {
              ...reopenedExecution,
              defaultModel: options.defaultModel,
              defaultModelSource: options.defaultModelSource,
              providerOptions:
                options.providerOptions ?? agentExecution.providerOptions,
              ...(options.providerId || options.providerType
                ? {
                    ...(options.providerId
                      ? { providerId: options.providerId }
                      : {}),
                    defaultProviderId:
                      agentExecution.defaultProviderId ??
                      agentExecution.providerId,
                    ...(options.providerType
                      ? {
                          provider:
                            options.providerType as ChatExecutionMetadata['provider'],
                        }
                      : {}),
                  }
                : {}),
            }
          : reopenedExecution;
      const sessionId = await openConversationAction(
        conversationId,
        agentSlug,
        agent.name,
        options.projectSlug,
        options.projectName,
        sessionExecution,
        options.conversationUpdatedAt,
        options.hydrateMessages,
      );
      // archive#1312: `null` means the conversation's messages
      // failed to fetch (agent exists, but the fetch 404'd/errored) —
      // `useOpenConversation` already tore the just-created tab back down.
      // Report failure the same way a missing agent does, rather than
      // silently landing on a permanently empty tab.
      if (sessionId === null) return false;
      if (options.signal?.aborted) {
        removeChat(sessionId);
        return false;
      }
      if (options.beforeFocus && !options.beforeFocus()) {
        removeChat(sessionId);
        return false;
      }
      setActiveSessionId(sessionId);
      setActiveChat(conversationId);
      if (options.revealDock ?? true) setDockState(true, false);
      return true;
    },
    [
      agents,
      sessions,
      focusSession,
      openConversationAction,
      removeChat,
      setActiveSessionId,
      setActiveChat,
      setDockState,
    ],
  );

  return {
    focusSession,
    removeSession,
    openChatForAgent,
    openConversation,
  };
}
