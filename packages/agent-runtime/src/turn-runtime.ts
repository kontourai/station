import type { OwnerIdentity, OwnerLiveness } from '@kontourai/monument';
import { canonical } from './encoding.js';
import type {
  AgentJournal,
  AgentTurnRecord,
  AgentTurnSpec,
} from './turn-journal.js';
import type { RunKey } from './types.js';

export interface AgentTurnLease {
  readonly key: RunKey;
  readonly input: string;
  assertCurrent(): Promise<void>;
  /** Exactly one foreground execution per committed ownership claim. */
  run(work: () => Promise<void>): Promise<void>;
  cancel(): void;
  readonly signal: AbortSignal;
}
export function createAgentRuntime(options: {
  readonly journal: AgentJournal;
  readonly owner: OwnerIdentity;
  readonly liveness: OwnerLiveness;
  readonly implementation: string;
}) {
  const context = { liveness: options.liveness };
  const leases = new Map<string, AgentTurnLease>();
  const mint = (record: AgentTurnRecord): AgentTurnLease => {
    const controller = new AbortController();
    let consumed = false;
    let turn = record;
    const lease: AgentTurnLease = {
      key: structuredClone(record.spec.key),
      input: record.spec.input,
      signal: controller.signal,
      async assertCurrent() {
        if (controller.signal.aborted)
          throw new Error('DURABLE_AGENT_CANCELLED');
        const current = await options.journal.execute(
          { type: 'read', key: turn.spec.key },
          context,
        );
        if (
          current.kind !== 'owned' ||
          current.turn.state !== 'running' ||
          canonical(current.turn.fence) !== canonical(turn.fence) ||
          options.liveness(turn.fence.owner) !== 'live'
        )
          throw new Error('DURABLE_AGENT_STALE_OWNER');
      },
      async run(work) {
        if (consumed) throw new Error('DURABLE_AGENT_DUPLICATE_CONSUMER');
        consumed = true;
        await lease.assertCurrent();
        let state: 'completed' | 'blocked' | 'cancelled' = 'completed';
        let failure: { error: unknown } | undefined;
        try {
          await work();
        } catch (error) {
          state = controller.signal.aborted ? 'cancelled' : 'blocked';
          failure = { error };
        }
        if (controller.signal.aborted) state = 'cancelled';
        const result = await options.journal.execute(
          { type: 'settle', key: turn.spec.key, expected: turn.fence, state },
          context,
        );
        if (result.kind !== 'owned')
          throw new Error('DURABLE_AGENT_SETTLEMENT_REFUSED', {
            cause: failure?.error,
          });
        turn = result.turn;
        leases.delete(canonical(turn.spec.key));
        if (failure) throw failure.error;
      },
      cancel() {
        controller.abort();
      },
    };
    leases.set(canonical(record.spec.key), lease);
    return lease;
  };
  return {
    async start(spec: AgentTurnSpec) {
      if (spec.implementation !== options.implementation)
        throw new Error('DURABLE_AGENT_IMPLEMENTATION_CHANGED');
      const answer = await options.journal.execute(
        { type: 'open', spec, owner: options.owner },
        context,
      );
      if (answer.kind !== 'owned')
        throw new Error(
          `DURABLE_AGENT_${answer.kind === 'refused' ? answer.reason.toUpperCase() : 'ABSENT'}`,
        );
      return mint(answer.turn);
    },
    async recover(
      key: RunKey,
      ready: () => boolean = () => true,
    ): Promise<AgentTurnLease | 'not-owned' | 'retry'> {
      const local = leases.get(canonical(key));
      if (local) {
        await local.assertCurrent();
        return local;
      }
      const read = await options.journal.execute(
        { type: 'read', key },
        context,
      );
      if (read.kind === 'absent') return 'not-owned';
      if (!ready()) return 'retry';
      if (
        read.kind !== 'owned' ||
        read.turn.state !== 'running' ||
        read.turn.spec.implementation !== options.implementation
      )
        return 'retry';
      const claimed = await options.journal.execute(
        { type: 'claim', key, expected: read.turn.fence, owner: options.owner },
        context,
      );
      return claimed.kind === 'owned' ? mint(claimed.turn) : 'retry';
    },
  };
}
