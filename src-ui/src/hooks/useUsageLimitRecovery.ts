import type {
  ConnectionRecoveryOutcomeReason,
  ConnectionRecoveryProjection,
  UsageLimitContinueOnOptions,
  UsageLimitContinueOnProfile,
} from '@kontourai/station-contracts/connection-recovery';
import { getJson, mutateJson } from '@kontourai/station-sdk';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

/**
 * #3157: the chat banner's data. One bounded read of the Session's usage-limit
 * recovery projection, and the two person-owned actions on it. The read is
 * enabled only while the conversation's snapshot says its latest turn ended on
 * a usage limit, so a conversation that never hit one issues no request, and
 * the banner adds no polling: callers refetch on the snapshot updates and the
 * reset time they already have.
 */

/** What an action did on the server (`UsageLimitRecoveryActionResult`). */
export type UsageLimitActionResult =
  | { kind: 'resumed' }
  | { kind: 'failed' }
  | { kind: 'canceled' }
  | { kind: 'retired'; reason: ConnectionRecoveryOutcomeReason }
  | { kind: 'chosen'; choice: 'resume' | 'hold' }
  | { kind: 'not-switched' }
  | { kind: 'not-waiting' };

interface UsageLimitRecoveryAnswer {
  recovery: ConnectionRecoveryProjection | null;
}

const ACTION_KINDS = [
  'resumed',
  'failed',
  'canceled',
  'retired',
  'chosen',
  'not-switched',
  'not-waiting',
];

function isProjection(value: unknown): value is ConnectionRecoveryProjection {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { outcome?: unknown }).outcome === 'string' &&
    typeof (value as { decision?: unknown }).decision === 'string'
  );
}

async function readData(response: Response): Promise<{
  recovery: ConnectionRecoveryProjection | null;
  result?: UsageLimitActionResult;
}> {
  let body: { success?: boolean; data?: Record<string, unknown> } | undefined;
  try {
    body = (await response.json()) as typeof body;
  } catch {
    body = undefined;
  }
  const data = body?.data;
  if (!response.ok || body?.success !== true || !data)
    throw new Error(`Usage-limit recovery request failed (${response.status})`);
  const recovery = isProjection(data.recovery) ? data.recovery : null;
  const result = data.result as UsageLimitActionResult | undefined;
  return {
    recovery,
    ...(result && ACTION_KINDS.includes(result.kind) ? { result } : {}),
  };
}

const usageLimitRecoveryKey = (
  apiBase: string,
  scope: ApiRequestScope | undefined,
  threadId: string,
) => ['usage-limit-recovery', apiBase, scope?.authorityKey ?? null, threadId];

const NO_ACCOUNTS: UsageLimitContinueOnOptions = { profiles: [] };

/**
 * Bounded, shape-checked account list for one stop; anything malformed, or a
 * list without the stop it is for, offers nothing.
 */
function readOptions(data: unknown): UsageLimitContinueOnOptions {
  const { profiles, stopId } = (data ?? {}) as {
    profiles?: unknown;
    stopId?: unknown;
  };
  if (!Array.isArray(profiles) || typeof stopId !== 'string')
    return NO_ACCOUNTS;
  const valid = profiles
    .slice(0, 16)
    .filter(
      (profile): profile is UsageLimitContinueOnProfile =>
        !!profile &&
        typeof profile === 'object' &&
        typeof (profile as { ref?: unknown }).ref === 'string' &&
        ((profile as { label?: unknown }).label === undefined ||
          typeof (profile as { label?: unknown }).label === 'string'),
    );
  return valid.length > 0 ? { stopId, profiles: valid } : NO_ACCOUNTS;
}

const path = (apiBase: string, threadId: string, leaf = '') =>
  `${apiBase}/api/orchestration/sessions/${encodeURIComponent(threadId)}/usage-limit${leaf}`;

