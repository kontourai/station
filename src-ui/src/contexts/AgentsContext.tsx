import type { EnrichedAgentProjection } from '@kontourai/station-contracts/enriched-agent';
import {
  useAgentsQuery,
  useCreateAgentDetailedMutation,
  useDeleteAgentMutation,
  useUpdateAgentMutation,
} from '@kontourai/station-sdk';
import { log } from '@/utils/logger';

export type AgentData = EnrichedAgentProjection;

const EMPTY_AGENTS: AgentData[] = [];

export function useAgents(): AgentData[] {
  const { data, error } = useAgentsQuery();

  if (error) log.api('Failed to fetch agents:', error);

  return data || EMPTY_AGENTS;
}

/**
 * Whether `/api/agents` is currently serving the LAST STABLE catalog rather
 * than a read of the runtime as it is now (station#1574's `catalogState`,
 * surfaced by station#3751).
 *
 * A consumer that renders a state WORD off these rows — "Ready", "Needs: …" —
 * is reading a verdict computed for a configuration that may already be gone.
 * The rows themselves are fine; it is the readiness that is stale.
 */
export function useAgentCatalogReconciling(): boolean {
  return useAgentsQuery().catalogState === 'reconciling';
}

/**
 * True once the agent-catalog query has resolved SUCCESSFULLY at least once
 * — deliberately not "settled" (success or error). `useAgents()` alone
 * cannot distinguish "not loaded yet" from "loaded, zero agents" — both read
 * as `[]` — which matters to any consumer that needs to tell a catalog that
 * legitimately has nothing in it apart from one that just hasn't answered
 * yet (e.g. `useChatDockActiveChatSync`'s #801 deleted-agent clear, #945 MED
 * finding).
 *
 * `!isLoading` was the first cut and is wrong: react-query also clears
 * `isLoading` on a query that ERRORED (network down, 5xx, etc.), so an
 * unavailable catalog would read exactly like a durably-empty one — a
 * transient outage would then read as "this agent definitely doesn't exist"
 * and a consumer gating a destructive decision on it (the #801 clear) would
 * permanently drop a perfectly valid `activeChat` pointer on a hiccup it
 * could have retried past (#945 round-2 MED finding). Gating on `isSuccess`
 * instead means an errored or still-fetching catalog reports `false` here,
 * so those consumers stay in a "not conclusive yet" / retry-pending posture
 * instead of treating a failure as a definitive miss.
 */
export function useAgentsLoaded(): boolean {
  const { isSuccess } = useAgentsQuery();
  return isSuccess;
}

/**
 * True once the catalog has ANSWERED — successfully or not. Deliberately
 * distinct from `useAgentsLoaded` (success only): a caller that must not
 * stall forever on an unavailable catalog needs "the question was asked and
 * answered", not "the answer was good". The first-run engines chapter
 * (station#3027) gates on both — it waits for an answer here, then treats a
 * FAILED catalog as "no work", because without the agent list it cannot tell
 * an engine that is already enabled from one that is not, and guessing
 * creates duplicates.
 */
export function useAgentsSettled(): boolean {
  const { isSuccess, isError } = useAgentsQuery();
  return isSuccess || isError;
}

export function useAgent(slug: string): AgentData | null {
  const agents = useAgents();
  return agents.find((a) => a.slug === slug) || null;
}

export function useAgentActions() {
  const createMutation = useCreateAgentDetailedMutation({
    onError: (error) => log.api('Failed to create agent:', error),
  });

  const updateMutation = useUpdateAgentMutation({
    onError: (error) => log.api('Failed to update agent:', error),
  });

  const deleteMutation = useDeleteAgentMutation({
    onError: (error) => log.api('Failed to delete agent:', error),
  });

  return {
    createAgent: (agent: AgentData) =>
      createMutation.mutateAsync(agent as unknown as Record<string, unknown>),
    // `project: null` is the ownership-clearing wire signal (station#1004
    // §4) — distinct from `AgentData.project`'s read shape
    // (`string | undefined`), which never represents "clear this".
    // station#3662: `execution: null` is the engine-binding-clearing wire
    // signal, for the same reason and with the same shape — an Agent moved to
    // Station's own engine must actively lose its `agentConnectionId`, which
    // an omitted (undefined) block cannot express because the server's update
    // treats undefined as "leave this alone".
    updateAgent: (
      slug: string,
      agent: Partial<Omit<AgentData, 'project' | 'execution'>> & {
        project?: string | null;
        execution?: AgentData['execution'] | null;
      },
    ) =>
      updateMutation.mutateAsync({
        slug,
        agent: agent as Record<string, unknown>,
      }),
    deleteAgent: (slug: string) => deleteMutation.mutateAsync(slug),
  };
}
