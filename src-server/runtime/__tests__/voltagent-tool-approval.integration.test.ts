import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../domain/config-loader.js';
import { ApprovalRegistry } from '../../services/approvals/approval-registry.js';
import { createMCPToolProvenanceGeneration } from '../../services/orchestration/mcp-tool-provenance.js';
import { createAgentHooks } from '../agents/agent-hooks.js';
import { createElicitationCallback } from '../conversation/stream-orchestrator.js';
import { VoltAgentFramework } from '../frameworks/voltagent-adapter.js';
import { InjectableStream } from '../streaming/InjectableStream.js';
import {
  type MCPToolNameMappingEntry,
  normalizeLoadedMCPTools,
} from '../tools/mcp-tool-names.js';
import type { IStreamChunk, ITool } from '../types.js';

const temp = trackTempDirs();
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

test.each([
  { action: 'read', approval: 'none', executes: true },
  { action: 'write', approval: 'approve', executes: true },
  { action: 'write', approval: 'deny', executes: false },
  { action: 'new_action', approval: 'deny', executes: false },
  { action: 'write', approval: 'unavailable', executes: false },
] as const)(
  'managed MCP $action with approval $approval executes=$executes through the real framework',
  async ({ action, approval, executes }) => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const registry = new ApprovalRegistry(logger);
    const loader = new ConfigLoader({ projectHomeDir: temp('tool-approval-') });
    const instructions = 'Use the requested tool once.';
    const spec: AgentSpec = {
      name: 'Approval proof',
      prompt: instructions,
      tools: {
        mcpServers: ['reports'],
        autoApprove:
          action === 'read' ? ['mcp/reports/read'] : ['*', 'mcp/reports/read'],
        askBeforeUse: ['mcp/reports/*'],
      },
    };
    const mapping = new Map<string, MCPToolNameMappingEntry>();
    const executed = vi.fn(async () => 'fixture result');
    const tool: ITool = {
      name: `reports_${action}`,
      description: 'A harmless approval fixture',
      parameters: { type: 'object', properties: {} },
      execute: executed,
    };
    const tools = normalizeLoadedMCPTools(
      'approval-proof',
      [tool],
      mapping,
      new Map(),
      createMCPToolProvenanceGeneration(),
      'reports',
      () => ({ serverId: 'reports', originalToolName: action }),
      logger,
    );
    const runtimeName = tools[0]!.name;
    const hooks = createAgentHooks({
      spec,
      appConfig: {
        defaultModel: 'fixture',
        invokeModel: 'fixture',
        structureModel: 'fixture',
      },
      configLoader: loader,
      agentFixedTokens: new Map(),
      memoryAdapters: new Map(),
      toolNameMapping: mapping,
      logger,
    });
    const injected = new InjectableStream();
    const callback = createElicitationCallback(
      spec,
      mapping,
      registry,
      injected,
      logger,
      () => 'approval-conversation',
    );
    const unregister =
      approval === 'approve' || approval === 'deny'
        ? hooks.registerApprovalRequester(
            'approval-conversation',
            async (call) =>
              (await callback({ type: 'tool-approval', ...call })) === true,
          )
        : () => {};
    let modelCall = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream<LanguageModelV3StreamPart>({
          chunks:
            modelCall++ === 0
              ? [
                  {
                    type: 'tool-call',
                    toolCallId: 'fixture-call',
                    toolName: runtimeName,
                    input: '{}',
                  },
                  {
                    type: 'finish',
                    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                    usage,
                  },
                ]
              : [
                  { type: 'text-start', id: 'answer' },
                  { type: 'text-delta', id: 'answer', delta: 'Done.' },
                  { type: 'text-end', id: 'answer' },
                  {
                    type: 'finish',
                    finishReason: { unified: 'stop', raw: 'stop' },
                    usage,
                  },
                ],
        }),
      }),
    });
    const agent = await new VoltAgentFramework().createTempAgent({
      name: 'approval-proof',
      instructions,
      model,
      tools,
      hooks,
    });
    const events: IStreamChunk[] = [];
    let consuming: Promise<void> | undefined;
    let completion: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const result = await agent.streamText('Call the fixture tool.', {
        conversationId: 'approval-conversation',
        userId: 'operator',
      });
      completion = Promise.allSettled([
        result.text,
        result.usage,
        result.finishReason,
      ]);
      consuming = (async () => {
        for await (const event of injected.wrap(result.fullStream)) {
          events.push(event);
        }
      })();
      if (approval === 'approve' || approval === 'deny') {
        await vi.waitFor(() =>
          expect(events).toContainEqual(
            expect.objectContaining({
              type: 'tool-approval-request',
              toolName: runtimeName,
            }),
          ),
        );
        const request = events.find(
          (event) => event.type === 'tool-approval-request',
        );
        expect(executed).not.toHaveBeenCalled();
        expect(registry.has(request!.approvalId)).toBe(true);
        expect(
          registry.resolve(request!.approvalId, approval === 'approve'),
        ).toBe(true);
      }
      await consuming;
      expect(executed).toHaveBeenCalledTimes(executes ? 1 : 0);
      expect(
        events.filter((event) => event.type === 'tool-approval-request'),
      ).toHaveLength(approval === 'approve' || approval === 'deny' ? 1 : 0);
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'tool-result', toolName: runtimeName }),
      );
      for (const outcome of await completion) {
        expect(outcome.status).toBe(executes ? 'fulfilled' : 'rejected');
        if (outcome.status === 'rejected') {
          expect(outcome.reason).toMatchObject({ code: 'TOOL_FORBIDDEN' });
        }
      }
    } finally {
      registry.cancelAll();
      unregister();
      await consuming;
      await completion;
      await loader.dispose();
    }
  },
);
