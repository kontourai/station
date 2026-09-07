import type { AgentData } from '../contexts/AgentsContext';

/**
 * Can this Agent run, and if not, why — asked ONCE, in one place, by
 * everything that reports that state to a person.
 *
 * It exists because three surfaces answered it three ways and disagreed in
 * public. Home's "Start direct chat" card named `flatList[0]` with no
 * readiness question asked at all, so it recommended "Claude Code" while the
 * New Chat picker — one click away — flagged that same row "⚠ Not set up".
 * The Agents list, meanwhile, showed no state at all. A recommendation the
 * next screen contradicts is worse than no recommendation.
 *
 * WHAT IT READS, AND WHAT IT DELIBERATELY DOES NOT.
 *
 * `available === false` is the SERVER's derivation (`enriched-agents.ts`),
 * computed from connection readiness and model resolution the client cannot
 * see, and its `unavailableReason` is the reason — never a sentence
 * reconstructed here.
 *
 * It does NOT re-derive readiness from the client's engine-connection
 * inventory, and that restraint was learned live. An earlier version added
 * "…or the bound connection is not `status: 'ready'` in
 * `useEngineConnectionsQuery`", which looks like defence in depth and is
 * actually a second opinion that is wrong twice: the query resolves to `[]`
 * while in flight AND when it fails (during a 401 every row of the Agents
 * list read "Not set up: Engine connection 'claude' is not currently ready."
 * — a confident claim derived from no information), and a connection's
 * `status` settles to `ready` a moment after the catalog does, so for that
 * window the list called three perfectly working engines Not set up while the
 * editor beside it showed the same connection as "Ready". A state a surface
 * reports must be one somebody computed, not one this module guessed.
 *
 * It derives NOTHING itself. It used to derive one thing — "an Agent with no
 * `agentConnectionId` has nowhere to run" — and that was a fourth reading of
 * the record contradicting the other three (archive#3662). An absent binding
 * is not "unbound": it is Station's own engine, which is what
 * `docs/design/agent-engine-unification.md` §7.1 says a Station-engine Agent
 * persists, what `resolveExecutionTarget` dispatches on (no binding →
 * `engine: 'station'`), and what `agentEngineDescriptor` two files away has
 * always rendered ("Station"). The server computes whether that engine can
 * run — a managed model has to resolve — and says so through
 * `available`/`unavailableReason`, exactly as it does for every other engine.
 *
 * SEPARATE QUESTION, DELIBERATELY: "can a click start a chat on it RIGHT
 * NOW". That is `canAgentStartChat`, it is strictly stronger, and it is
 * composed with this predicate in `selectChatReadyAgents` rather than folded
 * into it — a picker must not dispatch onto an engine that is still
 * connecting, but no surface should LABEL that engine broken.
 *
 * `enable` is passed through, not re-derived: it is the server's
 * machine-readable "this engine has no Agent yet, and materializing one would
 * work" signal. A consumer must never infer it by reading `reason` prose.
 */
export type AgentRunnability =
  | { runnable: true }
  | {
      runnable: false;
      reason: string;
      /** Present iff the server says materializing this engine's Agent fixes it. */
      enable?: NonNullable<AgentData['enable']>;
    };

/** Spoken when a row is refused with nothing said about why. */
export const AGENT_NOT_RUNNABLE_FALLBACK = 'Not currently runnable.';

export type RunnabilityAgent = Pick<
  AgentData,
  'available' | 'unavailableReason' | 'enable' | 'execution'
>;

export function agentRunnability(agent: RunnabilityAgent): AgentRunnability {
  const notRunnable = (reason: string): AgentRunnability => ({
    runnable: false,
    reason,
    ...(agent.enable ? { enable: agent.enable } : {}),
  });
  if (agent.available === false) {
    return notRunnable(agent.unavailableReason ?? AGENT_NOT_RUNNABLE_FALLBACK);
  }
  return { runnable: true };
}

/** The Agents list's short state chip. Same two words the picker's row uses. */
export const AGENT_NOT_SET_UP_LABEL = 'Not set up';
