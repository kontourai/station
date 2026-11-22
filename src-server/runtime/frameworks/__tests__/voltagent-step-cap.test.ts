import { MCPLocalConnectionCustody } from '@kontourai/station-shared/mcp';
import { jsonSchema } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileMemoryAdapter } from '../../../adapters/file/memory-adapter.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import {
  loadAgentConfig,
  saveAgentConfig,
} from '../../../domain/config-loader-agents.js';
import { ApprovalRegistry } from '../../../services/approvals/approval-registry.js';
import { createLogger } from '../../../utils/logger.js';
import { VoltAgentFramework } from '../voltagent-adapter.js';

const makeTempDir = trackTempDirs();

test.each([1, 2])(
  'a persisted Agent maxSteps of %i bounds VoltAgent’s actual loop',
  async (maxSteps) => {
    const projectHomeDir = makeTempDir('station-volt-step-cap-');
    await saveAgentConfig(projectHomeDir, 'writer', {
      name: 'Writer',
      prompt: 'Keep calling the counter.',
      maxSteps,
    });
    const spec = await loadAgentConfig(projectHomeDir, 'writer');
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls += 1;
        return {
          content:
            calls <= 2
              ? [
                  {
                    type: 'tool-call',
                    toolCallId: `counter-${calls}`,
                    toolName: 'counter',
                    input: '{}',
                  },
                ]
              : [{ type: 'text', text: 'Done.' }],
          finishReason:
            calls <= 2
              ? { unified: 'tool-calls', raw: 'tool_calls' }
              : { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });
    const execute = vi.fn(async () => ({ counted: true }));
    const framework = new VoltAgentFramework();
    vi.spyOn(framework, 'createModel').mockResolvedValue(model);
    vi.spyOn(framework, 'loadTools').mockResolvedValue([
      {
        name: 'counter',
        description: 'Count one request',
        parameters: jsonSchema({ type: 'object', properties: {} }),
        execute,
      },
    ]);

    const logger = createLogger({ name: 'step-cap-test' });
    const { agent } = await framework.createAgent(
      'writer',
      spec,
      {
        appConfig: {
          defaultModel: 'fixture',
          invokeModel: 'fixture',
          structureModel: 'fixture',
          defaultMaxTurns: 3,
        },
        projectHomeDir,
      },
      {
        processedPrompt: spec.prompt,
        memoryAdapter: new FileMemoryAdapter({ projectHomeDir }),
        configLoader: new ConfigLoader({ projectHomeDir, watchFiles: false }),
        mcpConfigs: new Map(),
        mcpCustody: new MCPLocalConnectionCustody(),
        mcpConnectionStatus: new Map(),
        integrationMetadata: new Map(),
        toolNameMapping: new Map(),
        toolNameReverseMapping: new Map(),
        approvalRegistry: new ApprovalRegistry(logger),
        agentFixedTokens: new Map(),
        memoryAdapters: new Map(),
        logger,
        serverPort: 0,
      },
    );
    await agent.generateText('Start counting.', {
      userId: 'operator',
      conversationId: 'step-cap',
    });

    expect(model.doGenerateCalls).toHaveLength(maxSteps);
    expect(execute).toHaveBeenCalledTimes(maxSteps);
  },
);
