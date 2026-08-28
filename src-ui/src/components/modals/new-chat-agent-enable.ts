import type { AgentData } from '../../contexts/AgentsContext';

/**
 * The one-click Enable affordance for an engine-default alias row
 * (archive#3027). Keyed strictly on the server's machine-readable `enable`
 * signal — never on parsing `unavailableReason`, which is explanatory text,
 * not an authorization to claim a particular repair will work (the same rule
 * `resolveNewChatAgentRemedy` follows).
 *
 * It lives in its own module, re-exported by `new-chat-modal-utils.ts`, for
 * the same reason `lastChosenModel.ts` does: archive#3136 made it a read on an
 * EAGER surface (the chat dock's unavailable-agent banner) as well as the
 * modal's. Importing this two-line predicate through `new-chat-modal-utils`
 * pulls that module's selection-policy and execution/model-resolution graph
 * into the entry chunk with it: measured 256741 entry-JS gzip bytes when the
 * dock imports through `new-chat-modal-utils` against 254750 when it
 * deep-imports here — 1991 bytes of graph nothing on the eager path uses. Its
 * only import is a type, so this module has no runtime dependencies of its own.
 */
export function resolveNewChatAgentEnable(
  agent: Pick<AgentData, 'available' | 'enable'>,
): NonNullable<AgentData['enable']> | undefined {
  return agent.available === false ? agent.enable : undefined;
}
