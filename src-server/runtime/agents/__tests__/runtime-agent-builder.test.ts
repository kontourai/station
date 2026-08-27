/**
 * station#1426 fix round (independent verifier's fault injection): removing
 * `dispatchEvidenceSource: context.dispatchEvidenceSource` from the config
 * threaded at `runtime-agent-builder.ts` was caught by NOTHING — every
 * existing suite stayed green. This pins the forwarding directly: given a
 * `RuntimeAgentBuilderContext` carrying a `dispatchEvidenceSource` (and a
 * `logger`), the `AgentCreationConfig` passed to `framework.createAgent`
 * must carry that same source/logger through unchanged.
 */
import { describe, expect, test, vi } from 'vitest';
import { prepareRuntimeAgentInstance } from '../runtime-agent-builder.js';

function fakeContext(overrides: Record<string, unknown> = {}) {
  const createAgent = vi.fn(
    async (_slug: string, _spec: unknown, _config: any) => ({
      agent: { id: 'fake-agent' },
      tools: [],
      memoryAdapter: {},
      fixedTokens: { systemPromptTokens: 0, mcpServerTokens: 0 },
    }),
  );

  return {
    context: {
      agentSlug: 'writer',
      appConfig: { systemPrompt: '' },
      configLoader: {
        loadAgent: vi.fn(async () => ({
          name: 'writer',
          prompt: 'Be helpful.',
        })),
        getProjectHomeDir: () => '/tmp/station-test-home',
      },
      framework: { createAgent },
      skillService: {
        getSkillCatalogPrompt: () => '',
        getSkillTool: () => undefined,
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      approvalRegistry: {},
      mcpConfigs: new Map(),
      mcpConnectionStatus: new Map(),
      integrationMetadata: new Map(),
      toolNameMapping: new Map(),
      toolNameReverseMapping: new Map(),
      memoryAdapters: new Map(),
      agentFixedTokens: new Map(),
      agentTools: new Map(),
      globalToolRegistry: new Map(),
      agentHooksMap: new Map(),
      agentSpecs: new Map(),
      replaceTemplateVariables: (text: string) => text,
      ...overrides,
    } as any,
    createAgent,
  };
}

describe('prepareRuntimeAgentInstance forwards dispatch evidence wiring (station#1426 fix round)', () => {
  test('forwards the context dispatchEvidenceSource and logger into the AgentCreationConfig passed to framework.createAgent', async () => {
    const dispatchEvidenceSource = {
      getConnectionReadinessEvidence: vi.fn(async () => new Map()),
    };
    const { context, createAgent } = fakeContext({ dispatchEvidenceSource });

    await prepareRuntimeAgentInstance(context);

    expect(createAgent).toHaveBeenCalledTimes(1);
    const [, , agentCreationConfig] = createAgent.mock.calls[0]!;
    expect(agentCreationConfig.dispatchEvidenceSource).toBe(
      dispatchEvidenceSource,
    );
    expect(agentCreationConfig.logger).toBe(context.logger);
  });

  test('an absent dispatchEvidenceSource is forwarded as-is (undefined), never fabricated', async () => {
    const { context, createAgent } = fakeContext();

    await prepareRuntimeAgentInstance(context);

    const [, , agentCreationConfig] = createAgent.mock.calls[0]!;
    expect(agentCreationConfig.dispatchEvidenceSource).toBeUndefined();
  });
});
