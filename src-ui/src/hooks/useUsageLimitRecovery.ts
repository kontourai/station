import type {
  ConnectionRecoveryOutcomeReason,
  ConnectionRecoveryProjection,
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
  | { kind: 'not-waiting' };

interface UsageLimitRecoveryAnswer {
  recovery: ConnectionRecoveryProjection | null;
}

const ACTION_KINDS = [
  'resumed',
  'failed',
  'canceled',
  'retired',
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
  const mutationFor = (action: 'resume' | 'cancel') => ({
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
    },
  });
  const resume = useMutation(mutationFor('resume'));
  const cancel = useMutation(mutationFor('cancel'));
  return {
    recovery: query.data?.recovery ?? null,
    refetch: query.refetch,
    resume,
    cancel,
  };
}
