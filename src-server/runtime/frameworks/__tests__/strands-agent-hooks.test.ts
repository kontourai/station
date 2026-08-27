import {
  AfterInvocationEvent,
  AfterToolCallEvent,
  BeforeToolCallEvent,
} from '@strands-agents/sdk';
import { describe, expect, test, vi } from 'vitest';
import { createStagedPreToolPolicyEvaluator } from '../../agents/pre-tool-policy.js';
import type { ToolCallDenial } from '../../types.js';
import {
  bindStrandsInvocationContext,
  wireStrandsAgentHooks,
  wireStrandsToolGate,
} from '../strands-agent-hooks.js';
import { mapStrandsStreamEvent } from '../strands-stream-events.js';
import { createStrandsFunctionTools } from '../strands-tool-loader.js';

function createHooksRegistry() {
  const callbacks = new Map<any, any>();
  return {
    callbacks,
    addHook: vi.fn((eventType: any, callback: any) => {
      callbacks.set(eventType, callback);
    }),
  };
}

describe('wireStrandsAgentHooks', () => {
  test('marks denied tool calls and forwards after-tool hooks', async () => {
    const registry = createHooksRegistry();
    const deniedToolCalls = new Map<string, ToolCallDenial>();
    const afterToolCall = vi.fn();

    wireStrandsAgentHooks({
      strandsAgent: { addHook: registry.addHook } as any,
      hooks: {
        beforeToolCall: vi.fn().mockResolvedValue(false),
        afterToolCall,
      },
      deniedToolCalls,
      invocationCtx: {
        agentSlug: 'agent-a',
        conversationId: 'conv-1',
        userId: 'user-1',
      },
      memoryAdapter: {
        getMessages: vi.fn().mockResolvedValue([]),
        addMessage: vi.fn(),
      } as any,
      logger: { info: vi.fn(), error: vi.fn() },
      resolvedModel: 'anthropic.test',
      getLastStreamUsage: () => null,
    });

    await registry.callbacks.get(BeforeToolCallEvent)({
      toolUse: { name: 'read_file', toolUseId: 'tool-1', input: { path: 'a' } },
    });
    registry.callbacks.get(AfterToolCallEvent)({
      toolUse: { name: 'read_file', toolUseId: 'tool-1', input: { path: 'a' } },
      result: { content: { ok: true } },
    });

    expect(deniedToolCalls.has('tool-1')).toBe(true);
    expect(afterToolCall).toHaveBeenCalledWith(
      {
        toolName: 'read_file',
        toolCallId: 'tool-1',
        toolArgs: { path: 'a' },
      },
      {
        output: { ok: true },
        error: undefined,
      },
      {
        agentSlug: 'agent-a',
        conversationId: 'conv-1',
        userId: 'user-1',
      },
    );
  });

  test('marks a ToolCallDenial result as denied — the object is truthy (station#1834)', async () => {
    const registry = createHooksRegistry();
    const deniedToolCalls = new Map<string, ToolCallDenial>();

    wireStrandsAgentHooks({
      strandsAgent: { addHook: registry.addHook } as any,
      hooks: {
        beforeToolCall: vi.fn().mockResolvedValue({
          allowed: false,
          reason: 'No approval channel for this unattended run.',
        }),
      },
      deniedToolCalls,
      invocationCtx: { agentSlug: 'agent-a', conversationId: 'conv-1' },
      memoryAdapter: {
        getMessages: vi.fn().mockResolvedValue([]),
        addMessage: vi.fn(),
      } as any,
      logger: { info: vi.fn(), error: vi.fn() },
      resolvedModel: 'anthropic.test',
      getLastStreamUsage: () => null,
    });

    await registry.callbacks.get(BeforeToolCallEvent)({
      toolUse: { name: 'write_file', toolUseId: 'tool-2', input: {} },
    });

    // station#3091: the map now carries the full structured denial (not
    // just its reason string) so a `policyDenied` marker can ride along.
    // This particular denial is a mocked hand-set object with no marker —
    // pinned absent here for contrast with the REAL-policy test below.
    expect(deniedToolCalls.get('tool-2')).toEqual({
      allowed: false,
      reason: 'No approval channel for this unattended run.',
    });
  });

  test('a REAL pre-tool-policy denial carries `policyDenied: true` through wireStrandsToolGate (station#3091)', async () => {
    const registry = createHooksRegistry();
    const deniedToolCalls = new Map<string, ToolCallDenial>();
    // The REAL staged evaluator — not a hand-set `{allowed:false, reason}` —
    // so this test proves the marker set by pre-tool-policy.ts's deny()
    // actually reaches the map wireStrandsToolGate populates.
    const evaluatePolicy = createStagedPreToolPolicyEvaluator({
      spec: { name: 'agent-a' } as any,
      toolNameMapping: new Map(),
      isGranted: () => false,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    wireStrandsToolGate({
      strandsAgent: { addHook: registry.addHook } as any,
      hooks: {
        beforeToolCall: (tool, invocation) =>
          evaluatePolicy(tool, invocation, { interaction: 'managed' }).then(
            (decision) =>
              decision.behavior === 'deny' ? decision.denial : true,
          ),
      },
      deniedToolCalls,
      invocationCtx: { agentSlug: 'agent-a' },
    });

    await registry.callbacks.get(BeforeToolCallEvent)({
      toolUse: { name: 'write_file', toolUseId: 'tool-real', input: {} },
    });

    expect(deniedToolCalls.get('tool-real')).toMatchObject({
      allowed: false,
      policyDenied: true,
    });
  });

  test('a gate denial surfaces through the REAL FunctionTool as a status:error result carrying the reason (station#1834)', async () => {
    const registry = createHooksRegistry();
    const deniedToolCalls = new Map<string, ToolCallDenial>();
    const execute = vi.fn();
    const reason =
      "Tool 'write_file' requires approval, but this run has no approval channel to ask (unattended runs — scheduled jobs, /invoke, CLI — have no one to consent). Add the tool to the agent's tools.autoApprove list to grant it for unattended runs.";

    wireStrandsToolGate({
      strandsAgent: { addHook: registry.addHook } as any,
      hooks: {
        beforeToolCall: vi.fn().mockResolvedValue({ allowed: false, reason }),
      },
      deniedToolCalls,
      invocationCtx: { agentSlug: 'default' },
    });
    const [tool] = createStrandsFunctionTools(
      [
        { name: 'write_file', description: 'Write', parameters: {}, execute },
      ] as any,
      deniedToolCalls,
    );

    // The gate records the denial for this toolUseId...
    await registry.callbacks.get(BeforeToolCallEvent)({
      toolUse: { name: 'write_file', toolUseId: 'tool-9', input: {} },
    });
    // ...and the REAL SDK FunctionTool.stream() surfaces it as an error
    // ToolResultBlock (not the old fabricated success string).
    const generator = (tool as any).stream({
      toolUse: { toolUseId: 'tool-9', name: 'write_file', input: {} },
    });
    let iter = await generator.next();
    while (!iter.done) {
      iter = await generator.next();
    }
    const resultBlock = iter.value as {
      status?: string;
      error?: Error;
      content?: Array<{ text?: string }>;
    };

    expect(resultBlock.status).toBe('error');
    expect(resultBlock.error?.message).toBe(reason);
    expect(
      resultBlock.content?.map((block) => block.text).join('\n'),
    ).toContain('no approval channel');
    expect(execute).not.toHaveBeenCalled();
  });

  // station#3091: the FULL carrying seam for one real denial — a REAL
  // pre-tool-policy deny() → the REAL Strands SDK's error-wrapping
  // (wireStrandsToolGate + the real FunctionTool) → mapStrandsStreamEvent,
  // the exact function that produces what goes out over SSE. Nothing here
  // is a hand-set prop; every layer is the real production code.
  test('a REAL policy denial reaches the runtime tool-result chunk with `policyDenied: true` and the reason (station#3091)', async () => {
    const registry = createHooksRegistry();
    const deniedToolCalls = new Map<string, ToolCallDenial>();
    const execute = vi.fn();
    const evaluatePolicy = createStagedPreToolPolicyEvaluator({
      spec: { name: 'agent-a' } as any,
      toolNameMapping: new Map(),
      isGranted: () => false,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    wireStrandsToolGate({
      strandsAgent: { addHook: registry.addHook } as any,
      hooks: {
        beforeToolCall: (tool, invocation) =>
          evaluatePolicy(tool, invocation, { interaction: 'managed' }).then(
            (decision) =>
              decision.behavior === 'deny' ? decision.denial : true,
          ),
      },
      deniedToolCalls,
      invocationCtx: { agentSlug: 'agent-a' },
    });
    const [tool] = createStrandsFunctionTools(
      [
        { name: 'write_file', description: 'Write', parameters: {}, execute },
      ] as any,
      deniedToolCalls,
    );

    await registry.callbacks.get(BeforeToolCallEvent)({
      toolUse: { name: 'write_file', toolUseId: 'tool-real-2', input: {} },
    });
    const generator = (tool as any).stream({
      toolUse: { toolUseId: 'tool-real-2', name: 'write_file', input: {} },
    });
    let iter = await generator.next();
    while (!iter.done) {
      iter = await generator.next();
    }
    const resultBlock = iter.value as {
      toolUseId: string;
      status: string;
      error?: Error;
      content: unknown;
    };

    // Feed the REAL ToolResultBlock's own fields into the exact function
    // that produces what goes out over SSE — `result` here is the SDK's
    // `toolResultEvent.result` shape, not a hand-built stand-in.
    const chunk = mapStrandsStreamEvent({
      type: 'toolResultEvent',
      result: {
        toolUseId: resultBlock.toolUseId,
        status: resultBlock.status,
        error: resultBlock.error,
        content: resultBlock.content,
      },
    } as never);

    expect(chunk).toMatchObject({
      type: 'tool-result',
      toolCallId: 'tool-real-2',
      policyDenied: true,
      error: expect.stringContaining('no approval channel'),
    });
  });

  // station#3113: the twin of the test above for an ORDINARY (non-policy)
  // failure — a real tool `execute` throws, the REAL Strands SDK wraps it as
  // a status:'error' ToolResultBlock (no gate involved, no `deniedToolCalls`
  // entry), and `mapStrandsStreamEvent` — the exact function that produces
  // what goes out over SSE — must render it as truthfully failed WITHOUT
  // `policyDenied` and WITHOUT leaking the thrown error's own (here,
  // remote-shaped) message.
  test('a REAL ordinary tool failure reaches the runtime tool-result chunk as failed, not policy-denied, with a redacted message (station#3113)', async () => {
    const canary = 'remote-shaped-tool-failure-canary';
    const deniedToolCalls = new Map<string, ToolCallDenial>();
    const [tool] = createStrandsFunctionTools(
      [
        {
          name: 'flaky_tool',
          description: 'Always fails',
          parameters: {},
          execute: async () => {
            throw new Error(canary);
          },
        },
      ] as any,
      deniedToolCalls,
    );

    const generator = (tool as any).stream({
      toolUse: { toolUseId: 'tool-ordinary-1', name: 'flaky_tool', input: {} },
    });
    let iter = await generator.next();
    while (!iter.done) {
      iter = await generator.next();
    }
    const resultBlock = iter.value as {
      toolUseId: string;
      status: string;
      error?: Error;
      content: unknown;
    };

    // Tripwire on the REAL SDK's own error-wrapping shape (mirrors the
    // policy-denial test above): if this ever stops matching, the fix's
    // assumption about how Strands surfaces a thrown tool error is stale.
    expect(resultBlock.status).toBe('error');
    expect(resultBlock.error?.message).toBe(canary);

    const chunk = mapStrandsStreamEvent({
      type: 'toolResultEvent',
      result: {
        toolUseId: resultBlock.toolUseId,
        status: resultBlock.status,
        error: resultBlock.error,
        content: resultBlock.content,
      },
    } as never);

    expect(chunk).toMatchObject({
      type: 'tool-result',
      toolCallId: 'tool-ordinary-1',
      error: 'Tool call failed.',
    });
    expect((chunk as { policyDenied?: unknown }).policyDenied).toBeUndefined();
    expect(JSON.stringify(chunk)).not.toContain(canary);
  });

  // station#1834 round 4 (delta-3 HIGH): a tool-planted look-alike context in
  // the tool-writable invocationState bag must not redirect memory sync or
  // afterInvocation to another conversation/user.
  test('memory sync and afterInvocation ignore a spoofed in-bag context and use the bound one', async () => {
    const registry = createHooksRegistry();
    const memoryAdapter = {
      getMessages: vi.fn().mockResolvedValue([]),
      addMessage: vi.fn().mockResolvedValue(undefined),
    };
    const afterInvocation = vi.fn().mockResolvedValue(undefined);

    wireStrandsAgentHooks({
      strandsAgent: { addHook: registry.addHook } as any,
      hooks: { afterInvocation },
      deniedToolCalls: new Map<string, ToolCallDenial>(),
      invocationCtx: { agentSlug: 'agent-a' },
      memoryAdapter: memoryAdapter as any,
      logger: { info: vi.fn(), error: vi.fn() },
      resolvedModel: 'anthropic.test',
      getLastStreamUsage: () => ({ promptTokens: 3, completionTokens: 2 }),
    });

    // The wrapper binds the trusted context by state-object identity...
    const invocationState: Record<string, unknown> = {};
    bindStrandsInvocationContext(invocationState, {
      agentSlug: 'agent-a',
      conversationId: 'conv-1',
      userId: 'user-1',
    });
    // ...and a hostile tool plants a look-alike key INTO the bag, trying to
    // redirect the sync target to another conversation/user.
    invocationState.stationInvocationContext = {
      agentSlug: 'agent-a',
      conversationId: 'conv-2',
      userId: 'attacker',
    };

    await registry.callbacks.get(AfterInvocationEvent)({
      agent: {
        messages: [{ role: 'assistant', content: [{ text: 'hello' }] }],
      },
      invocationState,
    });

    expect(memoryAdapter.getMessages).toHaveBeenCalledWith('user-1', 'conv-1');
    expect(afterInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        invocation: expect.objectContaining({
          conversationId: 'conv-1',
          userId: 'user-1',
        }),
      }),
    );
  });

  test('syncs messages and forwards usage on invocation completion', async () => {
    const registry = createHooksRegistry();
    const memoryAdapter = {
      getMessages: vi.fn().mockResolvedValue([]),
      addMessage: vi.fn().mockResolvedValue(undefined),
    };
    const afterInvocation = vi.fn().mockResolvedValue(undefined);

    wireStrandsAgentHooks({
      strandsAgent: { addHook: registry.addHook } as any,
      hooks: { afterInvocation },
      deniedToolCalls: new Map<string, ToolCallDenial>(),
      invocationCtx: {
        agentSlug: 'agent-a',
        conversationId: 'conv-1',
        userId: 'user-1',
      },
      memoryAdapter: memoryAdapter as any,
      logger: { info: vi.fn(), error: vi.fn() },
      resolvedModel: 'anthropic.test',
      getLastStreamUsage: () => ({ promptTokens: 3, completionTokens: 2 }),
    });

    await registry.callbacks.get(AfterInvocationEvent)({
      agent: {
        messages: [{ role: 'assistant', content: [{ text: 'hello' }] }],
      },
    });

    expect(memoryAdapter.getMessages).toHaveBeenCalledWith('user-1', 'conv-1');
    expect(memoryAdapter.addMessage).toHaveBeenCalledTimes(1);
    expect(afterInvocation).toHaveBeenCalledWith({
      invocation: {
        agentSlug: 'agent-a',
        conversationId: 'conv-1',
        userId: 'user-1',
      },
      usage: {
        promptTokens: 3,
        completionTokens: 2,
      },
      toolCallCount: 0,
    });
  });
});
