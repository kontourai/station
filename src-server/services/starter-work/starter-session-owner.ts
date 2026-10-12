import type { AdoptedSessionResult } from '@kontourai/station-contracts/orchestration';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import type { OrchestrationService } from '../orchestration/orchestration-service.js';
import type { StarterSessionOwner } from './starter-registry.js';

/**
 * Starter Work's `continue-session` owner: reads an attached Session and
 * continues it by adopting it, through the same `adoptSession` command
 * `/commands` dispatches. The launching request's principal authorizes the
 * source and owns the adopted child, and (#2493) its full-access grant rides
 * the dispatch context, so the child is stamped `host` exactly when a
 * `/commands adoptSession` from the same caller would be.
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
    continue: async ({
      sourceSessionId,
      operationId,
      target,
      fullAccessGrant,
      owner,
      clientOrigin,
    }) => {
      try {
        const command = {
          type: 'adoptSession' as const,
          sourceThreadId: sourceSessionId,
          idempotencyKey: operationId,
          ...(target ? { target } : {}),
        };
        // The caller's principal authorizes the source and owns the child.
        const outcome = await orchestration.dispatchWithReceipt(command, {
          userId: owner.ownerUserId,
          ...(owner.ownerAttribution
            ? { ownerAttribution: owner.ownerAttribution }
            : {}),
          ...(fullAccessGrant ? { fullAccessGrant } : {}),
          ...(clientOrigin ? { clientOrigin } : {}),
        });
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
          code?: string;
          receipt?: { commandId?: string };
          receiptStatus?: 'persisted' | 'unavailable';
        };
        // #3386: a folder Station will not continue in is refused again on
        // every retry, so the launch says retrying is not safe to offer.
        const permanent = observed.code === 'continuation_place_refused';
        // #3429: the engine was not ready; nothing was created and the
        // reservation is gone, so the outcome is certain and a retry after
        // setting the engine up is safe.
        const notStarted = observed.code === 'continuation_engine_not_ready';
        return {
          // A folder refusal happens before anything is created or recorded,
          // so its outcome is certain: it failed.
          state:
            permanent || notStarted || observed.receiptStatus === 'persisted'
              ? ('failed' as const)
              : ('indeterminate' as const),
          reason:
            observed.message ??
            'The Session continuation outcome is unavailable.',
          retrySafe: !permanent,
          ...(observed.receipt?.commandId
            ? { receiptId: observed.receipt.commandId }
            : {}),
        };
      }
    },
  };
}
