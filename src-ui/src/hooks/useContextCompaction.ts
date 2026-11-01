import type { ConversationCompactionView } from '@kontourai/station-contracts/conversation-context-boundary';
import {
  getJson,
  mutateJson,
  readEnvelopeOrThrow,
} from '@kontourai/station-sdk';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import { useSurfaceVisibilityFlags } from './useSurfaceVisibilityFlags';

const path = (apiBase: string, conversationId: string) =>
  `${apiBase}/api/orchestration/conversations/${encodeURIComponent(conversationId)}/compaction`;
export async function readContextCompaction(
  apiBase: string,
  conversationId: string,
  requestScope?: ApiRequestScope,
): Promise<ConversationCompactionView> {
  const response = await getJson(path(apiBase, conversationId), {
    requestScope,
  });
  if (response.status === 404 || response.status === 501)
    throw new Error(
      'Context compaction is unavailable. Enable its Feature Preview or update this Station.',
    );
  const view = await readEnvelopeOrThrow<ConversationCompactionView>(response);
  if (!view)
    throw new Error(
      'Context compaction state is unavailable. Reload and try again.',
    );
  return view;
}
/** Both composer control and slash command request the same server-owned operation. */
export async function compactConversation(
  apiBase: string,
  conversationId: string,
  requestScope?: ApiRequestScope,
): Promise<unknown> {
  const view = await readContextCompaction(
    apiBase,
    conversationId,
    requestScope,
  );
  if (view.state !== 'ready')
    throw new Error(view.reason ?? `Context compaction: ${view.state}.`);
  return readEnvelopeOrThrow(
    await mutateJson(
      path(apiBase, conversationId),
      'POST',
      { requestScope, timeoutMs: 120_000 },
      {
        expectedSessionId: view.currentSessionId,
        operationId: randomCorrelationId(),
        mode: 'manual',
      },
    ),
  );
}
export function useContextCompaction(apiBase: string, conversationId: string) {
  const scope = useHostRequestAuthorityScope();
  const flags = useSurfaceVisibilityFlags();
  const enabled =
    flags.has('context-compaction') &&
    scope?.apiBase === apiBase &&
    Boolean(conversationId);
  const key = [
    'context-compaction',
    apiBase,
    scope?.authorityKey,
    conversationId,
  ];
  const client = useQueryClient();
  const query = useQuery({
    queryKey: key,
    enabled,
    retry: false,
    queryFn: () =>
      readContextCompaction(apiBase, conversationId, scope ?? undefined),
  });
  const compact = useMutation({
    retry: false,
    mutationFn: () => {
      if (!enabled)
        throw new Error(
          'Context compaction is unavailable under this authority.',
        );
      return compactConversation(apiBase, conversationId, scope ?? undefined);
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: key });
    },
  });
  const policy = useMutation({
    retry: false,
    mutationFn: async (input: { threshold: number; autoEnabled: boolean }) => {
      if (!enabled || !query.data)
        throw new Error(
          'Current compaction policy is unavailable. Reload first.',
        );
      return readEnvelopeOrThrow(
        await mutateJson(
          path(apiBase, conversationId),
          'PUT',
          { requestScope: scope ?? undefined },
          {
            ...input,
            expectedCurrentSessionId: query.data.currentSessionId,
            expectedRevision: query.data.policyRevision,
          },
        ),
      );
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: key });
    },
  });
  return { enabled, query, compact, policy };
}
