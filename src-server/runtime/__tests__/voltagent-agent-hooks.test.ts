import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeUnattendedGrantResolver } from '../../services/agents/unattended-grant-resolver.js';
import {
  principalKey,
  UnattendedGrantStore,
} from '../../services/agents/unattended-grant-store.js';
import { createMCPToolProvenanceGeneration } from '../../services/orchestration/mcp-tool-provenance.js';
import { BuiltinScheduler } from '../../services/scheduling/builtin-scheduler.js';
import { createSchedulerLedger } from '../../services/scheduling/scheduler-ledger.js';
import { createStagedPreToolPolicyEvaluator } from '../agents/pre-tool-policy.js';
import { runWithScheduledPrincipal } from '../agents/scheduled-principal-context.js';
import {
  createVoltAgentLifecycleHooks,
  normalizeVoltAgentToolErrors,
  toVoltAgentTool,
} from '../frameworks/voltagent-adapter.js';
import { createScheduledTurnAdapter } from '../routes/runtime-route-support.js';
import { normalizeLoadedMCPTools } from '../tools/mcp-tool-names.js';

const grantHome = join(tmpdir(), `scheduler-hook-grants-${process.pid}`);

afterEach(() => rmSync(grantHome, { recursive: true, force: true }));

function operationContext(conversationId = 'conversation-1') {
  return {
    conversationId,
    userId: 'user-1',
    traceId: 'trace-1',
    context: new Map<string, unknown>(),
  } as any;
}

function toolOptions(callId: string) {
  return {
    toolContext: { callId, name: 'lookup', messages: [] },
    delegation: { depth: 1 },
  } as any;
}

