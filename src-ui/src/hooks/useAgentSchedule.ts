import type {
  AgentJobProposal,
  ConversationAgentSchedule,
} from '@kontourai/station-contracts/agent-schedule';
import type { AutomationProposal } from '@kontourai/station-contracts/automation';
import {
  getJson,
  mutateJson,
  orchestrationQueries,
  readEnvelopeOrThrow,
  StationHttpError,
} from '@kontourai/station-sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import { StationUiError } from '../utils/StationUiError';

/**
 * What an agent scheduled in one conversation: its check-backs, the job and
 * Automation proposals waiting for the person, the jobs the person approved
 * from it, and a usage-limit stop waiting for its reset. One cache entry, read by the
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

const agentScheduleKey = (
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

  // Re-read when the key changes. Never cancelling a read in flight: on
  // mount this joins the query's own first read instead of restarting it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the trigger.
  useEffect(() => {
    if (enabled && refreshKey !== undefined)
      void query.refetch({ cancelRefetch: false });
  }, [refreshKey]);

  const due = soonest(data);
  useEffect(() => {
    if (!enabled || due === undefined) return;
    const wait = due - Date.now() + SETTLE_MS;
    if (wait > MAX_TIMER_MS) return;
    const timer = setTimeout(
      () => {
        void query.refetch();
        void client.invalidateQueries({
          queryKey: orchestrationQueries.sessions(scope).queryKey,
        });
      },
      Math.max(0, wait),
    );
    return () => clearTimeout(timer);
  }, [enabled, due, query.refetch, client, scope]);

  const settle = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: key }),
      client.invalidateQueries({
        queryKey: orchestrationQueries.sessions(scope).queryKey,
      }),
    ]);
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
  const scheduleScope = JSON.stringify(key);
  /** A check-back an unconfined session's agent asked for. */
  const approveWakeUp = useMutation({
    mutationKey: [...key, 'approve-wake-up'],
    onMutate: () => scheduleScope,
    mutationFn: async (wakeUpId: string) =>
      readEnvelopeOrThrow(
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
  /**
   * #4830: a person answers an agent's Automation proposal. Confirm creates
   * it disabled (a source) or observing (a rule) unless `enable` is set.
   */
  const confirmAutomationProposal = useMutation({
    mutationKey: [...key, 'confirm-automation'],
    onMutate: () => scheduleScope,
    mutationFn: async (input: {
      id: string;
      kind: AutomationProposal['kind'];
      enable: boolean;
    }) => {
      const response = await mutateJson(
        `${base}/automation-proposals/${encodeURIComponent(input.id)}/confirm`,
        'POST',
        options(),
        { enable: input.enable },
      );
      const result = await readEnvelopeOrThrow<{
        createdId: string;
        enabled: boolean;
        message?: string;
      }>(response).catch((error: unknown) => {
        if (
          error instanceof StationHttpError &&
          error.status === 409 &&
          error.code === 'automation_proposal_binding_changed'
        )
          throw new StationUiError(
            'The reviewed Agent or its Project access changed. Decline it and ask the Agent again.',
          );
        throw error;
      });
      if (
        typeof result?.createdId !== 'string' ||
        result.createdId.length === 0 ||
        typeof result.enabled !== 'boolean'
      )
        throw new StationUiError(
          'Station did not report the confirmation outcome. Check the proposal before trying again.',
        );
      return {
        createdId: result.createdId,
        enabled: result.enabled,
        message:
          typeof result.message === 'string' ? result.message : undefined,
      };
    },
    onSettled: settle,
  });
  const declineAutomationProposal = useMutation({
    mutationFn: async (proposalId: string) =>
      readData(
        await mutateJson(
          `${base}/automation-proposals/${encodeURIComponent(proposalId)}/decline`,
          'POST',
          options(),
        ),
      ),
    onSettled: settle,
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
  const currentConfirmation =
    enabled && confirmAutomationProposal.context === scheduleScope
      ? confirmAutomationProposal
      : undefined;
  return {
    schedule: data,
    /** The server's list has been read (what is shown is not a placeholder). */
    loaded: query.isSuccess,
    cancelWakeUp,
    approveWakeUp,
    wakeUpApprovalOutcome:
      enabled &&
      approveWakeUp.context === scheduleScope &&
      approveWakeUp.error instanceof StationHttpError &&
      approveWakeUp.error.code === 'wake_up_settled'
        ? approveWakeUp.error.message
        : undefined,
    declineWakeUp,
    declineProposal,
    approveProposal,
    confirmAutomationProposal,
    automationConfirmation:
      currentConfirmation?.data && currentConfirmation.variables
        ? {
            ...currentConfirmation.data,
            proposalId: currentConfirmation.variables.id,
            kind: currentConfirmation.variables.kind,
            requestedEnable: currentConfirmation.variables.enable,
          }
        : undefined,
    automationConfirmationError: currentConfirmation?.error,
    declineAutomationProposal,
    holdResume,
  };
}
