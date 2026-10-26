import { parseEngineId } from '@kontourai/station-contracts/agent-identity';
import type { OrchestrationInputOrigin } from '@kontourai/station-contracts/orchestration';
import type { AgentData } from '../../contexts/AgentsContext';
import { withShortcutHint } from '../../contexts/KeyboardShortcutsContext';
import { useShortcutDisplay } from '../../hooks/useKeyboardShortcut';
import type { ChatSession } from '../../types';
import {
  agentEngineDescriptor,
  chatEngineIdentity,
  type EngineDescriptor,
} from '../../utils/engine';
import { engineChipLabel } from '../badges/EngineChip';
import { FlowGatedChip } from '../flow/FlowGatedChip';
import { AgentIcon } from '../icons/AgentIcon';

interface ChatDockActiveIdentityProps {
  session: Pick<ChatSession, 'id' | 'title'> &
    Partial<
      Pick<
        ChatSession,
        | 'agentSlug'
        | 'agentName'
        | 'flowRun'
        | 'orchestrationProvider'
        | 'agentConnectionId'
        | 'agentConnectionObservedFor'
        | 'currentSessionId'
        | 'conversationId'
      >
    >;
  /**
   * The Agent whose engine binding runs this chat: a conversation override's
   * execution Agent (`executionAgentId`), else `agent`. The composer chip
   * compares against the same Agent, so the two cannot disagree.
   */
  executionAgent?: AgentData;
  /** ACP connections, which alone name a Session on the generic ACP provider. */
  acpConnections?: readonly { id: string; name: string }[];
  originLabel?: string;
  originProvider?: string;
  onDetails?: () => void;
  agent?: AgentData;
  /**
   * Human label for the model this chat runs, from
   * `effectiveChatModelId` + `modelIdentityLabel` — the same two derivations
   * the composer's model pill uses. `null`/absent when no model was reported;
   * the header then names none rather than inventing one.
   */
  modelLabel?: string | null;
  routeLabel?: string;
  inputOrigin?: OrchestrationInputOrigin;
  onClose: (id: string) => void;
}

/** Where a delegated conversation is driven from; a task id says nothing. */
export function delegatedTaskLabel(origin: OrchestrationInputOrigin): string {
  return origin.title
    ? `Driven from delegated task: ${origin.title}`
    : 'Driven from a delegated task';
}

