/**
 * A VoltAgent turn that calls a native knowledge tool, end to end through
 * Station's own seams: `toVoltAgentTool` advertises the tool with Station's
 * `__station_tool_purpose` field, the model fills it in, and the purpose must
 * be stripped before the knowledge executor forwards the arguments to the
 * Knowledge MCP server. The server's answer must then reach the model's next
 * step, and the turn must finish.
 *
 * Only the MCP client's transport boundary is replaced (`connect`, `close`,
 * `callTool`); the knowledge executor, its session/turn authorization and the
 * VoltAgent adapter are the real ones.
 */
import { MCPLocalConnectionCustody } from '@kontourai/station-shared/mcp';
import { Client } from '@modelcontextprotocol/client';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileMemoryAdapter } from '../../../adapters/file/memory-adapter.js';
import { stationKnowledgeRuntimeIdentity } from '../../bootstrap/station-control-runtime-env.js';
import { runWithAuthorizedTurnCorrelation } from '../../conversation/authorized-turn-correlation.js';
import { STATION_TOOL_PURPOSE_KEY } from '../../frameworks/tool-purpose.js';
import { VoltAgentFramework } from '../../frameworks/voltagent-adapter.js';
import { __resetStationControlMcpTokensForTests } from '../station-control-mcp-token.js';
import {
  beginNativeKnowledgeTurn,
  createNativeStationKnowledgeTools,
  startNativeKnowledgeSession,
  stopNativeKnowledgeSession,
} from '../station-knowledge-native-tools.js';

const SESSION = 'knowledge-volt-turn';
const ROOTS_RESULT = 'Knowledge roots: personal (fixture)';

const makeTempDir = trackTempDirs();
const owners: MCPLocalConnectionCustody[] = [];
afterEach(async () => {
  await stopNativeKnowledgeSession(SESSION);
  await Promise.all(owners.splice(0).map((owner) => owner.shutdown()));
  __resetStationControlMcpTokensForTests();
  vi.restoreAllMocks();
});

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

test('a VoltAgent turn calls a knowledge tool without its purpose field and reads the result', async () => {
  vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined);
  vi.spyOn(Client.prototype, 'close').mockResolvedValue(undefined);
  const callTool = vi
    .spyOn(Client.prototype, 'callTool')
    .mockResolvedValue({ content: [{ type: 'text', text: ROOTS_RESULT }] });

  const owner = new MCPLocalConnectionCustody();
  owners.push(owner);
  const definition = {
    id: 'station-knowledge',
    kind: 'mcp' as const,
    transport: 'stdio' as const,
    ...stationKnowledgeRuntimeIdentity(41035),
  };
  const native = createNativeStationKnowledgeTools(
    definition,
    41035,
    owner.acquire(definition.id, 'managed'),
    owner,
  );
  startNativeKnowledgeSession(SESSION);
  beginNativeKnowledgeTurn(SESSION, 'turn-1', new AbortController().signal);

  const model = new MockLanguageModelV3({
    doGenerate: async () =>
      model.doGenerateCalls.length === 1
        ? {
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: 'call-1',
                toolName: 'list_knowledge_roots',
                input: JSON.stringify({
                  [STATION_TOOL_PURPOSE_KEY]: 'Find where notes live',
                }),
              },
            ],
            finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
            usage,
            warnings: [],
          }
        : {
            content: [{ type: 'text' as const, text: 'Done.' }],
            finishReason: { unified: 'stop' as const, raw: 'stop' },
            usage,
            warnings: [],
          },
  });
  const agent = await new VoltAgentFramework().createTempAgent({
    agentId: 'station',
    name: 'station',
    instructions: 'Answer briefly.',
    model,
    tools: native.tools as never,
    memoryAdapter: new FileMemoryAdapter({
      projectHomeDir: makeTempDir('station-knowledge-volt-turn-'),
    }) as never,
  });

  const result = await runWithAuthorizedTurnCorrelation(
    {
      accountId: 'owner',
      sessionId: SESSION,
      turnId: 'turn-1',
      correlationId: 'correlation',
    },
    () =>
      agent.generateText('Where do my notes live?', {
        userId: 'owner',
        conversationId: SESSION,
        maxSteps: 4,
      } as never),
  );

  // (a) The Knowledge server receives the model's arguments without
  // Station's purpose field.
  expect(callTool).toHaveBeenCalledTimes(1);
  expect(callTool.mock.calls[0]![0]).toEqual({
    name: 'list_knowledge_roots',
    arguments: {},
  });

  // (b) The server's answer is what the model reads on its next step.
  expect(model.doGenerateCalls).toHaveLength(2);
  const toolMessages = model.doGenerateCalls[1]!.prompt.filter(
    (message) => message.role === 'tool',
  );
  expect(JSON.stringify(toolMessages)).toContain(ROOTS_RESULT);

  // (c) The turn completes with the model's final answer.
  expect(result.text).toBe('Done.');
});
