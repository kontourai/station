/**
 * The native knowledge tools are `user-defined` tools, so `toVoltAgentTool`
 * hands them to the AI SDK untouched. Their schema must survive the SDK's own
 * request preparation: a bare `z.toJSONSchema()` object is misread there as a
 * zod v3 schema and every turn of an agent holding these tools failed with
 * "Cannot read properties of undefined (reading 'typeName')" before any
 * request reached the model — the built-in Station agent's scheduled turns
 * among them.
 */
import { MCPLocalConnectionCustody } from '@kontourai/station-shared/mcp';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileMemoryAdapter } from '../../../adapters/file/memory-adapter.js';
import { stationKnowledgeRuntimeIdentity } from '../../bootstrap/station-control-runtime-env.js';
import { VoltAgentFramework } from '../../frameworks/voltagent-adapter.js';
import { __resetStationControlMcpTokensForTests } from '../station-control-mcp-token.js';
import { createNativeStationKnowledgeTools } from '../station-knowledge-native-tools.js';

const makeTempDir = trackTempDirs();
const owners: MCPLocalConnectionCustody[] = [];
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.shutdown()));
  __resetStationControlMcpTokensForTests();
});

test('an agent holding the native knowledge tools sends its turn with their schemas', async () => {
  const owner = new MCPLocalConnectionCustody();
  owners.push(owner);
  const definition = {
    id: 'station-knowledge',
    kind: 'mcp' as const,
    transport: 'stdio' as const,
    ...stationKnowledgeRuntimeIdentity(41032),
  };
  const native = createNativeStationKnowledgeTools(
    definition,
    41032,
    owner.acquire(definition.id, 'managed'),
    owner,
  );
  expect(native.tools.length).toBeGreaterThan(0);

  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: 'Ready.' }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }),
  });
  const agent = await new VoltAgentFramework().createTempAgent({
    agentId: 'station',
    name: 'station',
    instructions: 'Answer briefly.',
    model,
    tools: native.tools as never,
    memoryAdapter: new FileMemoryAdapter({
      projectHomeDir: makeTempDir('station-knowledge-native-request-'),
    }) as never,
  });

  const result = await agent.generateText('Check readiness.', {
    userId: 'owner',
    conversationId: 'knowledge-native-request',
  });

  expect(result.text).toBe('Ready.');
  expect(model.doGenerateCalls).toHaveLength(1);
  const sent = (model.doGenerateCalls[0]!.tools ?? []).flatMap((tool) =>
    tool.type === 'function' ? [tool] : [],
  );
  const roots = sent.find((tool) => tool.name === 'list_knowledge_roots');
  expect(roots?.inputSchema).toMatchObject({ type: 'object' });
  expect(sent.map((tool) => tool.name).sort()).toEqual(
    native.tools.map((tool) => tool.name).sort(),
  );
});
