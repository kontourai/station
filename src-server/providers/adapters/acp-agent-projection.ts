/**
 * The resolved Station agent, projected onto an engine's own agent channel.
 *
 * Kiro's agent service takes client agents as `_meta.kiro.customAgents` on
 * `session/new` and `session/load`, and starts the session in one when
 * `_meta.kiro.modeId` names it. An injected agent surfaces as a mode whose
 * `_meta.kiro.resource.source.origin` is `client` (live, kiro-cli 3.3.0
 * `--agent-engine v3`, 2026-11-13).
 *
 * The wire schema is `{ id, description?, prompt, tools?: '*' | string[],
 * excludedTools?, model?, includeMcpJson?, includePowers?, mcpServers?,
 * resources?, permissions?, welcomeMessage? }`, at most 50 entries
 * (@kiro/agent 0.66.102 `validateAndConvertClientCustomAgents`). Two
 * properties drive the projection:
 *
 * - `tools` absent means NO tools (`tools ?? []`), so it is always `['*']`.
 * - No `permissions` block. With none, the agent service resolves every
 *   tool request to "ask", so each call reaches Station's own
 *   `session/request_permission` policy. Live: a `tools: ['*']` agent with no
 *   permissions asked before `fs_write`.
 *
 * `prompt` is sent empty. Station already delivers the agent's authored
 * prompt on the first turn (`channel: 'first-turn'`, session-agent-
 * resolution.ts) and reports that delivery; sending it here as well would
 * give the model the prompt twice and leave the receipt describing only one
 * of them. With an empty prompt the agent runs on the engine's own default
 * prompt, as kiro-cli does for a prompt-less agent.
 *
 * Applies only to a session whose handshake identifies Kiro's agent service
 * (`resolveAcpEngineVariant` -> `kiro-v3`). Nothing else is sent the field.
 */
import type { ResolvedAgentDefinition } from '@kontourai/station-contracts/provider';
import {
  type AcpIdentityHandshake,
  resolveAcpEngineVariant,
} from '../../services/acp/acp-handshake-facts.js';
import { isRecord } from '../../utils/is-record.js';

/** The agent service's cap on `_meta.kiro.customAgents` (`z.array(...).max(50)`). */
const KIRO_CUSTOM_AGENTS_MAX = 50;

/** Prefix that keeps a projected id off the engine's own mode ids. */
const PROJECTED_AGENT_PREFIX = 'station-';

export interface KiroClientCustomAgent {
  readonly id: string;
  readonly description: string;
  readonly prompt: string;
  readonly tools: readonly ['*'];
}

/** The id a Station agent is projected under. */
function kiroProjectedAgentId(agent: ResolvedAgentDefinition): string {
  return `${PROJECTED_AGENT_PREFIX}${agent.slug}`;
}

/**
 * The `_meta` to send on `session/new` and `session/load` for this session's
 * agent, or undefined when the engine takes none or there is no agent.
 * `agents` is the session's agent first; at most
 * {@link KIRO_CUSTOM_AGENTS_MAX} are sent, and a list longer than that is
 * refused rather than cut (the engine drops invalid entries one by one, so a
 * cut list could silently lose the one that mattered).
 */
export function kiroCustomAgentsMeta(
  handshake: AcpIdentityHandshake | null | undefined,
  agents: readonly ResolvedAgentDefinition[],
):
  | {
      meta: { kiro: { customAgents: KiroClientCustomAgent[]; modeId: string } };
    }
  | { refused: string }
  | undefined {
  if (resolveAcpEngineVariant(handshake) !== 'kiro-v3') return undefined;
  const [primary] = agents;
  if (!primary) return undefined;
  if (agents.length > KIRO_CUSTOM_AGENTS_MAX)
    return {
      refused: `the engine takes at most ${KIRO_CUSTOM_AGENTS_MAX} agents; ${agents.length} were resolved`,
    };
  const customAgents = agents.map((agent) => ({
    id: kiroProjectedAgentId(agent),
    description: `Station agent ${agent.slug}`,
    prompt: '',
    tools: ['*'] as const,
  }));
  return {
    meta: {
      kiro: { customAgents, modeId: kiroProjectedAgentId(primary) },
    },
  };
}

/** Where a mode came from, as the agent service reports it. */
function modeOrigin(mode: unknown): string | undefined {
  if (!isRecord(mode) || !isRecord(mode._meta)) return undefined;
  const kiro = mode._meta.kiro;
  if (!isRecord(kiro) || !isRecord(kiro.resource)) return undefined;
  const source = kiro.resource.source;
  return isRecord(source) && typeof source.origin === 'string'
    ? source.origin
    : undefined;
}

/**
 * Whether the session took the projected agent as its mode. Refused when
 * the mode the engine now reports under that id is not one the client
 * supplied: a `bundled` (or user-defined) mode of the same id would run the
 * engine's own agent, with its own permissions, under Station's name. The
 * top-level `_meta.kiro.source` reads `bundled` even for a client agent, so
 * only `resource.source.origin` is read.
 */
export function kiroProjectedModeApplied(
  modeId: string,
  sessionResult: { modes?: unknown; configOptions?: unknown } | undefined,
): { applied: true } | { applied: false; reason: string } {
  const modes = isRecord(sessionResult?.modes)
    ? sessionResult.modes
    : undefined;
  const available = Array.isArray(modes?.availableModes)
    ? modes.availableModes
    : [];
  const mode = available.find(
    (candidate) => isRecord(candidate) && candidate.id === modeId,
  );
  if (!mode)
    return {
      applied: false,
      reason: `the engine did not register the agent '${modeId}'`,
    };
  const origin = modeOrigin(mode);
  if (origin !== 'client')
    return {
      applied: false,
      reason: `the engine's mode '${modeId}' is ${origin ? `a ${origin}` : 'an unattributed'} agent, not the one Station supplied`,
    };
  if (modes?.currentModeId !== modeId)
    return {
      applied: false,
      reason: `the session started in '${String(modes?.currentModeId)}', not '${modeId}'`,
    };
  return { applied: true };
}
