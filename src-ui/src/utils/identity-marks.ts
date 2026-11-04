import {
  type EngineId,
  parseEngineId,
} from '@kontourai/station-contracts/agent-identity';
import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
import { hasBundledEngineMark } from '../components/icons/BrandIcon';
import type { SessionIconAgent } from './sessionDisplay';

/**
 * THE one resolver for "which mark heads this row" (#4266). The inbox, Home,
 * the Sessions list, the project page and child-work rows used to carry three
 * resolvers with three fallback rules; they now differ only in the options
 * they pass here.
 */

/** An engine drawn as itself: its bundled mark, else its name's initials. */
export function engineMark(provider: EngineId): SessionIconAgent {
  return { name: engineDisplayLabel(provider) ?? provider, engineId: provider };
}

/**
 * An agent's own mark. A catalog `engineId` with no bundled mark (`acp`, a
 * plugin engine) would otherwise win over the agent's identity and draw the
 * AGENT's initials — which is how the built-in Station agent, bound to an ACP
 * engine on the owner's server, read "ST" instead of Station's mark. Such an
 * engine yields to the agent's slug, so Station draws its own mark and any
 * other agent its seeded identicon, exactly as with no engine at all.
 */
function ownAgentMark(agent: SessionIconAgent): SessionIconAgent {
  if (!agent.engineId || hasBundledEngineMark(agent.engineId)) return agent;
  const { engineId: _unmarked, ...identity } = agent;
  return identity;
}

/**
 * The mark for the agent behind `slug`, or `null` when the catalog does not
 * resolve it.
 *
 * - An agent bound to an engine connection the catalog could not name the
 *   engine of draws the row's recorded `provider` when that engine has a
 *   bundled mark (#3355) — never for an ACP-bound agent, whose provider is
 *   not an engine's identity, and never for an unbound agent.
 * - `fallbackToEngine` stands the engine in for an agent the catalog does not
 *   resolve. Only correct where the engine's name is also the text beside the
 *   mark (the Sessions list); a row that names an agent must not.
 *
 * The catalog entry is returned BY REFERENCE whenever nothing applies.
 */
export function agentMark(
  slug: string | undefined,
  provider: string | undefined,
  agents: readonly SessionIconAgent[] | undefined,
  options: { fallbackToEngine?: boolean } = {},
): SessionIconAgent | null {
  const agent = slug
    ? agents?.find((candidate) => candidate.slug === slug)
    : undefined;
  const engine = parseEngineId(provider);
  if (!agent) {
    return options.fallbackToEngine && provider
      ? { name: engineDisplayLabel(provider) ?? provider, engineId: provider }
      : null;
  }
  if (
    agent.engineId ||
    !agent.execution?.agentConnectionId ||
    agent.engineConnectionType === 'acp'
  ) {
    return ownAgentMark(agent);
  }
  return engine && engine !== 'acp' && hasBundledEngineMark(engine)
    ? { ...agent, engineId: engine }
    : agent;
}

/** How many engine marks a row draws before it says "+N". */
export const MAX_IDENTITY_MARKS = 3;

export interface IdentityMarks {
  /** At most `MAX_IDENTITY_MARKS`, in the order the engines first ran. */
  marks: SessionIconAgent[];
  /** Engines beyond the ones drawn. */
  more: number;
  /** Every engine's name, for a tooltip; empty for an agent mark. */
  engineNames: string[];
}

/**
 * A work row's marks: the engine(s) that actually ran it, several when the
 * thread was handed between engines. Engines with no bundled mark add
 * nothing (their mark would be initials, which say less than the agent's own
 * mark). With no markable engine on record the row falls back to the agent's
 * mark, and an agent the catalog does not resolve draws nothing.
 */
export function workIdentityMarks(
  item: {
    agentSlug?: string;
    provider?: EngineId;
    executionProviders?: readonly EngineId[];
  },
  agents: readonly SessionIconAgent[] | undefined,
): IdentityMarks {
  const ran = item.executionProviders?.length
    ? item.executionProviders
    : item.provider
      ? [item.provider]
      : [];
  const engines = [...new Set(ran)].filter(
    (engine) => engine !== 'acp' && hasBundledEngineMark(engine),
  );
  if (engines.length > 0) {
    return {
      marks: engines.slice(0, MAX_IDENTITY_MARKS).map(engineMark),
      more: Math.max(0, engines.length - MAX_IDENTITY_MARKS),
      engineNames: engines.map((engine) => engineMark(engine).name),
    };
  }
  const agent = agentMark(item.agentSlug, item.provider, agents);
  return { marks: agent ? [agent] : [], more: 0, engineNames: [] };
}
