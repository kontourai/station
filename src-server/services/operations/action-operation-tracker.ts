import { createHash } from 'node:crypto';
import type { ActionOperation } from '@kontourai/station-contracts/action-operation';
import type { Logger } from '../../utils/logger.js';
import type {
  ActionOperationActor,
  ActionOperationService,
  CreateActionOperation,
  UpdateActionOperation,
} from './action-operation-service.js';

export type ActionOperationTrackingService = Pick<
  ActionOperationService,
  'create' | 'update'
>;

export class ActionOperationTrackingHandle {
  constructor(
    private readonly service: ActionOperationTrackingService,
    private readonly actor: ActionOperationActor,
    private operation: ActionOperation,
    private readonly logger?: Pick<Logger, 'warn'>,
  ) {}

  /** Observation failure never changes the authoritative domain outcome. */
  async update(input: Omit<UpdateActionOperation, 'expectedRevision'>) {
    try {
      const result = await this.service.update(this.actor, this.operation.id, {
        ...input,
        expectedRevision: this.operation.revision,
      });
      if (
        result.kind === 'updated' ||
        result.kind === 'stale' ||
        result.kind === 'terminal'
      ) {
        this.operation = result.operation;
      }
    } catch (error) {
      this.logger?.warn('Action operation observation unavailable', {
        operationId: this.operation.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export async function beginActionOperationTracking(input: {
  service?: ActionOperationTrackingService;
  actor: ActionOperationActor;
  operation: CreateActionOperation;
  logger?: Pick<Logger, 'warn'>;
}): Promise<ActionOperationTrackingHandle | undefined> {
  if (!input.service) return undefined;
  try {
    const operation = await input.service.create(input.actor, input.operation);
    return operation
      ? new ActionOperationTrackingHandle(
          input.service,
          input.actor,
          operation,
          input.logger,
        )
      : undefined;
  } catch (error) {
    input.logger?.warn('Action operation admission unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/** Stable canonical coordinate for keyed and source-scoped adoption retries. */
export function handoffActionOperationId(input: {
  accountId: string;
  sourceSessionId: string;
  idempotencyKey?: string;
}): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        'adoptSession',
        input.accountId,
        input.sourceSessionId,
        input.idempotencyKey ?? 'source-scoped',
      ]),
    )
    .digest('hex');
  return `handoff:${digest}`;
}
