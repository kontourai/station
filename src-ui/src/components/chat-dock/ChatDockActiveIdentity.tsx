import { useEffect, useRef, useState } from 'react';
import type { AgentData } from '../../contexts/AgentsContext';
import { withShortcutHint } from '../../contexts/KeyboardShortcutsContext';
import { useShortcutDisplay } from '../../hooks/useKeyboardShortcut';
import { copyToClipboard } from '../../lib/clipboard';
import { triggerHaptic } from '../../platform/native/haptics';
import type { ChatSession } from '../../types';
import { agentEngineDescriptor } from '../../utils/engine';
import { EngineChip } from '../badges/EngineChip';
import { FlowGatedChip } from '../flow/FlowGatedChip';
import { AgentIcon } from '../icons/AgentIcon';

interface ChatDockActiveIdentityProps {
  session: ChatSession;
  agent?: AgentData;
  /**
   * Human label for the model this chat runs, from
   * `effectiveChatModelId` + `modelIdentityLabel` — the same two derivations
   * the composer's model pill uses. `null`/absent when no model was reported;
   * the header then names none rather than inventing one.
   */
  modelLabel?: string | null;
  onClose: (id: string) => void;
}

/**
 * The active conversation's compact identity belongs to the dock header, not
 * to the action row below it. Keeping it as a component prevents the header
 * and tab bar from growing duplicate session/engine rendering paths (#1064).
 *
 * station#3309 (owner: "showing agent icons and metadata"): the row reads
 * AGENT-first. The agent's icon leads, then its name, then the engine that
 * executes it and the model it runs; the session title follows as the thing
 * that distinguishes one chat with that agent from another. It used to open
 * with the session title and hang the engine chip off the end, which named
 * the conversation but never the thing answering in it.
 */
export function ChatDockActiveIdentity({
  session,
  agent,
  modelLabel,
  onClose,
}: ChatDockActiveIdentityProps) {
  const closeTabShortcut = useShortcutDisplay('dock.closeTab');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>(
    'idle',
  );
  const copyResetRef = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      if (copyResetRef.current !== undefined) {
        window.clearTimeout(copyResetRef.current);
      }
    },
    [],
  );

  const copyThreadId = async () => {
    // `conversationId` is the durable Station thread id supplied by the
    // conversation route. `session.id` is only the local tab/store key, so
    // never fall back to it here: a copied value must remain usable by the
    // CLI and receipt readers.
    if (!session.conversationId) return;
    const copied = await copyToClipboard(session.conversationId);
    if (copied) triggerHaptic('light');
    setCopyState(copied ? 'copied' : 'failed');
    if (copyResetRef.current !== undefined) {
      window.clearTimeout(copyResetRef.current);
    }
    copyResetRef.current = window.setTimeout(() => setCopyState('idle'), 1500);
  };

  const engine = agent
    ? agentEngineDescriptor({
        slug: session.agentSlug,
        name: agent.name,
        source: agent.source,
        engineId: agent.engineId,
        connectionName: agent.connectionName,
        engineDisplayName: agent.engineDisplayName,
        model: agent.model,
        execution: agent.execution,
      })
    : null;
  // The agent's own name now leads this row, so an engine chip repeating it
  // ("Station" beside the agent called Station) prints one word twice rather
  // than adding an identity. Same de-duplication `agentEngineDescriptor`
  // already applies to an ACP connection's self-referential model (#894
  // MED-1), applied one level up now that the name is visible here too.
  //
  // Latent, if this call site ever starts passing `engineConnectionType`:
  // this drops the WHOLE descriptor on a name match, including the `model`
  // that only the ACP branch populates — and that model is precisely what
  // disambiguates two identically-named connections. The redundancy being
  // removed is the name, so the narrower fix then is to blank
  // `engine.name` and keep the model, not to null the descriptor.
  const agentName = agent?.name ?? session.agentName;
  const engineChip =
    engine && agentName && engine.name.toLowerCase() === agentName.toLowerCase()
      ? null
      : engine;
  // The avatar's identity comes from the SESSION's committed agent slug, which
  // is present whether or not the enriched catalog resolved this agent, so the
  // header and the transcript's message avatars stay the same picture. Artwork
  // (`icon`) is the only part that needs the catalog; without it `AgentIcon`
  // falls back to its slug-seeded identicon (station#1424) — a deterministic
  // rendering of the id we hold, not a claim that this agent has artwork.
  const iconSubject = {
    name: agentName,
    slug: session.agentSlug,
    icon: agent?.icon,
  };

  return (
    <div className="chat-dock__active-identity">
      <AgentIcon
        agent={iconSubject}
        size={20}
        className="chat-dock__active-identity-avatar"
      />
      <div className="chat-dock__active-identity-text">
        {agentName && (
          <strong className="chat-dock__active-identity-agent">
            {agentName}
          </strong>
        )}
        <EngineChip engine={engineChip} />
        {modelLabel && (
          <span className="chat-dock__active-identity-model">{modelLabel}</span>
        )}
        <span className="chat-dock__active-identity-title">
          {session.title}
        </span>
      </div>
      {session.flowRun && <FlowGatedChip binding={session.flowRun} />}
      {session.conversationId && (
        <>
          <button
            type="button"
            className={`chat-dock__icon-btn chat-dock__active-identity-copy${
              copyState === 'failed' ? ' copy-affordance--failed' : ''
            }`}
            style={{
              minWidth: 44,
              minHeight: 44,
              flex: '0 0 auto',
              color: 'var(--text-tertiary)',
              fontSize: 'var(--text-xs)',
            }}
            aria-label="Copy thread ID"
            title={
              copyState === 'failed'
                ? 'This browser refused clipboard access — select the thread ID from the session list to copy it manually.'
                : 'Copy thread ID'
            }
            onClick={() => {
              void copyThreadId();
            }}
          >
            {/* #765 A7: the idle label says what pressing it does. A bare
                "ID" chip beside the title read as a debug artifact, not as
                the copy affordance its aria-label already named. */}
            {copyState === 'copied'
              ? 'Copied'
              : copyState === 'failed'
                ? "Can't copy"
                : 'Copy ID'}
          </button>
          {/* The button's own name is fixed, so its label change is never
              announced; this sibling carries the outcome. */}
          <span role="status" className="copy-status-sr">
            {copyState === 'copied'
              ? 'Thread ID copied.'
              : copyState === 'failed'
                ? 'This browser refused clipboard access. The thread ID was not copied.'
                : ''}
          </span>
        </>
      )}
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
