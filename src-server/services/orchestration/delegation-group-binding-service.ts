import {
  assertBoundedApiExecutionAvailable,
  runWithRequiredBoundedApiTurn,
} from '../../runtime/conversation/bounded-api-turn-grant.js';
import {
  type DelegationGroupBinding,
  DelegationGroupBindingError,
  type DelegationGroupBindingFinalizer,
  type DelegationGroupBindingRecord,
  delegationGroupBindingKey,
  FileDelegationGroupBindingStore,
} from './delegation-group-binding-store.js';

export interface DelegationGroupBindingHost {
  /** Authenticate the actual request and current session/turn/envelope custody. */
  assertCurrent(
    record: DelegationGroupBindingRecord,
  ): Promise<DelegationGroupBindingFinalizer>;
}

/** Restriction caller for durable group work; it cannot issue execution authority. */
export class DelegationGroupBindingService {
  constructor(
    private readonly store: FileDelegationGroupBindingStore,
    private readonly host: DelegationGroupBindingHost,
  ) {}

  async execute<T>(
    input: {
      binding: DelegationGroupBinding;
      ownerToken: string;
      expectedRevision: number;
    },
    resolveAndExecute: (record: DelegationGroupBindingRecord) => Promise<T>,
  ): Promise<T> {
    const captured = structuredClone(input);
    const current = await this.store.read(
      captured.binding.scope,
      delegationGroupBindingKey(captured.binding),
    );
    if (!current) throw new DelegationGroupBindingError('binding_unavailable');
    const finalizeCurrent = await this.host.assertCurrent(current);
    const intent = await this.store.advance(
      {
        ...captured,
        transition: { state: 'launch-intent' },
      },
      finalizeCurrent,
    );
    return runWithRequiredBoundedApiTurn(async () => {
      const finalizeExecution = await this.host.assertCurrent(
        structuredClone(intent),
      );
      const result: unknown = finalizeExecution();
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => {});
        throw new DelegationGroupBindingError('synchronous_authority_required');
      }
      // Refuse before resolution until the physical owner can enforce paid work.
      assertBoundedApiExecutionAvailable('delegation-group-binding');
      return resolveAndExecute(intent);
    });
  }

  async consumeStream<T>(
    input: Parameters<DelegationGroupBindingService['execute']>[0],
    resolveStream: (
      record: DelegationGroupBindingRecord,
    ) => Promise<AsyncIterable<T>>,
    consume: (value: T) => Promise<void>,
  ): Promise<void> {
    await this.execute(input, async (record) => {
      const stream = await resolveStream(record);
      for await (const value of stream) await consume(value);
    });
  }
}