/** One line: the conversation title, then the agent and engine, muted; the engine and then the agent step aside before the title truncates. */
export function ChatDockActiveIdentity({
  session,
  agent,
  modelLabel,
  routeLabel,
  originLabel,
  originProvider,
  inputOrigin,
  acpConnections,
  executionAgent,
  onDetails,
  onClose,
}: ChatDockActiveIdentityProps) {
  const closeTabShortcut = useShortcutDisplay('dock.closeTab');

  const bindingAgent = executionAgent ?? agent;
  const configuredEngine = bindingAgent
    ? agentEngineDescriptor({
        slug:
          bindingAgent === agent
            ? (session.agentSlug ?? bindingAgent.slug)
            : bindingAgent.slug,
        name: bindingAgent.name,
        source: bindingAgent.source,
        engineId: bindingAgent.engineId,
        connectionName: bindingAgent.connectionName,
        engineDisplayName: bindingAgent.engineDisplayName,
        model: bindingAgent.model,
        execution: bindingAgent.execution,
      })
    : null;
  // The same rule as the composer's engine chip (`chatEngineIdentity`): once
  // the chat has a Session, the Agent's configuration names its engine only
  // while that Session runs on the Agent's current connection. An engine that
  // cannot be named yet shows no engine rather than a guess.
  const engineIdentity = chatEngineIdentity({
    orchestrationProvider: session.orchestrationProvider,
    currentSessionId: session.currentSessionId ?? session.conversationId,
    sessionConnectionId: session.agentConnectionId,
    connectionObservedFor: session.agentConnectionObservedFor,
    configuredConnectionId: bindingAgent?.execution?.agentConnectionId,
    acpConnections,
  });
  const configurationNamesEngine =
    engineIdentity.relation === 'no-session' ||
    engineIdentity.relation === 'same';
  const engine: EngineDescriptor | null = configurationNamesEngine
    ? configuredEngine
    : engineIdentity.sessionEngine
      ? { name: engineIdentity.sessionEngine }
      : null;
  // The assistant name already appears in the context line, so a chip repeating it
  // ("Station" beside the agent called Station) prints one word twice rather
  // than adding an identity. Same de-duplication `agentEngineDescriptor`
  // already applies to an ACP connection's self-referential model (#894),
  // applied one level up now that the name is visible here too.
  //
  // Latent, if this call site ever starts passing `engineConnectionType`:
  // this drops the WHOLE descriptor on a name match, including the `model`
  // that only the ACP branch populates — and that model is precisely what
  // disambiguates two identically-named connections. The redundancy being
  // removed is the name, so the narrower fix then is to blank
  // `engine.name` and keep the model, not to null the descriptor.
  const agentName = agent?.name ?? session.agentName ?? 'Chat';
  const engineChip =
    engine && agentName && engine.name.toLowerCase() === agentName.toLowerCase()
      ? null
      : engine;
  // The avatar's identity comes from the SESSION's committed agent slug, which
  // is present whether or not the enriched catalog resolved this agent, so the
  // identicon seed does not depend on the catalog. Artwork (`icon`) needs the
  // catalog; without it `AgentIcon` falls back to its slug-seeded identicon
  // (station#1424) — a deterministic rendering of the id we hold, not a claim
  // that this agent has artwork.
  //
  // The engine mark (#3355) comes from an imported session's recorded
  // provider, else from the catalog's engine for this agent. A local chat has
  // no `originProvider`, so without the catalog fallback a Codex agent drew
  // "CO" initials here even with the catalog healthy. This is not guaranteed
  // to match every transcript avatar: a message row that carries its own
  // `agentDisplayName` draws from that attribution, which has no engine id.
  const iconSubject = {
    name: agentName,
    slug: session.agentSlug,
    icon: agent?.icon,
    engineId:
      parseEngineId(originProvider) ??
      (configurationNamesEngine
        ? bindingAgent?.engineId
        : parseEngineId(session.orchestrationProvider)),
  };
  // The bar shows the agent and the engine on the title's line; the model and
  // the route are the composer's (its model picker names them), so here they
  // are only the tooltip. `engineChipLabel` already joins an engine with its
  // own model ("OpenCode · GLM-4.7"); the trail names nothing it cannot
  // derive and is empty when neither is known.
  const engineLabel = originLabel ?? engineChipLabel(engineChip);
  const fullTrail =
    originLabel ??
    [
      engineChipLabel(engineChip),
      modelLabel,
      routeLabel ? `via ${routeLabel}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
  const contextTitle = [!originLabel ? agentName : null, fullTrail]
    .filter(Boolean)
    .join(' · ');
  const delegationTitle = inputOrigin ? delegatedTaskLabel(inputOrigin) : null;

  return (
    <div className="chat-dock__active-identity">
      {!originLabel && (
        <AgentIcon
          agent={iconSubject}
          size={20}
          className="chat-dock__active-identity-avatar"
        />
      )}
      <div className="chat-dock__active-identity-text">
        <span
          className="chat-dock__active-identity-title"
          // The agent, engine and delegation may have stepped aside for
          // the title; its tooltip keeps them.
          title={[session.title, contextTitle, delegationTitle]
            .filter(Boolean)
            .join('\n')}
        >
          {session.title}
        </span>
        <span
          className="chat-dock__active-identity-context"
          title={contextTitle || undefined}
        >
          {agentName && !originLabel && (
            <strong className="chat-dock__active-identity-agent">
              {agentName}
            </strong>
          )}
          {engineLabel && (
            <span
              className={`chat-dock__active-identity-engine${originLabel ? ' chat-dock__active-identity-origin' : ''}`}
            >
              {originLabel && <AgentIcon agent={iconSubject} size={18} />}
              {engineLabel}
            </span>
          )}
        </span>
        {inputOrigin && (
          <span
            className="chat-dock__active-identity-engine"
            title={delegationTitle ?? undefined}
          >
            Driven from delegation
          </span>
        )}
      </div>
      {onDetails && (
        <button
          type="button"
          className="chat-dock__active-identity-close"
          onClick={onDetails}
          aria-label="Chat details"
          title="Chat details"
        >
          <span aria-hidden="true">⋯</span>
        </button>
      )}
      {session.flowRun && <FlowGatedChip binding={session.flowRun} />}
      {/* #1536 F: "Copy ID" was a 44px labelled button inside the identity
          row, competing with the title for the same pixels. It is a row of the
          dock header's More menu now (`useDockCopyActions`), which reports the
          outcome through a toast instead of an inline label. */}
      <button
        type="button"
        className="chat-dock__active-identity-close"
        aria-label="Close chat"
        title={withShortcutHint(
          'Close',
          'dock.closeTab',
          () => closeTabShortcut,
        )}
        onClick={() => onClose(session.id)}
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}
