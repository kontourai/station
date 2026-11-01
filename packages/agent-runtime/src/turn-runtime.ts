import { AsyncLocalStorage } from 'node:async_hooks';
import type { OwnerIdentity, OwnerLiveness } from '@kontourai/monument';
import { canonical } from './encoding.js';
import type { ApprovalCommand, ApprovalResult } from './turn-approvals.js';
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
type ApprovalOperation<C = ApprovalCommand> = C extends ApprovalCommand
  ? Omit<C, 'key' | 'expected'>
  : never;
export interface AgentToolIntent {
  readonly id: string;
  readonly input: unknown;
  readonly replay: 'safe' | 'unsafe';
}
export interface AgentTurnLease {
  readonly key: RunKey;
  readonly input: string;
  readonly providerSessionId: string;
  assertCurrent(): Promise<void>;
  /** Exactly one foreground execution per committed ownership claim. */
  run(work: () => Promise<void>): Promise<void>;
  cancel(): void;
  readonly signal: AbortSignal;
  effect(command: EffectOperation): Promise<EffectResult>;
  approvalCommand(command: ApprovalOperation): Promise<ApprovalResult>;
  approval(
    tool: AgentToolIntent,
    timeoutMs: number,
    wait: (pending: {
      id: string;
      deadline: number;
      remainingMs: number;
    }) => Promise<boolean>,
  ): Promise<boolean>;
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
  readonly now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const context = { liveness: options.liveness, now };
  const leases = new Map<string, AgentTurnLease>();
  const mint = (
    record: AgentTurnRecord,
    providerSessionId: string,
  ): AgentTurnLease => {
    const controller = new AbortController();
    let consumed = false;
    let turn = record;
    const toolCalls = new Map<
      string,
      { input: string; result: Promise<unknown> }
    >();
    const approvalWaits = new Map<
      string,
      { input: string; result: Promise<boolean> }
    >();
    const lease: AgentTurnLease = {
      key: structuredClone(record.spec.key),
      input: record.spec.input,
      providerSessionId,
      signal: controller.signal,
      async approvalCommand(command) {
        const result = await options.journal.execute(
          { ...command, key: turn.spec.key, expected: turn.fence },
          context,
        );
        if (result.kind !== 'approval')
          throw new Error(
            `DURABLE_AGENT_APPROVAL_${result.kind === 'refused' ? result.reason.toUpperCase() : 'UNAVAILABLE'}`,
          );
        return result;
      },
      async approval(tool, timeoutMs, wait) {
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
          throw new Error('DURABLE_AGENT_APPROVAL_TIMEOUT_INVALID');
        const input = agentWire(tool.input);
        const identity = agentWire({ input: tool.input, replay: tool.replay });
        const prior = approvalWaits.get(tool.id);
        if (prior) {
          if (prior.input !== identity)
            throw new Error('DURABLE_AGENT_APPROVAL_CHANGED');
          return prior.result;
        }
        const pending = (async () => {
          await lease.effect({
            type: 'effectPlan',
            intent: { id: tool.id, kind: 'tool', replay: tool.replay, input },
          });
          const { approval } = await lease.approvalCommand({
            type: 'approvalPlan',
            id: `approval:${tool.id}`,
            toolId: tool.id,
            input,
            deadline: now() + timeoutMs,
          });
          if (approval.state !== 'pending')
            return approval.state === 'approved' && now() < approval.deadline;
          await lease.assertCurrent();
          const decision =
            now() >= approval.deadline
              ? 'expired'
              : (await wait({
                    id: approval.id,
                    deadline: approval.deadline,
                    remainingMs: approval.deadline - now(),
                  })) === true && !lease.signal.aborted
                ? 'approved'
                : 'denied';
          const resolved = await lease.approvalCommand({
            type: 'approvalResolve',
            id: approval.id,
            expectedRevision: approval.revision,
            decision,
          });
          return resolved.approval.state === 'approved';
        })();
        approvalWaits.set(tool.id, { input: identity, result: pending });
        void pending.catch(() => {
          if (approvalWaits.get(tool.id)?.result === pending)
            approvalWaits.delete(tool.id);
        });
        return pending;
      },
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
        void result.catch(() => {
          if (toolCalls.get(intent.id)?.result === result)
            toolCalls.delete(intent.id);
        });
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
          current.providerSessionId !== providerSessionId ||
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
      return mint(answer.turn, answer.providerSessionId);
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
      return claimed.kind === 'owned'
        ? mint(claimed.turn, claimed.providerSessionId)
        : 'retry';
    },
  };
}
