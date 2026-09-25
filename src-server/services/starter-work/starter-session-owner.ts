import type { AdoptedSessionResult } from '@kontourai/station-contracts/orchestration';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import type { OrchestrationService } from '../orchestration/orchestration-service.js';
import type { StarterSessionOwner } from './starter-registry.js';

/**
 * Starter Work's `continue-session` owner: reads an attached Session and
 * continues it by adopting it, through the same `adoptSession` command
 * `/commands` dispatches. #2493: the launching request's full-access grant
 * rides the dispatch context, so the adopted child is stamped `host` exactly
 * when a `/commands adoptSession` from the same caller would be.
 */
export function createStarterSessionOwner(
  orchestration: Pick<
    OrchestrationService,
    'readSession' | 'dispatchWithReceipt'
  >,
): StarterSessionOwner {
  return {
    read: async (sessionId) => {
      const detail = await orchestration.readSession(
        sessionId,
        INTERNAL_SESSION_READ_SCOPE,
      );
      return detail
        ? {
            threadId: detail.session.threadId,
            controlMode: detail.session.controlMode,
          }
        : null;
    },
    continue: async ({ sourceSessionId, operationId, fullAccessGrant }) => {
      try {
        const command = {
          type: 'adoptSession' as const,
          sourceThreadId: sourceSessionId,
          idempotencyKey: operationId,
        };
        // Without a grant this is exactly the call it always was.
        const outcome = fullAccessGrant
          ? await orchestration.dispatchWithReceipt(command, {
              fullAccessGrant,
            })
          : await orchestration.dispatchWithReceipt(command);
        const session = outcome.result as AdoptedSessionResult | undefined;
        if (!session?.threadId)
          return {
            state: 'unavailable' as const,
            reason:
              'Station accepted continuation without an exact child Session.',
            retrySafe: true,
            receiptId: outcome.receipt.commandId,
          };
        return {
          state: 'continued' as const,
          session,
          receiptId: outcome.receipt.commandId,
        };
      } catch (error) {
        const observed = error as {
          message?: string;
          receipt?: { commandId?: string };
          receiptStatus?: 'persisted' | 'unavailable';
        };
        return {
          state:
            observed.receiptStatus === 'persisted'
              ? ('failed' as const)
              : ('indeterminate' as const),
          reason:
            observed.message ??
            'The Session continuation outcome is unavailable.',
          retrySafe: true,
          ...(observed.receipt?.commandId
            ? { receiptId: observed.receipt.commandId }
            : {}),
        };
      }
    },
  };
}
