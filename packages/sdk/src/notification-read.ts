import { _getApiBase, apiErrorMessage } from './api-core';
import { authenticatedFetch } from './client/http';

export type NotificationReadOutcome =
  | 'read'
  | 'already-read'
  | 'no-envelope'
  | 'not-delivered';

/**
 * Record that this client read an enveloped notification (#2587). The server
 * derives the reader's surface — a paired device from its credential, any
 * other caller from `clientSessionId`, sent as `X-Station-Client-Session` —
 * and never accepts one from the body.
 *
 * A subpath rather than a barrel export: only lazily loaded notification
 * surfaces call it, and the barrel is part of the UI entry chunk.
 */
export async function markNotificationRead(input: {
  id: string;
  clientSessionId: string;
}): Promise<NotificationReadOutcome> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/notifications/${encodeURIComponent(input.id)}/read`,
    {
      method: 'POST',
      headers: { 'X-Station-Client-Session': input.clientSessionId },
    },
  );
  const result = (await response.json()) as {
    success: boolean;
    data?: { outcome?: NotificationReadOutcome };
    error?: string;
  };
  if (!result.success || !result.data?.outcome) {
    throw new Error(
      apiErrorMessage(result, 'Failed to mark notification read'),
    );
  }
  return result.data.outcome;
}
