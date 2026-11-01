import { AsyncLocalStorage } from 'node:async_hooks';
import type { OwnerIdentity, OwnerLiveness } from '@kontourai/monument';
import { canonical } from './encoding.js';
import type {
  EffectCommand,
  EffectIntent,
  EffectResult,
} from './turn-effects.js';
import type {
  AgentJournal,
  AgentTurnRecord,
  AgentTurnSpec,
} from './turn-journal.js';
import { agentWire, readAgentWire } from './turn-wire.js';
import type { RunKey } from './types.js';

type EffectOperation<C = EffectCommand> = C extends EffectCommand
  ? Omit<C, 'key' | 'expected'>
  : never;
export interface AgentTurnLease {
  readonly key: RunKey;
  readonly input: string;
  assertCurrent(): Promise<void>;
  /** Exactly one foreground execution per committed ownership claim. */
  run(work: () => Promise<void>): Promise<void>;
  cancel(): void;
  readonly signal: AbortSignal;
  effect(command: EffectOperation): Promise<EffectResult>;
  tool(
    intent: {
      readonly id: string;
      readonly input: unknown;
      readonly replay: 'safe' | 'unsafe';
    },
    execute: () => Promise<unknown>,
  ): Promise<unknown>;
}
export interface InterruptedToolResult {
  readonly status: 'interrupted';
  readonly outcome: 'indeterminate';
  readonly message: string;
}
const interruptedTool = (): InterruptedToolResult => ({
  status: 'interrupted',
  outcome: 'indeterminate',
  message:
    'This tool may have run before Station stopped. Its outcome is unknown; it was not run again.',
});
const activeTurn = new AsyncLocalStorage<AgentTurnLease>();
export const currentAgentTurn = () => activeTurn.getStore();
export function runWithAgentTurn<T>(lease: AgentTurnLease, work: () => T): T {
  return activeTurn.run(lease, work);
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
    const toolCalls = new Map<
      string,
      { input: string; result: Promise<unknown> }
    >();
    const lease: AgentTurnLease = {
      key: structuredClone(record.spec.key),
      input: record.spec.input,
      signal: controller.signal,
      async effect(command) {
        const result = await options.journal.execute(
          { ...command, key: turn.spec.key, expected: turn.fence },
          context,
        );
        if (result.kind !== 'effect')
          throw new Error(
            `DURABLE_AGENT_EFFECT_${result.kind === 'refused' ? result.reason.toUpperCase() : 'UNAVAILABLE'}`,
          );
        return result;
      },
      async tool(intent, execute) {
        const input = agentWire(intent.input);
        const existing = toolCalls.get(intent.id);
        if (existing) {
          if (existing.input !== input)
            throw new Error('DURABLE_AGENT_TOOL_CHANGED');
          return existing.result;
        }
        const result = (async () => {
          const planned: EffectIntent = {
            id: intent.id,
            kind: 'tool',
            input,
            replay: intent.replay,
          };
          const { effect } = await lease.effect({
            type: 'effectPlan',
            intent: planned,
          });
          if (effect.state === 'completed')
            return readAgentWire(effect.attempts.at(-1)!.output!);
          if (effect.state === 'indeterminate') return interruptedTool();
          const begun = await lease.effect({
            type: 'effectBegin',
            id: intent.id,
          });
          if (!begun.execute) return interruptedTool();
          await lease.assertCurrent();
          const output = await execute();
          await lease.effect({
            type: 'effectComplete',
            id: intent.id,
            output: agentWire(output),
          });
          return output;
        })();
        toolCalls.set(intent.id, { input, result });
        return result;
      },
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
          await runWithAgentTurn(lease, work);
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