describe('VoltAgent lifecycle hooks', () => {
  it('surfaces the real denial reason in the ToolDeniedError, not the delegated-child wording (station#1834)', async () => {
    const reason =
      "Tool 'lookup' requires approval, but this run has no approval channel to ask (unattended runs — scheduled jobs, /invoke, CLI — have no one to consent). Add the tool to the agent's tools.autoApprove list to grant it for unattended runs.";
    const hooks = createVoltAgentLifecycleHooks('assistant', {
      beforeToolCall: vi.fn().mockResolvedValue({ allowed: false, reason }),
    });

    await expect(
      hooks.onToolStart!({
        agent: {} as any,
        tool: { name: 'lookup' } as any,
        context: operationContext(),
        args: {},
        options: toolOptions('call-denied'),
      }),
    ).rejects.toMatchObject({
      message: reason,
      code: 'TOOL_FORBIDDEN',
      httpStatus: 403,
    });
  });

  it('does not mark `policyDenied` when the hook returns a plain denial with no marker (station#3091)', async () => {
    const reason = 'the user declined the approval request.';
    const hooks = createVoltAgentLifecycleHooks('assistant', {
      beforeToolCall: vi.fn().mockResolvedValue({ allowed: false, reason }),
    });

    await expect(
      hooks.onToolStart!({
        agent: {} as any,
        tool: { name: 'lookup' } as any,
        context: operationContext(),
        args: {},
        options: toolOptions('call-user-denied'),
      }),
    ).rejects.not.toMatchObject({ policyDenied: true });
  });

  it('a REAL pre-tool-policy denial throws a ToolDeniedError carrying `policyDenied: true` (station#3091)', async () => {
    // The REAL staged evaluator, not a hand-set `{allowed:false, reason}` —
    // proves the marker pre-tool-policy.ts's deny() sets actually survives
    // onto the error this file throws.
    const evaluatePolicy = createStagedPreToolPolicyEvaluator({
      spec: { name: 'assistant' } as any,
      toolNameMapping: new Map(),
      isGranted: () => false,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    const hooks = createVoltAgentLifecycleHooks('assistant', {
      beforeToolCall: (tool, invocation) =>
        evaluatePolicy(tool, invocation, { interaction: 'managed' }).then(
          (decision) => (decision.behavior === 'deny' ? decision.denial : true),
        ),
    });

    let caught: unknown;
    try {
      await hooks.onToolStart!({
        agent: {} as any,
        tool: { name: 'lookup' } as any,
        context: operationContext(),
        args: {},
        options: toolOptions('call-real-policy-denied'),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: 'TOOL_FORBIDDEN',
      policyDenied: true,
    });
    expect((caught as Error).message).toContain('no approval channel');

    // archive#3091: reproduce the installed @voltagent/core's OWN
    // documented copy behavior (`buildToolErrorResult`, verified by reading
    // the installed package's compiled source — it is not exported so it
    // cannot be called directly): every own-enumerable property of the
    // thrown error, `policyDenied` included, is copied onto the tool's
    // resolved output. Then feed that EXACT shape through the real
    // normalization function this fix adds, proving the full chain from a
    // real ToolCallDenial to the runtime tool-result chunk.
    const err = caught as Error & { policyDenied?: true };
    const errorResult: Record<string, unknown> = {
      error: true,
      name: err.name,
      message: err.message,
      toolCallId: 'call-real-policy-denied',
      toolName: 'lookup',
    };
    for (const key of Object.getOwnPropertyNames(err)) {
      if (['name', 'message', 'stack', 'cause', 'error'].includes(key)) {
        continue;
      }
      errorResult[key] = (err as unknown as Record<string, unknown>)[key];
    }
    expect(errorResult.policyDenied).toBe(true);

    async function* rawStream() {
      yield {
        type: 'tool-result',
        toolCallId: 'call-real-policy-denied',
        toolName: 'lookup',
        output: errorResult,
      };
    }
    const normalized: unknown[] = [];
    for await (const chunk of normalizeVoltAgentToolErrors(rawStream())) {
      normalized.push(chunk);
    }

    expect(normalized).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'call-real-policy-denied',
        toolName: 'lookup',
        output: errorResult,
        error: err.message,
        policyDenied: true,
      },
    ]);
  });

  it('denies when an INVOKED hook resolves undefined — only literal true allows (station#1834)', async () => {
    const hooks = createVoltAgentLifecycleHooks('assistant', {
      beforeToolCall: vi.fn().mockResolvedValue(undefined as any),
    });

    await expect(
      hooks.onToolStart!({
        agent: {} as any,
        tool: { name: 'lookup' } as any,
        context: operationContext(),
        args: {},
        options: toolOptions('call-undefined'),
      }),
    ).rejects.toMatchObject({
      message: "Tool 'lookup' was denied by Station's tool gate.",
      code: 'TOOL_FORBIDDEN',
    });
  });

  it('keeps the legacy allow path when NO beforeToolCall hook is wired', async () => {
    const afterToolCall = vi.fn();
    const hooks = createVoltAgentLifecycleHooks('assistant', { afterToolCall });

    await expect(
      hooks.onToolStart!({
        agent: {} as any,
        tool: { name: 'lookup' } as any,
        context: operationContext(),
        args: {},
        options: toolOptions('call-no-hook'),
      }),
    ).resolves.toBeUndefined();
  });

  it('passes only loader-issued MCP identity and separately retained arguments/result to the hook', async () => {
    const generation = createMCPToolProvenanceGeneration();
    const [loaded] = normalizeLoadedMCPTools(
      'assistant',
      [{ name: 'github_create_issue', execute: vi.fn() }] as any,
      new Map(),
      new Map(),
      generation,
      'github-integration',
      () => ({ serverId: 'github', originalToolName: 'create_issue' }),
      { debug: vi.fn() },
    );
    const afterToolCall = vi.fn();
    const hooks = createVoltAgentLifecycleHooks('assistant', {
      afterToolCall,
    });
    const context = operationContext();
    const args = { owner: 'kontourai', repo: 'station', title: 'Issue' };
    const output = [{ type: 'text', text: '{"id":"1"}' }];
    const tool = toVoltAgentTool(loaded as any);

    await hooks.onToolStart!({
      agent: {} as any,
      tool,
      context,
      args,
      options: toolOptions('call-provenance'),
    });
    await hooks.onToolEnd!({
      tool,
      context,
      output,
      options: toolOptions('call-provenance'),
    });

    const [toolContext, result] = afterToolCall.mock.calls[0];
    expect(toolContext.mcp?.provenance).toMatchObject({
      serverId: 'github',
      originalToolName: 'create_issue',
      runtimeName: 'github_createIssue',
      integrationId: 'github-integration',
    });
    expect(Object.isFrozen(toolContext.mcp?.provenance)).toBe(true);
    expect(toolContext.mcp?.trustedArguments).toBe(args);
    expect(result.mcp?.trustedContent).toBe(output);
    expect(JSON.stringify({ toolContext, result })).not.toContain(
      'loader-provenance',
    );
  });

  it('does not mint an unattended principal from caller-controlled options', async () => {
    const beforeToolCall = vi.fn().mockResolvedValue(true);
    const hooks = createVoltAgentLifecycleHooks('assistant', {
      beforeToolCall,
    });

    await hooks.onToolStart!({
      agent: {} as any,
      tool: { name: 'lookup' } as any,
      context: operationContext(),
      args: {},
      options: {
        ...toolOptions('caller-supplied-delegation'),
        delegation: { parentAgentSlug: 'claimed-parent' },
        unattendedPrincipal: {
          kind: 'voice',
          agentSlug: 'forged-agent',
          sessionId: 'forged-session',
        },
      },
    });

    const invocation = beforeToolCall.mock.calls[0][1];
    expect(invocation.delegation).toEqual({
      parentAgentSlug: 'claimed-parent',
    });
    expect(invocation.unattendedPrincipal).toBeUndefined();
  });

  it('passes only the runtime-composed scheduled-job principal to the tool gate', async () => {
    const beforeToolCall = vi.fn().mockResolvedValue(true);
    const hooks = createVoltAgentLifecycleHooks('assistant', {
      beforeToolCall,
    });

    await runWithScheduledPrincipal(
      { kind: 'scheduled-job', jobId: 'server-issued-job-a' },
      'receipt-run-1',
      async () => {
        await hooks.onToolStart!({
          agent: {} as any,
          tool: { name: 'lookup' } as any,
          context: operationContext(),
          args: {},
          options: {
            ...toolOptions('scheduler-principal'),
            unattendedPrincipal: {
              kind: 'scheduled-job',
              jobId: 'forged-job-b',
            },
          },
        });
      },
    );

    expect(beforeToolCall.mock.calls[0][1].unattendedPrincipal).toEqual({
      kind: 'scheduled-job',
      jobId: 'server-issued-job-a',
    });
    expect(beforeToolCall.mock.calls[0][1].traceId).toBe('receipt-run-1');
  });

  it('uses the discovered server-issued scheduler principal for exact grants, not a sibling job or caller-forged value', async () => {
    const store = new UnattendedGrantStore(grantHome);
    const jobA = { kind: 'scheduled-job' as const, jobId: 'server-job-a' };
    await store.grantTool(principalKey(jobA), 'lookup', 'operator');
    const hooks = createVoltAgentLifecycleHooks('assistant', {
      beforeToolCall: makeUnattendedGrantResolver(store, {
        logger: { debug: vi.fn(), error: vi.fn() },
      }),
    });
    const call = (jobId: string, runId: string) =>
      runWithScheduledPrincipal(
        { kind: 'scheduled-job', jobId },
        runId,
        async () => {
          await hooks.onToolStart!({
            agent: {} as any,
            tool: { name: 'lookup' } as any,
            context: operationContext(),
            args: {},
            options: {
              ...toolOptions(runId),
              unattendedPrincipal: { kind: 'scheduled-job', jobId: 'forged' },
            },
          });
        },
      );
    await expect(call(jobA.jobId, 'run-a')).resolves.toBeUndefined();
    await expect(call('server-job-b', 'run-b')).rejects.toMatchObject({
      code: 'TOOL_FORBIDDEN',
    });
  });

  it('carries the discovered scheduler principal and receipt trace through the production scheduler Adapter into Volt hooks', async () => {
    const store = new UnattendedGrantStore(grantHome);
    const beforeToolCall = vi.fn(
      makeUnattendedGrantResolver(store, {
        logger: { debug: vi.fn(), error: vi.fn() },
      }),
    );
    const hooks = createVoltAgentLifecycleHooks('assistant', {
      beforeToolCall,
    });
    const observed: Array<{
      principal: unknown;
      traceId: unknown;
      signal: AbortSignal | undefined;
    }> = [];
    const adapter = createScheduledTurnAdapter(
      new Map([
        [
          'default',
          {
            generateText: async (_prompt: string, options?: any) => {
              await hooks.onToolStart!({
                agent: {} as any,
                tool: { name: 'lookup' } as any,
                context: operationContext(),
                args: {},
                // This forged value is deliberately ignored by the hook: the
                // Adapter's server-only scheduled context is authoritative.
                options: {
                  ...toolOptions('runtime-scheduler-call'),
                  unattendedPrincipal: {
                    kind: 'scheduled-job',
                    jobId: 'caller-forged-job',
                  },
                },
              });
              const invocation = beforeToolCall.mock.calls.at(-1)![1];
              observed.push({
                principal: invocation.unattendedPrincipal,
                traceId: invocation.traceId,
                signal: options?.signal,
              });
              return { text: 'ok' };
            },
          },
        ],
      ]),
    );
    const scheduler = new BuiltinScheduler({
      ledger: createSchedulerLedger({
        directory: join(grantHome, 'scheduler'),
      }),
      turnAdapter: adapter,
    });
    try {
      await scheduler.addJob({ name: 'daily', prompt: 'run' });
      const first = await scheduler.listJobs();
      const identity = first[0]!.unattendedPrincipal;
      expect(identity).toEqual({
        kind: 'scheduled-job',
        jobId: expect.any(String),
      });
      if (!identity)
        throw new Error('Scheduler did not project a grant identity');
      await store.grantTool(principalKey(identity), 'lookup', 'operator');

      const firstRun = await scheduler.runJob('daily');
      expect(firstRun).toMatchObject({
        outcome: 'completed',
        message: "Job 'daily' completed",
        runId: expect.stringMatching(/^schedule:built-in:daily:[0-9a-f-]+-1$/),
      });
      expect(observed).toEqual([
        {
          principal: identity,
          traceId: expect.stringMatching(/^[0-9a-f-]+$/),
          signal: expect.any(AbortSignal),
        },
      ]);

      // A recreated display name has a new opaque identity, so the old grant
      // cannot authorize it even though callers still address the job by name.
      await scheduler.removeJob('daily');
      await scheduler.addJob({ name: 'daily', prompt: 'run again' });
      await expect(scheduler.runJob('daily')).resolves.toMatchObject({
        outcome: 'indeterminate',
      });
    } finally {
      await scheduler.stop();
    }
  });

  it('treats a bare false denial as denied with the generic gate message', async () => {
    const hooks = createVoltAgentLifecycleHooks('assistant', {
      beforeToolCall: vi.fn().mockResolvedValue(false),
    });

    await expect(
      hooks.onToolStart!({
        agent: {} as any,
        tool: { name: 'lookup' } as any,
        context: operationContext(),
        args: {},
        options: toolOptions('call-denied-bare'),
      }),
    ).rejects.toMatchObject({
      message: "Tool 'lookup' was denied by Station's tool gate.",
      code: 'TOOL_FORBIDDEN',
    });
  });

  it('observes successful tool output only after completion with start arguments and call identity', async () => {
    const beforeToolCall = vi.fn().mockResolvedValue(true);
    const afterToolCall = vi.fn();
    const hooks = createVoltAgentLifecycleHooks('assistant', {
      beforeToolCall,
      afterToolCall,
    });
    const context = operationContext();
    const options = toolOptions('call-success');
    const args = { query: 'station' };

    await hooks.onToolStart!({
      agent: {} as any,
      tool: { name: 'lookup' } as any,
      context,
      args,
      options,
    });

    expect(afterToolCall).not.toHaveBeenCalled();

    const output = { answer: 42 };
    await hooks.onToolEnd!({
      agent: {} as any,
      tool: { name: 'lookup' } as any,
      context,
      output,
      error: undefined,
      options,
    });

    expect(afterToolCall).toHaveBeenCalledWith(
      {
        toolName: 'lookup',
        toolCallId: 'call-success',
        toolArgs: args,
      },
      { output, error: undefined },
      expect.objectContaining({
        agentSlug: 'assistant',
        conversationId: 'conversation-1',
        userId: 'user-1',
        traceId: 'trace-1',
        delegation: { depth: 1 },
      }),
    );
  });

  it('correlates out-of-order completion and forwards the real tool error', async () => {
    const afterToolCall = vi.fn();
    const hooks = createVoltAgentLifecycleHooks('assistant', { afterToolCall });
    const context = operationContext();
    const firstOptions = toolOptions('call-first');
    const secondOptions = toolOptions('call-second');

    await hooks.onToolStart!({
      agent: {} as any,
      tool: { name: 'lookup' } as any,
      context,
      args: { query: 'first' },
      options: firstOptions,
    });
    await hooks.onToolStart!({
      agent: {} as any,
      tool: { name: 'lookup' } as any,
      context,
      args: { query: 'second' },
      options: secondOptions,
    });

    const error = new Error('lookup failed');
    await hooks.onToolEnd!({
      agent: {} as any,
      tool: { name: 'lookup' } as any,
      context,
      output: undefined,
      error: error as any,
      options: secondOptions,
    });

    expect(afterToolCall).toHaveBeenLastCalledWith(
      {
        toolName: 'lookup',
        toolCallId: 'call-second',
        toolArgs: { query: 'second' },
      },
      { output: undefined, error },
      expect.any(Object),
    );

    await hooks.onToolEnd!({
      agent: {} as any,
      tool: { name: 'lookup' } as any,
      context,
      output: 'first-result',
      error: undefined,
      options: firstOptions,
    });

    expect(afterToolCall).toHaveBeenLastCalledWith(
      {
        toolName: 'lookup',
        toolCallId: 'call-first',
        toolArgs: { query: 'first' },
      },
      { output: 'first-result', error: undefined },
      expect.any(Object),
    );
  });

  it('isolates reused call ids across concurrent invocation contexts', async () => {
    const afterToolCall = vi.fn();
    const hooks = createVoltAgentLifecycleHooks('assistant', { afterToolCall });
    const firstContext = operationContext('conversation-first');
    const secondContext = operationContext('conversation-second');
    const options = toolOptions('provider-reused-id');

    await hooks.onToolStart!({
      agent: {} as any,
      tool: { name: 'lookup' } as any,
      context: firstContext,
      args: { query: 'first' },
      options,
    });
    await hooks.onToolStart!({
      agent: {} as any,
      tool: { name: 'lookup' } as any,
      context: secondContext,
      args: { query: 'second' },
      options,
    });

    await hooks.onEnd!({
      agent: {} as any,
      conversationId: 'conversation-first',
      context: firstContext,
      error: undefined,
      output: undefined,
    });
    await hooks.onToolEnd!({
      agent: {} as any,
      tool: { name: 'lookup' } as any,
      context: secondContext,
      output: 'second-result',
      error: undefined,
      options,
    });

    expect(afterToolCall).toHaveBeenCalledOnce();
    expect(afterToolCall).toHaveBeenCalledWith(
      {
        toolName: 'lookup',
        toolCallId: 'provider-reused-id',
        toolArgs: { query: 'second' },
      },
      { output: 'second-result', error: undefined },
      expect.objectContaining({ conversationId: 'conversation-second' }),
    );
  });
  it('maps the AI SDK inputTokens/outputTokens shape onto Station token accounting', async () => {
    const afterInvocation = vi.fn();
    const hooks = createVoltAgentLifecycleHooks('assistant', {
      afterInvocation,
    });

    await hooks.onEnd!({
      agent: {} as any,
      conversationId: 'conversation-1',
      context: operationContext(),
      error: undefined,
      output: {
        usage: { inputTokens: 11, outputTokens: 22, totalTokens: 33 },
      } as any,
    });

    expect(afterInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: { promptTokens: 11, completionTokens: 22, totalTokens: 33 },
      }),
    );
  });

  it('maps @voltagent/core UsageInfo onto Station token accounting', async () => {
    // Every branch of AgentOperationOutput's union (StandardizedTextResult,
    // StreamTextFinishResult, StandardizedObjectResult, StreamObjectFinishResult)
    // declares `usage?: UsageInfo`, and UsageInfo itself is
    // { promptTokens; completionTokens; totalTokens; ... } - already matching
    // Station's TokenUsage contract. (The raw AI SDK's own LanguageModelUsage
    // uses inputTokens/outputTokens internally, but VoltAgent normalizes past
    // that before this hook ever sees it - reading the wrong field here
    // typechecks as `undefined`, so a regression silently zeroes token counts
    // and cost estimates instead of failing.)
    const afterInvocation = vi.fn();
    const hooks = createVoltAgentLifecycleHooks('assistant', {
      afterInvocation,
    });
    const context = operationContext();

    await hooks.onEnd!({
      agent: {} as any,
      conversationId: 'conversation-1',
      context,
      error: undefined,
      output: {
        usage: {
          promptTokens: 1234,
          completionTokens: 567,
          totalTokens: 1801,
        },
      } as any,
    });

    expect(afterInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: {
          promptTokens: 1234,
          completionTokens: 567,
          totalTokens: 1801,
        },
      }),
    );
  });

  it('reports no usage when the provider omits it', async () => {
    const afterInvocation = vi.fn();
    const hooks = createVoltAgentLifecycleHooks('assistant', {
      afterInvocation,
    });

    await hooks.onEnd!({
      agent: {} as any,
      conversationId: 'conversation-1',
      context: operationContext(),
      error: undefined,
      output: {} as any,
    });

    expect(afterInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ usage: undefined }),
    );
  });
});
