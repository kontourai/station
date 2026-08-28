import type { EngineId } from '@kontourai/station-contracts/agent-identity';
import {
  type ConversationListItem,
  useConversationInventoryQuery,
} from '@kontourai/station-sdk';
import { useMemo } from 'react';
import { agentEngineDescriptor, type EngineDescriptor } from '../utils/engine';

interface Agent {
  slug: string;
  name: string;
  source?: string;
  icon?: string;
  connectionType?: string | null;
  connectionName?: string | null;
  engineDisplayName?: string | null;
  model?: string;
  engineId?: EngineId;
  engineConnectionType?: string;
  plugin?: string;
  execution?: { agentConnectionId?: string | null };
}

interface Conversation extends ConversationListItem {
  agentName?: string;
  agentEngine?: EngineDescriptor | null;
}

/**
 * What `useSessionManagementViewModel` actually returns per conversation —
 * `Conversation` above types the raw per-agent query result; this adds the
 * fields the map loop below computes on top of it (workspace-scope
 * metadata + the resolved engine chip), so consumers get real field-level
 * type safety instead of `Conversation`'s narrower shape silently
 * undershooting the real output.
 */
interface EnrichedConversation extends Conversation {
  agentType: 'acp' | 'layout' | 'global';
  agentLabel?: string;
  agentContext: string;
  agentIcon?: string;
}

function compareConversationRecency(
  left: Pick<Conversation, 'id' | 'updatedAt'>,
  right: Pick<Conversation, 'id' | 'updatedAt'>,
): number {
  const leftTime = Date.parse(left.updatedAt);
  const rightTime = Date.parse(right.updatedAt);
  const leftValid = Number.isFinite(leftTime);
  const rightValid = Number.isFinite(rightTime);

  if (leftValid && rightValid && leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  if (leftValid !== rightValid) {
    return leftValid ? -1 : 1;
  }
  return right.id.localeCompare(left.id);
}

/**
 * ViewModel for session management
 * Reads the one canonical inventory instead of fanning out one request per
 * agent. This makes history agree with Home/mobile inbox on runtime-owned
 * conversations, project scope, model provenance, and durable read state.
 */
export function useSessionManagementViewModel(
  agents: Agent[],
  enabled: boolean = true,
) {
  const inventory = useConversationInventoryQuery({ enabled });

// Combine and sort all conversations
  const conversations = useMemo(() => {
    const allConversations: EnrichedConversation[] = [];

    for (const conv of inventory.data ?? []) {
      const agent = agents.find(
        (candidate) => candidate.slug === conv.agentSlug,
      );
// A conversation can outlive a removed/temporarily unavailable Agent.
// Keep it visible and honest rather than losing history until the
// catalogue reloads.
      const resolvedAgent = agent ?? {
        slug: conv.agentSlug,
        name: conv.agentSlug,
      };
      let agentType: 'acp' | 'layout' | 'global' = 'global';
      let agentLabel = resolvedAgent.name;
      let agentContext = '';

      const slug: string = resolvedAgent.slug;
      if (resolvedAgent.engineConnectionType === 'acp') {
        agentType = 'acp';
        const dash = slug.indexOf('-');
        agentContext = dash > 0 ? slug.substring(0, dash) : 'acp';
        agentLabel = dash > 0 ? slug.substring(dash + 1) : resolvedAgent.name;
      } else if (resolvedAgent.plugin) {
        agentType = 'layout';
        agentContext = resolvedAgent.plugin;
        agentLabel = resolvedAgent.name;
      }
 // /: every resolved agent gets an engine chip, not just
// ACP ones — this surface used to render a literal "ACP" pill for
// the acp branch and no chip at all for Station/plugin-engine
// conversations; agentEngineDescriptor already returns null for an
// unresolvable engine, so an unresolved agent stays chipless the
// same way every other chip surface honors.
      const agentEngine: EngineDescriptor | null =
        agentEngineDescriptor(resolvedAgent);

      allConversations.push({
        ...conv,
        agentName: resolvedAgent.name,
        agentType,
        agentLabel,
        agentContext,
        agentEngine,
        agentIcon: resolvedAgent.icon,
// Normalize title — some conversations store message objects instead of strings
        title:
          typeof conv.title === 'string'
            ? conv.title
            : Array.isArray(conv.title)
              ? (conv.title as any[])[0]?.content?.[0]?.text ||
                (conv.title as any[])[0]?.content ||
                'Untitled'
              : conv.title
                ? String(conv.title)
                : undefined,
      });
    }

// Every history source reaches this client projection. Keep its ordering
// deterministic even if a provider supplies an invalid or tied timestamp.
    allConversations.sort(compareConversationRecency);

    return allConversations;
  }, [inventory.data, agents]);

  const loading = inventory.isLoading;
  const error = inventory.error;

  return {
    conversations,
    loading,
    error,
    hasMore: inventory.hasMore,
    loadingMore: inventory.loadingMore,
    loadMoreError: inventory.loadMoreError,
    loadMore: inventory.loadMore,
  };
}
