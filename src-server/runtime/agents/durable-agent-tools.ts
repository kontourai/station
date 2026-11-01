import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type AgentToolIntent,
  type AgentTurnLease,
  agentWire,
  currentAgentTurn,
  runWithProviderParent,
} from '@kontourai/agent-runtime';
import { raceWithSignal } from '../../utils/bounded-async.js';
import type { IAgentHooks, ToolCallContext } from '../types.js';

const callingTool = new AsyncLocalStorage<AgentToolIntent>();
const replayDeclarations = new WeakMap<object, 'safe' | 'unsafe'>();
const invocationFinalizers = new WeakMap<AgentTurnLease, () => Promise<void>>();
const approvalObservers = new WeakMap<
  AgentTurnLease,
  (id: string) => void | Promise<void>
>();
export function bindDurableApprovalObserver(
  lease: AgentTurnLease,
  observe: (id: string) => void | Promise<void>,
) {
  approvalObservers.set(lease, observe);
}
export async function finishDurableAgentHooks(
  lease: AgentTurnLease,
): Promise<void> {
  const finish = invocationFinalizers.get(lease);
  if (finish) {
    await finish();
    invocationFinalizers.delete(lease);
  }
}
export function rememberDurableToolReplay(
  tool: object,
  replay: 'safe' | 'unsafe',
) {
  replayDeclarations.set(tool, replay);
}
export const durableToolReplay = (tool: object) =>
  replayDeclarations.get(tool) ?? 'unsafe';
export function durableAgentHooks(
  hooks: IAgentHooks | undefined,
): IAgentHooks | undefined {
  if (!hooks?.beforeToolCall) return hooks;
  const gate = hooks.beforeToolCall.bind(hooks);
  const afterInvocation = hooks.afterInvocation?.bind(hooks);
  return {
    ...hooks,
    ...(afterInvocation
      ? {
          afterInvocation: async (context) => {
            const lease = currentAgentTurn();
            if (lease)
              invocationFinalizers.set(lease, async () => {
                await afterInvocation(context);
              });
            else await afterInvocation(context);
          },
        }
      : {}),
    beforeToolCall: (tool, invocation) =>
      durableToolGate(tool, tool.replay ?? 'unsafe', () =>
        gate(tool, invocation),
      ),
  };
}
function durableToolIntent(
  tool: ToolCallContext,
  replay: 'safe' | 'unsafe',
): AgentToolIntent {
  return {
    id: `tool:${tool.toolCallId}`,
    input: { name: tool.toolName, args: tool.toolArgs },
    replay,
  };
}
async function durableToolGate(
  tool: ToolCallContext,
  replay: 'safe' | 'unsafe',
  gate: () => ReturnType<NonNullable<IAgentHooks['beforeToolCall']>>,
): ReturnType<NonNullable<IAgentHooks['beforeToolCall']>> {
  const lease = currentAgentTurn();
  if (!lease) return gate();
  if (!tool.toolCallId)
    throw new Error('A durable tool call requires a native call identity.');
  const intent = durableToolIntent(tool, replay);
  const planned = await lease.effect({
    type: 'effectPlan',
    intent: {
      id: intent.id,
      kind: 'tool',
      input: agentWire(intent.input),
      replay,
    },
  });
  if (
    planned.effect.state === 'completed' ||
    planned.effect.state === 'indeterminate'
  )
    return true;
  return callingTool.run(intent, gate);
}
export function executeDurableTool(
  input: {
    name: string;
    id: unknown;
    args: unknown;
    replay?: 'safe' | 'unsafe';
  },
  execute: () => Promise<unknown>,
): Promise<unknown> {
  const lease = currentAgentTurn();
  if (!lease) return execute();
  if (typeof input.id !== 'string' || !input.id)
    throw new Error('A durable tool call requires a native call identity.');
  return lease.tool(
    {
      id: `tool:${input.id}`,
      input: { name: input.name, args: input.args },
      replay: input.replay ?? 'unsafe',
    },
    () => runWithProviderParent(`tool:${input.id}`, execute),
  );
}

/** Reinstalls the same pending request and never substitutes a policy grant. */
export function waitDurableToolApproval(
  fallbackId: string,
  timeoutMs: number,
  wait: (id: string, remainingMs: number) => Promise<boolean>,
): Promise<boolean> {
  const lease = currentAgentTurn();
  const tool = callingTool.getStore();
  if (!lease || !tool) return wait(fallbackId, timeoutMs);
  return lease
    .approval(tool, timeoutMs, (pending) =>
      raceWithSignal(wait(pending.id, pending.remainingMs), lease.signal),
    )
    .then(async (approved) => {
      await approvalObservers.get(lease)?.(`approval:${tool.id}`);
      return approved;
    });
}
