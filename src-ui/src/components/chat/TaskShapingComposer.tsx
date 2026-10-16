import { useEffect, useEffectEvent, useRef } from 'react';
import { showChatPageOrDock } from '../../app-shell/chat-placement';
import { useActiveChatActions } from '../../contexts/ActiveChatsContext';
import { useAgents } from '../../contexts/AgentsContext';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { useNavigation } from '../../contexts/NavigationContext';
import { toastStore } from '../../contexts/ToastContext';
import {
  useOpenConversation,
  useSendMessage,
} from '../../hooks/useActiveChatSessions';
import { dispatchNewChatIntent } from '../../lib/newChatIntent';
import {
  TASK_SHAPING_EVENT,
  TASK_SHAPING_INSTRUCTION,
  type TaskShapingRequest,
} from '../../lib/task-shaping';
import { resolveAgentExecution } from '../../utils/execution';

export function TaskShapingHost() {
  const { apiBase } = useApiBase();
  const agents = useAgents();
  const send = useSendMessage(apiBase);
  const openConversation = useOpenConversation(apiBase);
  const { updateChat } = useActiveChatActions();
  const navigation = useNavigation();

  const pending = useRef(false);
  const start = useEffectEvent(async (request: TaskShapingRequest) => {
    if (pending.current) return;
    if (!request.source) {
      showChatPageOrDock(() => navigation.setDockState(true, true));
      if (
        !dispatchNewChatIntent({
          taskShaping: true,
          selection: { context: request.projectSlug ?? '__global__' },
        })
      )
        toastStore.show('Open Chat, then choose New Task again.');
      return;
    }
    pending.current = true;
    try {
      const source = request.source;
      if (source) {
        let entry = Object.entries(activeChatsStore.getSnapshot()).find(
          ([key, chat]) =>
            key === source.sessionId ||
            chat.currentSessionId === source.sessionId ||
            (source.conversationId &&
              chat.conversationId === source.conversationId),
        );
        if (!entry && source.conversationId && source.agentSlug) {
          const sourceAgent = agents.find(
            (agent) => agent.slug === source.agentSlug,
          );
          const key = await openConversation(
            source.conversationId,
            source.agentSlug,
            source.agentName ?? source.agentSlug,
            request.projectSlug,
            undefined,
            sourceAgent ? resolveAgentExecution(sourceAgent) : undefined,
          );
          if (key) {
            const chat = activeChatsStore.getSnapshot()[key];
            if (chat) entry = [key, chat];
          }
        }
        if (!entry)
          throw new Error(
            'Open this conversation in chat, then choose New Task from this.',
          );
        const [key, chat] = entry;
        const agent = chat.agentSlug;
        if (!agent) throw new Error('The conversation has no selected Agent.');
        navigation.setActiveChat(key);
        showChatPageOrDock(() => navigation.setDockState(true, true));
        // An explicit promotion sends a new turn, without consuming a person's unsent draft or files.
        updateChat(key, { taskShaping: true });
        const focusedMessage = chat.messages?.find((message) =>
          source.turnId
            ? message.role === 'assistant' && message.turnId === source.turnId
            : source.eventId
              ? message.sourceEventId === source.eventId
              : false,
        );
        const excerpt =
          source.excerpt ??
          (typeof focusedMessage?.content === 'string'
            ? focusedMessage.content
            : undefined);
        const savedInput = chat.input;
        const savedAttachments = chat.attachments;
        const sent = await send(
          key,
          agent,
          chat.conversationId,
          'Shape this conversation into a Task.',
          [],
          `${TASK_SHAPING_INSTRUCTION}${excerpt ? `\nFocus on this excerpt from the conversation:\n> ${excerpt.slice(0, 2000).replaceAll('\n', '\n> ')}` : ''}`,
        );
        const latest = activeChatsStore.getSnapshot()[key];
        if (latest && !latest.input)
          updateChat(key, {
            input: savedInput,
            attachments: savedAttachments,
          });
        if (sent === false)
          throw new Error(
            'The shaping message could not be sent. Inspect the chat for its delivery status.',
          );
      }
    } catch (error) {
      toastStore.show(
        error instanceof Error
          ? error.message
          : 'The shaping message could not be sent. Try again.',
      );
    } finally {
      pending.current = false;
    }
  });
  useEffect(() => {
    const open = (event: Event) => {
      void start((event as CustomEvent<TaskShapingRequest>).detail);
    };
    window.addEventListener(TASK_SHAPING_EVENT, open);
    return () => window.removeEventListener(TASK_SHAPING_EVENT, open);
  }, []);
  return null;
}
