import { useAgentConnectionsQuery } from '@kontourai/station-sdk';
import { useMemo } from 'react';
import { Button } from '../components/Button';
import { PageRow } from '../components/PageRow';
import {
  activeChatsStore,
  useActiveChatActions,
  useAllActiveChats,
} from '../contexts/ActiveChatsContext';
import { useAgents } from '../contexts/AgentsContext';
import { useModels } from '../contexts/ModelsContext';
import { useNavigation } from '../contexts/NavigationContext';
import { useCreateChatSession } from '../hooks/useActiveChatSessions';
import { useSlashCommands } from '../hooks/useSlashCommands';
import { resolveBindingStatus } from '../utils/execution';
import './commands-view.css';
import './page-layout.css';

/** What each row IS, by where it came from. */
const SOURCE_LABEL = {
  builtin: 'Builtin',
  skill: 'Skill',
  custom: 'Authored',
  acp: 'Engine',
} as const;

export function CommandsView() {
  const navigation = useNavigation();
  const chats = useAllActiveChats();
  const agents = useAgents();
  const models = useModels();
  const { data: agentConnections = [] } = useAgentConnectionsQuery();
  const { updateChat } = useActiveChatActions();
  const createChatSession = useCreateChatSession();
  const activeEntry = Object.entries(chats).find(
    ([sessionId, chat]) =>
      sessionId === navigation.activeChat ||
      chat.conversationId === navigation.activeChat,
  );
  const activeSessionId = activeEntry?.[0] ?? null;
  const activeChat = activeEntry?.[1] ?? null;
  const activeAgent = agents.find(
    (agent) => agent.slug === activeChat?.agentSlug,
  );
  const runtimeConnection = agentConnections.find(
    (connection) =>
      connection.id ===
      (activeChat?.agentConnectionId ??
        activeAgent?.execution?.agentConnectionId),
  );
  const bindingStatus = useMemo(
    () =>
      activeChat
        ? resolveBindingStatus({
            agent: activeAgent,
            chatState: activeChat,
            runtimeConnection,
            globalModels: models,
          })
        : undefined,
    [activeAgent, activeChat, models, runtimeConnection],
  );
  const { catalog } = useSlashCommands(
    activeAgent?.slug ?? null,
    activeChat,
    bindingStatus,
  );

  function stageInChat(command: string) {
    let sessionId = activeSessionId;
    if (!sessionId) {
      const defaultAgent =
        agents.find((agent) => agent.slug === 'station') ?? agents[0];
      if (!defaultAgent) return;
      sessionId = createChatSession(defaultAgent.slug, defaultAgent.name);
    }
    activeChatsStore.updateChat(sessionId, { input: `${command} ` });
    navigation.setActiveChat(sessionId);
    navigation.setDockState(true);
    updateChat(sessionId, { hasUnread: false });
  }

  return (
    <div className="pane-host commands-view">
      {/* The page title is the Guidance tab's, rendered by the frame. What
          is left here is the part that changes with the open chat, which is
          a note about the list below, not a page subtitle. */}
      <div className="commands-view__intro">
        <p className="commands-view__note">
          {activeChat
            ? `Commands for the current ${activeAgent?.name ?? 'chat'} session.`
            : 'Full default catalog. Engine-specific availability depends on the session engine.'}
        </p>
        {/* Every authorable command IS a skill, so there is one place to make
            one: the Skills editor, with the command switch already on. */}
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            navigation.navigate('/guidance/new', {
              tab: 'skills',
              filter: 'commands',
            })
          }
        >
          + New command
        </Button>
      </div>
      <div className="commands-view__list">
        {catalog.map((command) => (
          // Availability is part of the key: a clash loser and its winner
          // share the word (that IS the clash) but not the row.
          <PageRow
            key={`${command.source}-${command.cmd}-${command.availability.available}`}
            label={
              <code>
                {command.cmd}
                {command.aliases?.length
                  ? ` (${command.aliases.join(', ')})`
                  : ''}
              </code>
            }
            description={command.description}
            status={
              <div className="commands-view__status">
                <span className="commands-view__source">
                  {SOURCE_LABEL[command.source ?? 'builtin']}
                </span>
                <span
                  className={
                    command.availability.available
                      ? 'commands-view__available'
                      : 'commands-view__unavailable'
                  }
                >
                  {command.availability.available
                    ? 'Available'
                    : activeChat
                      ? command.availability.reason
                      : command.availability.reason.replace(
                          'Requires ',
                          'Available when the session engine provides ',
                        )}
                </span>
              </div>
            }
            control={
              <button
                type="button"
                className="editor-btn"
                disabled={
                  !command.availability.available || agents.length === 0
                }
                onClick={() => stageInChat(command.cmd)}
              >
                Use in chat
              </button>
            }
          />
        ))}
      </div>
    </div>
  );
}
