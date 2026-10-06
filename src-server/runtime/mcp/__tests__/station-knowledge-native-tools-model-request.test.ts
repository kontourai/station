/**
 * The native knowledge tools reach two runtimes, and each must receive their
 * schema in the form it reads:
 *
 * - VoltAgent hands `parameters` to the AI SDK. A bare `z.toJSONSchema()`
 *   object that skipped `toVoltAgentTool`'s `jsonSchema()` marking was
 *   misread as a zod v3 schema, and every turn of an agent holding these
 *   tools failed with "Cannot read properties of undefined (reading
 *   'typeName')" before any request reached the model — the built-in Station
 *   agent's scheduled turns among them.
 * - Strands hands `parameters` to `FunctionTool` as its JSON Schema, so it
 *   must stay a plain schema; an AI SDK wrapper there became
 *   `{"jsonSchema":{…}}` with no top-level `type`.
 */
import { MCPLocalConnectionCustody } from '@kontourai/station-shared/mcp';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileMemoryAdapter } from '../../../adapters/file/memory-adapter.js';
import { stationKnowledgeRuntimeIdentity } from '../../bootstrap/station-control-runtime-env.js';
import { createStrandsFunctionTools } from '../../frameworks/strands-tool-loader.js';
import { VoltAgentFramework } from '../../frameworks/voltagent-adapter.js';
import { __resetStationControlMcpTokensForTests } from '../station-control-mcp-token.js';
import { createNativeStationKnowledgeTools } from '../station-knowledge-native-tools.js';

const makeTempDir = trackTempDirs();
const owners: MCPLocalConnectionCustody[] = [];
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.shutdown()));
  __resetStationControlMcpTokensForTests();
});

function nativeKnowledgeTools(port: number) {
  const owner = new MCPLocalConnectionCustody();
  owners.push(owner);
  const definition = {
    id: 'station-knowledge',
    kind: 'mcp' as const,
    transport: 'stdio' as const,
    ...stationKnowledgeRuntimeIdentity(port),
  };
  const native = createNativeStationKnowledgeTools(
    definition,
    port,
    owner.acquire(definition.id, 'managed'),
    owner,
  );
  expect(native.tools.length).toBeGreaterThan(0);
  return native;
}

test('an agent holding the native knowledge tools sends its turn with their schemas', async () => {
  const native = nativeKnowledgeTools(41032);

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

test('Strands receives the native knowledge tools as plain JSON Schema', () => {
  const native = nativeKnowledgeTools(41033);
  const functionTools = createStrandsFunctionTools(
    native.tools as never,
    new Map(),
  );
  expect(functionTools.map((tool) => tool.name).sort()).toEqual(
    native.tools.map((tool) => tool.name).sort(),
  );
  for (const tool of functionTools) {
    const schema = tool.toolSpec.inputSchema as Record<string, unknown>;
    expect(schema.type, tool.name).toBe('object');
    expect(schema, tool.name).not.toHaveProperty('jsonSchema');
    expect(schema.properties, tool.name).toEqual(expect.any(Object));
  }
});
