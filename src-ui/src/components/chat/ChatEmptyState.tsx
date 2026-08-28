import { getPathForView } from '../../app-shell/routing';
import { useAgents, useAgentsLoaded } from '../../contexts/AgentsContext';
import { useNavigation } from '../../contexts/NavigationContext';
import { useSystemStatus } from '../../hooks/useSystemStatus';
import type { NavigationView } from '../../types';
import { agentEngineDescriptor } from '../../utils/engine';
import { LightbulbGlyph } from '../icons/Glyph';
import {
  buildSetupBannerContent,
  shouldShowSetupBanner,
} from '../onboardingGateUtils';

interface ChatEmptyStateProps {
  agentSlug: string;
  agentName: string;
}

export function ChatEmptyState({ agentSlug, agentName }: ChatEmptyStateProps) {
  const { data: status } = useSystemStatus();
  const { navigate } = useNavigation();
  const agents = useAgents();
  const agentsLoaded = useAgentsLoaded();
  const agent = agents.find((a) => a.slug === agentSlug);

  // archive#1193: a "runtime-only" recommendation means
  // an external engine is ready to chat with no Station model connection —
  // but that's only a real gap for an agent Station's OWN engine executes.
  // An agent bound to an external engine is exactly as chat-capable as the
  // ready engine itself, so it must never show "needs a model connection".
  // Resolve the engine from the persisted Agent projection; ids are opaque.
  const resolvedEngine = agent
    ? agentEngineDescriptor({
        slug: agent.slug,
        name: agent.name,
        source: agent.source,
        engineId: agent.engineId,
        connectionName: agent.connectionName,
        engineDisplayName: agent.engineDisplayName,
        model: agent.model,
        execution: agent.execution,
      })
    : null;
  const isExternalEngineAgent =
    !!resolvedEngine && resolvedEngine.name !== 'Station';

  // archive#1193: `useAgents` reads `[]` both while the
  // catalog is still loading AND once it's durably empty — indistinguishable
  // from here. On a cold load where system `status` resolves before the
  // agent catalog does, that would read a genuine external-engine-bound
  // agent as unresolved and flash "needs a model connection" for one render
  // before self-correcting. `useAgentsLoaded` (AgentsContext.tsx, the
  // existing not-loaded-vs-durably-empty primitive from archive#801/archive#945) gates the
  // whole runtime-only-needs-model decision so we show the neutral/normal
  // empty state instead of a wrong flash while the catalog is still in
  // flight.
  const runtimeOnlyNeedsModel =
    agentsLoaded &&
    status?.recommendation?.code === 'runtime-only' &&
    !isExternalEngineAgent;

  // Loading state (status not yet resolved) keeps today's normal copy so the
  // guided variant doesn't flash in before readiness is known.
  // archive#1544: this used `chatSetupNeeded`, which differed from
  // `shouldShowSetupBanner` only by excluding the 'engine-picker' variant.
  // That variant has been unproducible since archive#1387 and is now gone, so the
  // two predicates were identical and only one remains.
  if (status && (shouldShowSetupBanner(status) || runtimeOnlyNeedsModel)) {
    const content = runtimeOnlyNeedsModel
      ? {
          title: `${agentName} needs a model connection`,
          description:
            'A coding engine is available, but this Station agent still needs a model connection before it can chat.',
          actionLabel: 'Manage Connections',
          badges: [],
          actionTarget: 'providers' as const,
        }
      : buildSetupBannerContent(status);
    const targetView: NavigationView =
      content.actionTarget === 'engine' && content.engineConnectionId
        ? {
            type: 'connections-runtime-edit',
            id: content.engineConnectionId,
          }
        : content.actionTarget === 'connections'
          ? { type: 'connections' }
          : { type: 'connections-providers' };

    return (
      <div className="empty-state" data-testid="chat-empty-state-unconfigured">
        <h3>Connect a model to start chatting</h3>
        <p className="empty-state__detail">{content.title}</p>
        <p>{content.description}</p>
        <button
          type="button"
          className="empty-state__cta"
          onClick={() => navigate(getPathForView(targetView)!)}
        >
          {content.actionLabel}
        </button>
      </div>
    );
  }

  return (
    <div className="empty-state">
      <h3>Start a conversation</h3>
      <p>Type a message below to chat with {agentName}</p>
      <p
        style={{
          fontSize: '0.9em',
          color: 'var(--text-muted)',
          marginTop: '8px',
        }}
      >
        <LightbulbGlyph /> Type{' '}
        <code
          style={{
            padding: '2px 6px',
            background: 'var(--bg-tertiary)',
            borderRadius: '3px',
            fontFamily: 'monospace',
          }}
        >
          /
        </code>{' '}
        to see available commands
      </p>
    </div>
  );
}
