import type {
  AgentJobProposal,
  ConversationAgentSchedule,
} from '@kontourai/station-contracts/agent-schedule';
import { getJson, mutateJson } from '@kontourai/station-sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';

/**
 * What an agent scheduled in one conversation: its check-backs, the job
 * proposals waiting for the person, the jobs the person approved from it, and
 * a usage-limit stop waiting for its reset. One cache entry, read by the
 * in-chat notes and by the "This chat" card's Scheduled section.
 *
 * No polling: the chat re-reads it when its schedule may have changed
 * (`refreshKey`: a turn boundary, a finished scheduling call) and once just
 * after the soonest item is due.
 */

const EMPTY: ConversationAgentSchedule = {
  wakeUps: [],
  jobProposals: [],
  jobs: [],
};
/** Past a due time, the server sends it on its own timer; read just after. */
const SETTLE_MS = 1_500;
const MAX_TIMER_MS = 2 ** 31 - 1 - SETTLE_MS;

export const agentScheduleKey = (
  apiBase: string | undefined,
  authorityKey: string | undefined,
  conversationId: string,
) => ['agent-schedule', apiBase ?? null, authorityKey ?? null, conversationId];

async function readData<T>(response: Response): Promise<T> {
  let body: { success?: boolean; data?: T; error?: string } | undefined;
  try {
    body = (await response.json()) as typeof body;
  } catch {
    body = undefined;
  }
  if (!response.ok || body?.success !== true || body.data === undefined)
    throw new Error(body?.error ?? `Request failed (${response.status})`);
  return body.data;
}

function soonest(schedule: ConversationAgentSchedule): number | undefined {
  const times = [
    ...schedule.wakeUps.map((wakeUp) => Date.parse(wakeUp.dueAt)),
    ...(schedule.usageLimitResume
      ? [Date.parse(schedule.usageLimitResume.dueAt)]
      : []),
  ].filter(Number.isFinite);
  return times.length ? Math.min(...times) : undefined;
}

export function useAgentSchedule(
  conversationId: string | null | undefined,
  refreshKey?: string,
) {
  const scope = useHostRequestAuthorityScope();
  const client = useQueryClient();
  const enabled = Boolean(conversationId && scope?.isCurrent());
  const key = agentScheduleKey(
    scope?.apiBase,
    scope?.authorityKey,
    conversationId ?? '',
  );
  const base = `${scope?.apiBase ?? ''}/api/orchestration/agent-schedule/${encodeURIComponent(conversationId ?? '')}`;
  const options = () => ({
    ...(scope ? { requestScope: scope } : {}),
    maxResponseBytes: 256 * 1024,
  });
  const query = useQuery({
    queryKey: key,
    enabled,
    retry: false,
    staleTime: 5_000,
    queryFn: async ({ signal }) =>
      readData<ConversationAgentSchedule>(
        await getJson(base, { signal, ...options() }),
      ),
  });
  const data = query.data ?? EMPTY;

  // Re-read when the key changes, not when it is first seen: the mount's
  // own read already covers that, and a refetch then would cancel it.
  const seenKey = useRef(refreshKey);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the trigger.
  useEffect(() => {
    if (refreshKey === seenKey.current) return;
    seenKey.current = refreshKey;
    if (enabled && refreshKey !== undefined)
      void query.refetch({ cancelRefetch: false });
  }, [refreshKey]);

  const due = soonest(data);
  useEffect(() => {
    if (!enabled || due === undefined) return;
    const wait = due - Date.now() + SETTLE_MS;
    if (wait > MAX_TIMER_MS) return;
    const timer = setTimeout(() => void query.refetch(), Math.max(0, wait));
    return () => clearTimeout(timer);
  }, [enabled, due, query.refetch]);

  const settle = () => client.invalidateQueries({ queryKey: key });
  const cancelWakeUp = useMutation({
    mutationFn: async (wakeUpId: string) =>
      readData(
        await mutateJson(
          `${base}/wake-ups/${encodeURIComponent(wakeUpId)}/cancel`,
          'POST',
          options(),
        ),
      ),
    onSettled: settle,
  });
  /** A check-back an unconfined session's agent asked for. */
  const approveWakeUp = useMutation({
    mutationFn: async (wakeUpId: string) =>
      readData(
        await mutateJson(
          `${base}/wake-ups/${encodeURIComponent(wakeUpId)}/approve`,
          'POST',
          options(),
        ),
      ),
    onSettled: settle,
  });
  const declineWakeUp = useMutation({
    mutationFn: async (wakeUpId: string) =>
      readData(
        await mutateJson(
          `${base}/wake-ups/${encodeURIComponent(wakeUpId)}/decline`,
          'POST',
          options(),
        ),
      ),
    onSettled: settle,
  });
  const declineProposal = useMutation({
    mutationFn: async (proposalId: string) =>
      readData(
        await mutateJson(
          `${base}/job-proposals/${encodeURIComponent(proposalId)}/decline`,
          'POST',
          options(),
        ),
      ),
    onSettled: settle,
  });
  /** Approve: the person's own scheduler create, naming the proposal. */
  const approveProposal = useMutation({
    mutationFn: async (proposal: AgentJobProposal) =>
      readData(
        await mutateJson(
          `${scope?.apiBase ?? ''}/scheduler/jobs`,
          'POST',
          options(),
          { ...proposal.job, proposalId: proposal.id },
        ),
      ),
    onSettled: () => {
      void settle();
      void client.invalidateQueries({ queryKey: ['scheduler'] });
    },
  });
  /** "Don't resume" on a usage-limit stop from the Scheduled list. */
  const holdResume = useMutation({
    mutationFn: async (threadId: string) =>
      readData(
        await mutateJson(
          `${scope?.apiBase ?? ''}/api/orchestration/sessions/${encodeURIComponent(threadId)}/usage-limit/hold`,
          'POST',
          options(),
        ),
      ),
    onSettled: () => {
      void settle();
      void client.invalidateQueries({ queryKey: ['usage-limit-recovery'] });
    },
  });
  return {
    schedule: data,
    /** The server's list has been read (what is shown is not a placeholder). */
    loaded: query.isSuccess,
    cancelWakeUp,
    approveWakeUp,
    declineWakeUp,
    declineProposal,
    approveProposal,
    holdResume,
  };
}