export function useUsageLimitRecovery(input: {
  apiBase: string;
  scope: ApiRequestScope | undefined;
  threadId: string;
  /** The snapshot says the conversation's latest turn ended on a usage limit. */
  enabled: boolean;
}) {
  const { apiBase, scope, threadId, enabled } = input;
  const queryClient = useQueryClient();
  const key = usageLimitRecoveryKey(apiBase, scope, threadId);
  const query = useQuery({
    queryKey: key,
    enabled,
    retry: false,
    // A remount within moments reuses the read; snapshot updates and the
    // reset time refetch explicitly.
    staleTime: 5_000,
    queryFn: async ({ signal }): Promise<UsageLimitRecoveryAnswer> => {
      const { recovery } = await readData(
        await getJson(path(apiBase, threadId), {
          signal,
          ...(scope ? { requestScope: scope } : {}),
          maxResponseBytes: 64 * 1024,
        }),
      );
      return { recovery };
    },
  });
  // Every action answers with the projection as it stands afterward, so a
  // click on a banner that has since settled reads back the real state.
  const mutationFor = (
    action: 'resume' | 'cancel' | 'resume-at-reset' | 'hold',
  ) => ({
    mutationFn: async () =>
      readData(
        await mutateJson(path(apiBase, threadId, `/${action}`), 'POST', {
          ...(scope ? { requestScope: scope } : {}),
          maxResponseBytes: 64 * 1024,
        }),
      ),
    onSuccess: ({
      recovery,
    }: {
      recovery: ConnectionRecoveryProjection | null;
    }) => {
      queryClient.setQueryData<UsageLimitRecoveryAnswer>(key, { recovery });
      // The chat's Scheduled list shows a resume waiting for its reset.
      void queryClient.invalidateQueries({ queryKey: ['agent-schedule'] });
    },
  });
  // "Continue on <label>" is offered only on a stop still waiting. Its read
  // takes the credential-management scope; a refusal offers nothing.
  const waitingOutcome = query.data?.recovery?.outcome;
  const continueOnKey = [...key, 'continue-on'];
  const continueOnQuery = useQuery({
    queryKey: continueOnKey,
    enabled:
      enabled &&
      query.data?.recovery?.usageLimit === true &&
      (waitingOutcome === 'armed' || waitingOutcome === 'manual'),
    retry: false,
    staleTime: 5_000,
    queryFn: async ({ signal }): Promise<UsageLimitContinueOnOptions> => {
      const response = await getJson(path(apiBase, threadId, '/continue-on'), {
        signal,
        ...(scope ? { requestScope: scope } : {}),
        maxResponseBytes: 16 * 1024,
      });
      // A device without the credential-management scope is refused: that
      // is "nothing to offer", not a banner error.
      if (!response.ok) return NO_ACCOUNTS;
      try {
        const body = (await response.json()) as {
          success?: boolean;
          data?: unknown;
        };
        return body.success === true ? readOptions(body.data) : NO_ACCOUNTS;
      } catch {
        return NO_ACCOUNTS;
      }
    },
  });
  /** Continue this stop on another enrolled credential profile, now. */
  const continueOn = useMutation({
    /** The account chosen and the stop it was offered for. */
    mutationFn: async ({
      profileRef,
      stopId,
    }: {
      profileRef: string;
      stopId: string;
    }) =>
      readData(
        await mutateJson(
          path(apiBase, threadId, '/continue-on'),
          'POST',
          {
            ...(scope ? { requestScope: scope } : {}),
            maxResponseBytes: 64 * 1024,
          },
          { profileRef, stopId },
        ),
      ),
    onSuccess: ({ recovery }) => {
      queryClient.setQueryData<UsageLimitRecoveryAnswer>(key, { recovery });
      void queryClient.invalidateQueries({ queryKey: continueOnKey });
      void queryClient.invalidateQueries({ queryKey: ['agent-schedule'] });
    },
  });
  const resume = useMutation(mutationFor('resume'));
  const cancel = useMutation(mutationFor('cancel'));
  /** This stop only: resume at the reset whatever the setting says. */
  const resumeAtReset = useMutation(mutationFor('resume-at-reset'));
  /** This stop only: do not resume on its own. */
  const hold = useMutation(mutationFor('hold'));
  return {
    recovery: query.data?.recovery ?? null,
    refetch: query.refetch,
    resume,
    cancel,
    resumeAtReset,
    hold,
    continueOnProfiles: continueOnQuery.data?.profiles ?? [],
    continueOnStopId: continueOnQuery.data?.stopId,
    continueOn,
  };
}
