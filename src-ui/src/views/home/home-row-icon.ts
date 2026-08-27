import type { SessionIconAgent } from '../../utils/sessionDisplay';
import type { HomeWorkItem } from './home-view-model';

/**
 * The agent a Home row's leading icon stands for, or `null` for no icon.
 *
 * `null` is the whole point. `sessionIconAgent` can fall back to the ENGINE's
 * product name because it holds an `OrchestrationSessionSummary` and can read
 * `session.provider`; a `HomeWorkItem` carries no provider, so there is no
 * second derivation to fall back to here — only `agentLabel`, which is a
 * DISPLAY string that may already be an engine name, a bare slug, or
 * `'Agent not reported'`. Feeding that to `AgentIcon` would mint an identicon
 * or an initials tile for a name nothing resolved, which is exactly the
 * defect `home-view-model.ts`'s `safeAgentLabel` docblock records: a Home row
 * once read "Bedrock" beside a Station engine icon because a private table
 * invented product names for ids the canonical one returns `null` for.
 *
 * So: an icon appears only when the row names an agent this Station actually
 * has in its catalog. Everything else renders no icon rather than dressing an
 * unknown adapter up as some engine it might not be.
 */
export function homeRowIconAgent(
  item: Pick<HomeWorkItem, 'agentSlug'>,
  agents: readonly SessionIconAgent[],
): SessionIconAgent | null {
  if (!item.agentSlug) return null;
  return agents.find((agent) => agent.slug === item.agentSlug) ?? null;
}
