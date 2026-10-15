import {
  useEngineConnectionsQuery,
  useProjectQuery,
} from '@kontourai/station-sdk';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { showChatPageOrDock } from '../../app-shell/chat-placement';
import { useActiveChatActions } from '../../contexts/ActiveChatsContext';
import { useAgents } from '../../contexts/AgentsContext';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { useNavigation } from '../../contexts/NavigationContext';
import { useProjects } from '../../contexts/ProjectsContext';
import {
  useLaunchChat,
  useOpenConversation,
  useSendMessage,
} from '../../hooks/useActiveChatSessions';
import {
  TASK_SHAPING_EVENT,
  TASK_SHAPING_INSTRUCTION,
  type TaskShapingRequest,
} from '../../lib/task-shaping';
import { resolveAgentExecution } from '../../utils/execution';
import { selectChatReadyAgents } from '../agent-selection-policy';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import './TaskShaping.css';

/** One host, shared by project, global, header and reference entry points. */
export function TaskShapingHost() {
  const [request, setRequest] = useState<TaskShapingRequest | null>(null);
  useEffect(() => {
    const open = (event: Event) =>
      setRequest((event as CustomEvent<TaskShapingRequest>).detail);
    window.addEventListener(TASK_SHAPING_EVENT, open);
    return () => window.removeEventListener(TASK_SHAPING_EVENT, open);
  }, []);
  return request ? (
    <TaskShapingComposer request={request} onClose={() => setRequest(null)} />
  ) : null;
}

export function TaskShapingComposer({
  request,
  onClose,
}: {
  request: TaskShapingRequest;
  onClose: () => void;
}) {
  const { apiBase } = useApiBase();
  const agents = useAgents();
  const { projects, isConfirmedLoaded } = useProjects();
  const [projectSlug, setProjectSlug] = useState(request.projectSlug ?? '');
  const [agentSlug, setAgentSlug] = useState(request.agentSlug ?? '');
  const [idea, setIdea] = useState('');
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState<string>();
  const input = useRef<HTMLTextAreaElement>(null);
  const { data: project } = useProjectQuery(projectSlug, {
    enabled: Boolean(projectSlug),
  });
  const { data: agentConnections = [] } = useEngineConnectionsQuery();
  const eligible = selectChatReadyAgents({
    agents,
    agentConnections,
    selectedProjectSlug: projectSlug || undefined,
    selectedProjectAgentFilter: project?.agents,
  });
  const selectedAgent = agentSlug
    ? eligible.find((agent) => agent.slug === agentSlug)
    : eligible[0];
  const launch = useLaunchChat(apiBase);
  const send = useSendMessage(apiBase);
  const openConversation = useOpenConversation(apiBase);
  const { updateChat } = useActiveChatActions();
  const navigation = useNavigation();
  const selectedProject = projects.find(
    (candidate) => candidate.slug === projectSlug,
  );

  async function start() {
    if (
      pending ||
      (!request.source &&
        (!idea.trim() || !selectedAgent || !selectedProject || !project))
    )
      return;
    setPending(true);
    setFailed(undefined);
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
            'Open this conversation in chat, then choose Turn into Task.',
          );
        const [key, chat] = entry;
        const agent = chat.agentSlug;
        if (!agent) throw new Error('The conversation has no selected Agent.');
        navigation.setActiveChat(key);
        showChatPageOrDock(() => navigation.setDockState(true));
        // An explicit promotion sends a new turn, without consuming a person's unsent draft or files.
        const savedInput = chat.input;
        const savedAttachments = chat.attachments;
        const sent = await send(
          key,
          agent,
          chat.conversationId,
          `Shape this conversation into a Task.${idea.trim() ? `\n\n${idea.trim()}` : ''}`,
          [],
          `${TASK_SHAPING_INSTRUCTION}${source.turnId ? `\nFocus on the answer in turn ${source.turnId}.` : source.eventId ? `\nFocus on input event ${source.eventId}.` : ''}`,
        );
        const latest = activeChatsStore.getSnapshot()[key];
        if (latest && !latest.input)
          updateChat(key, { input: savedInput, attachments: savedAttachments });
        if (sent === false)
          throw new Error(
            'The shaping message could not be sent. Inspect the chat for its delivery status.',
          );
      } else if (selectedAgent && selectedProject) {
        await launch(
          selectedAgent.slug,
          selectedAgent.name,
          idea.trim(),
          projectSlug,
          selectedProject.name,
          resolveAgentExecution(selectedAgent),
          TASK_SHAPING_INSTRUCTION,
        );
      }
      onClose();
    } catch (error) {
      setFailed(
        error instanceof Error
          ? error.message
          : 'The shaping chat could not start. Your idea is kept; try again.',
      );
      setPending(false);
    }
  }

  return createPortal(
    <Dialog
      closeLabel="Close Task shaping"
      title={request.source ? 'Turn into Task' : 'New Task'}
      eyebrow="Shape in chat"
      subtitle="Describe the idea. Refine it together, then choose Create Task on the proposal."
      onClose={onClose}
      initialFocusRef={input}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            pending={pending}
            pendingLabel="Opening chat…"
            disabled={
              !request.source &&
              (!idea.trim() || !selectedAgent || !selectedProject || !project)
            }
            onClick={() => void start()}
          >
            {request.source ? 'Shape this conversation' : 'Start shaping'}
          </Button>
        </>
      }
    >
      <div className="task-shaping-composer">
        <label>
          {request.source
            ? 'Anything to focus on? (optional)'
            : 'What would you like to work on?'}
          <textarea
            ref={input}
            value={idea}
            onChange={(event) => setIdea(event.target.value)}
            placeholder={
              request.source
                ? 'Use the conversation so far…'
                : 'A rough idea or a clear one-liner…'
            }
          />
        </label>

        {!request.source && (
          <div className="task-shaping-composer__context">
            <label>
              Project
              <select
                aria-label="Project"
                value={projectSlug}
                onChange={(event) => {
                  setProjectSlug(event.target.value);
                  setAgentSlug('');
                }}
              >
                <option value="">Choose a project</option>
                {projects.map((item) => (
                  <option key={item.slug} value={item.slug}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Agent
              <select
                aria-label="Agent"
                value={selectedAgent?.slug ?? ''}
                onChange={(event) => setAgentSlug(event.target.value)}
              >
                {!selectedAgent && <option value="">No available agent</option>}
                {eligible.map((agent) => (
                  <option key={agent.slug} value={agent.slug}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        {!request.source && isConfirmedLoaded && projects.length === 0 && (
          <p>Create a project first to give your Task a home.</p>
        )}
        {failed && <p role="alert">{failed}</p>}
      </div>
    </Dialog>,
    document.body,
  );
}
