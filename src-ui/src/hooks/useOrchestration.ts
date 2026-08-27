import type { StagedAttachmentReference } from '@kontourai/station-contracts/attachment-staging';
import type { ChatAttachmentInput } from '@kontourai/station-contracts/chat-attachment';
import type {
  EnvironmentRef,
  ExecutionTarget,
} from '@kontourai/station-contracts/execution-target';
import {
  useOrchestrationProvidersQuery,
  useQueryClient,
} from '@kontourai/station-sdk';
import {
  type ForegroundMessageReceipt,
  sendExecutionMessage as sendExecutionMessageRequest,
} from '@kontourai/station-sdk/client';
import { useEffect } from 'react';
import { ensureOrchestrationEventStream } from './orchestration/ensureOrchestrationEventStream';

// Guardrailed by proof:repo-governance.
// fallow-ignore-next-line unused-export
export function useOrchestration(apiBase: string) {
  // station#1225 review (MEDIUM fix): resolved HERE (a real hook boundary)
  // and threaded through to the reconnect-fallback refetch — see
  // `rehydrateChatSession.ts`'s file-header note for why the module-level
  // SSE stream can't call `useQueryClient()` itself.
  const queryClient = useQueryClient();
  useEffect(() => {
    ensureOrchestrationEventStream(apiBase, queryClient);
  }, [apiBase, queryClient]);

  const providersQuery = useOrchestrationProvidersQuery();

  return {
    providers: providersQuery.data || [],
    isLoadingProviders: providersQuery.isLoading,
  };
}

/** Canonical Agent-only foreground execution used by the chat composer. */
export async function sendExecutionMessage(input: {
  apiBase: string;
  target: Omit<ExecutionTarget, 'environment'> & {
    environment?: EnvironmentRef;
  };
  message: string;
  conversationId?: string;
  attachments?: ChatAttachmentInput[];
  /** Opaque references produced by supervised composer staging. */
  attachmentRefs?: StagedAttachmentReference[];
  ambientContext?: string;
  clientTurnId?: string;
  signal?: AbortSignal;
}): Promise<ForegroundMessageReceipt> {
  return sendExecutionMessageRequest(
    input.apiBase,
    {
      target: input.target,
      message: input.message,
      conversationId: input.conversationId,
      attachments: input.attachments,
      attachmentRefs: input.attachmentRefs,
      ambientContext: input.ambientContext,
      clientTurnId: input.clientTurnId,
    },
    { signal: input.signal },
  );
}
