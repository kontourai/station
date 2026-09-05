import type { AgentData } from '../../contexts/AgentsContext';
import { type AgentRunnability, agentRunnability } from '../agent-runnability';

/**
 * Which Agents a scheduled job may name — asked ONCE, so the picker's rows,
 * the form's explanation, and the submit button's enablement cannot disagree.
 *
 * TWO SEPARATE QUESTIONS, deliberately kept apart:
 *
 * 1. ELIGIBILITY is a contract, not a readiness state. The in-process
 *    scheduler runner resolves an Agent through the runtime's `activeAgents`
 *    map (`createScheduledTurnAdapter`), which holds only Station-engine
 *    instances; an Agent bound to an external engine connection is not in it
 *    and the run fails instantly with `Agent '<slug>' not found` (#890). That
 *    is permanent for as long as the binding exists, so those Agents are not
 *    offered at all and the form says why — listing them as rows a click
 *    cannot select taught the reader the picker was broken.
 *
 * 2. RUNNABILITY is the server's readiness derivation, read through the one
 *    shared `agentRunnability` predicate rather than re-derived here. An
 *    eligible Agent that cannot run right now IS listed — disabled, carrying
 *    the server's own reason — because that state is temporary and the reason
 *    is the only thing that tells a person what to fix.
 */
export const SCHEDULER_ENGINE_AGENT_NOTE =
  "Scheduled jobs run on Station's own engine, so Agents bound to an external engine are not listed.";

/**
 * Spoken on the one row that names an ineligible Agent: an edited job's own.
 *
 * TRUE OF THE TURN PATH ONLY. A monitor job dispatches through `taskDispatcher`
 * rather than `createScheduledTurnAdapter`, and that path DOES support an
 * engine-bound Agent — which is why the form's Monitor Agent field is a
 * separate question from this one. If a monitor row ever consumes this reason it
 * will be saying something false; the eligibility rule below is about the
 * scheduler's own turn invocation, nothing else.
 */
export const SCHEDULER_ENGINE_AGENT_REASON =
  "Runs on an external engine, which the scheduler cannot invoke — scheduled jobs run on Station's own engine.";

/** Said when a job names an Agent the catalog does not have. */
export function schedulerMissingAgentReason(slug: string): string {
  return `No Agent named '${slug}'.`;
}

export type SchedulerEligibleAgent = Pick<AgentData, 'execution'>;

/**
 * The runner's resolvability rule: no external engine binding. An ABSENT
 * binding is Station's own engine, not "unbound" — see `agent-runnability.ts`.
 */
export function isSchedulerEligibleAgent(agent: SchedulerEligibleAgent) {
  return !agent.execution?.agentConnectionId;
}

export type SchedulerAgentOptions = {
  /** Every Agent the runner can resolve, whether or not it can run now. */
  eligible: AgentData[];
  /** Agents withheld because they run on an external engine. */
  excludedEngineAgents: AgentData[];
  /** The first eligible Agent that can run right now, if there is one. */
  defaultSlug: string | null;
};

export function schedulerAgentOptions(
  agents: readonly AgentData[],
): SchedulerAgentOptions {
  const eligible: AgentData[] = [];
  const excludedEngineAgents: AgentData[] = [];
  for (const agent of agents) {
    if (isSchedulerEligibleAgent(agent)) eligible.push(agent);
    else excludedEngineAgents.push(agent);
  }
  const defaultAgent = eligible.find(
    (agent) => agentRunnability(agent).runnable,
  );
  return {
    eligible,
    excludedEngineAgents,
    defaultSlug: defaultAgent ? defaultAgent.slug : null,
  };
}

/**
 * Can this named slug run a scheduled job, and if not, why. Composed from the
 * eligibility contract and the server's readiness, in that order: a bound
 * Agent's engine reason is the fact a reader needs, even when the server also
 * happens to call it available.
 */
export function schedulerAgentRunnability(
  agents: readonly AgentData[],
  slug: string,
): AgentRunnability {
  const agent = agents.find((candidate) => candidate.slug === slug);
  if (!agent) {
    return { runnable: false, reason: schedulerMissingAgentReason(slug) };
  }
  if (!isSchedulerEligibleAgent(agent)) {
    return { runnable: false, reason: SCHEDULER_ENGINE_AGENT_REASON };
  }
  return agentRunnability(agent);
}
