import { createHash } from 'node:crypto';
import type { DispatchReceipt } from '@kontourai/dispatch';
import type {
  AuthorizedFleetDispatchBegin,
  AuthorizedFleetDispatchSettlement,
  FleetDispatchCorrelationObserver,
} from '../../runtime/conversation/authorized-turn-correlation.js';
import type {
  ActionOperationActor,
  ActionOperationService,
} from './action-operation-service.js';

const FLEET_DISPATCH_TITLE = 'Route fleet dispatch';

function fleetDispatchOperationId(input: AuthorizedFleetDispatchBegin): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        'fleet-dispatch/v1',
        input.accountId,
        input.sessionId,
        input.correlationId,
      ]),
    )
    .digest('hex');
  return `fleet-dispatch:${digest}`;
}

function actorFor(input: AuthorizedFleetDispatchBegin): ActionOperationActor {
  return {
    accountId: input.accountId,
    // This observer is reached only through the server-owned authorized-turn
    // ALS context. It may assert exactly this session, never a broad session
    // permission or caller-supplied target.
    canReadSession: (sessionId) => sessionId === input.sessionId,
  };
}

function createInput(input: AuthorizedFleetDispatchBegin) {
  return {
    id: fleetDispatchOperationId(input),
    scope: { accountId: input.accountId, sessionId: input.sessionId },
    title: FLEET_DISPATCH_TITLE,
    progress: { kind: 'phase' as const, code: 'preparing' as const },
    cancellation: 'unsupported' as const,
    domain: {
      kind: 'fleet-dispatch' as const,
      sessionId: input.sessionId,
      correlationId: input.correlationId,
    },
    reentry: { kind: 'session' as const, sessionId: input.sessionId },
  };
}

function terminalOutcome(outcome: DispatchReceipt['outcome']): {
  status: 'succeeded' | 'failed' | 'cancelled';
  errorSummary?: string;
} {
  if (outcome === 'succeeded') return { status: 'succeeded' };
  if (outcome === 'aborted') return { status: 'cancelled' };
  if (outcome === 'budget-exceeded') {
    return {
      status: 'failed',
      errorSummary: 'Fleet routing budget was exceeded.',
    };
  }
  if (outcome === 'no-eligible-candidates') {
    return {
      status: 'failed',
      errorSummary: 'No fleet candidate was eligible.',
    };
  }
  return {
    status: 'failed',
    errorSummary: 'Fleet routing attempts did not produce a completion.',
  };
}

/**
 * Bridges an exact authorized Dispatch invocation into the generic durable
 * Action envelope. It never owns routing, receipt writing, or turn outcome:
 * callers intentionally run it through Dispatch's bounded, best-effort
 * observer slot.
 */
export class FleetDispatchActionOperationObserver
  implements FleetDispatchCorrelationObserver
{
  constructor(private readonly operations: ActionOperationService) {}

  async begin(input: AuthorizedFleetDispatchBegin): Promise<void> {
    await this.operations.create(actorFor(input), createInput(input));
  }

  async settle(input: AuthorizedFleetDispatchSettlement): Promise<void> {
    const actor = actorFor(input);
    let operation = await this.operations.create(actor, createInput(input));
    if (
      !operation ||
      (operation.status !== 'accepted' && operation.status !== 'running')
    ) {
      return;
    }
    const terminal = terminalOutcome(input.outcome);
    // A competing begin/settle/redelivery can advance the row between the
    // create read and update. One exact retry handles that known race; any
    // later storage failure is observer-local and cannot alter Dispatch.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await this.operations.update(actor, operation.id, {
        expectedRevision: operation.revision,
        status: terminal.status,
        domain: {
          kind: 'fleet-dispatch',
          sessionId: input.sessionId,
          correlationId: input.correlationId,
          routingReceiptId: input.receiptId,
        },
        ...(terminal.errorSummary
          ? { errorSummary: terminal.errorSummary }
          : {}),
      });
      if (result.kind === 'updated' || result.kind === 'terminal') return;
      if (result.kind !== 'stale') return;
      operation = result.operation;
      if (operation.status !== 'accepted' && operation.status !== 'running')
        return;
    }
  }
}
