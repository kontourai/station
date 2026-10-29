import type { Notification } from '@kontourai/station-contracts/notification';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ApiRequestScope, getJson, mutateJson } from '../client/http';
import type { NotificationReadOutcome } from '../notification-read';

export type PersonNotificationRequestScope = ApiRequestScope & {
  isCurrent: () => boolean;
};
export type PersonNotificationReadOutcome = NotificationReadOutcome;
export type PersonNotificationMutationInput = {
  id: string;
  /** Required for a caller without a verified paired-device identity. */
  clientSessionId?: string;
};

function current(scope: PersonNotificationRequestScope) {
  if (!scope.isCurrent()) throw new Error('Notification connection changed');
}

export function personNotificationsKey(scope: PersonNotificationRequestScope) {
  return ['person-notifications', scope.apiBase, scope.authorityKey] as const;
}

export async function fetchPersonNotifications(
  scope: PersonNotificationRequestScope,
  signal?: AbortSignal,
): Promise<Notification[]> {
  current(scope);
  const response = await getJson(`${scope.apiBase}/api/me/notifications`, {
    requestScope: scope,
    signal,
    maxResponseBytes: 16 * 1024 * 1024,
  });
  current(scope);
  if (response.status === 404)
    throw new Error(
      'This Station does not support person notifications. Update the host.',
    );
  if (!response.ok)
    throw new Error(
      `Person notifications unavailable (HTTP ${response.status})`,
    );
  const body = (await response.json()) as { success?: boolean; data?: unknown };
  current(scope);
  if (body.success !== true || !Array.isArray(body.data))
    throw new Error('Invalid person notifications response');
  return body.data as Notification[];
}

async function mutatePersonNotification(
  scope: PersonNotificationRequestScope,
  input: PersonNotificationMutationInput,
  operation: 'read' | 'dismiss',
): Promise<PersonNotificationReadOutcome | undefined> {
  current(scope);
  const suffix = operation === 'read' ? '/read' : '';
  const response = await mutateJson(
    `${scope.apiBase}/api/me/notifications/${encodeURIComponent(input.id)}${suffix}`,
    operation === 'read' ? 'POST' : 'DELETE',
    {
      requestScope: scope,
      ...(input.clientSessionId
        ? { headers: { 'X-Station-Client-Session': input.clientSessionId } }
        : {}),
    },
  );
  current(scope);
  if (response.status === 404)
    throw new Error(
      'Notification not found, or this Station does not support person notifications. Update the host if needed.',
    );
  if (!response.ok)
    throw new Error(
      `Person notification ${operation} failed (HTTP ${response.status})`,
    );
  const body = (await response.json()) as {
    success?: boolean;
    data?: { outcome?: string };
  };
  current(scope);
  if (body.success !== true)
    throw new Error(`Person notification ${operation} failed`);
  if (operation === 'dismiss') return undefined;
  const outcome = body.data?.outcome;
  if (
    outcome !== 'read' &&
    outcome !== 'already-read' &&
    outcome !== 'no-envelope' &&
    outcome !== 'not-delivered'
  )
    throw new Error('Invalid person notification read response');
  return outcome;
}

export async function markPersonNotificationRead(
  scope: PersonNotificationRequestScope,
  input: PersonNotificationMutationInput,
): Promise<PersonNotificationReadOutcome> {
  return (await mutatePersonNotification(scope, input, 'read'))!;
}

export async function dismissPersonNotification(
  scope: PersonNotificationRequestScope,
  input: PersonNotificationMutationInput,
): Promise<void> {
  await mutatePersonNotification(scope, input, 'dismiss');
}

export function usePersonNotificationsQuery(
  scope: PersonNotificationRequestScope,
) {
  return useQuery({
    queryKey: personNotificationsKey(scope),
    retry: false,
    refetchOnMount: 'always',
    queryFn: ({ signal }) => fetchPersonNotifications(scope, signal),
  });
}

export function useMarkPersonNotificationReadMutation(
  scope: PersonNotificationRequestScope,
) {
  const client = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: async (input: PersonNotificationMutationInput) => {
      const result = await markPersonNotificationRead(scope, input);
      await client.invalidateQueries({
        queryKey: personNotificationsKey(scope),
      });
      current(scope);
      return result;
    },
  });
}

export function useDismissPersonNotificationMutation(
  scope: PersonNotificationRequestScope,
) {
  const client = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: async (input: PersonNotificationMutationInput) => {
      await dismissPersonNotification(scope, input);
      await client.invalidateQueries({
        queryKey: personNotificationsKey(scope),
      });
      current(scope);
    },
  });
}
