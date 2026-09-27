import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
  tenantExecutionContextFromRequest,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { createAgentHooks } from '../../../runtime/agents/agent-hooks.js';
import { ApprovalRegistry } from '../../../services/approvals/approval-registry.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  approvalDuration: { record: vi.fn() },
  approvalOps: { add: vi.fn() },
  chatRequests: { add: vi.fn() },
  controlActions: { add: vi.fn() },
  toolDenials: { add: vi.fn() },
}));

vi.mock('../../../utils/auth-errors.js', () => ({
  isAuthError: () => false,
}));

vi.mock('../../system/auth.js', () => ({
  getCachedUser: () => ({ alias: 'authenticated-user' }),
}));

vi.mock('ai', () => ({
  jsonSchema: (s: unknown) => s,
}));

const { createInvokeRoutes } = await import('../invoke.js');
const { controlActions } = await import('../../../telemetry/metrics.js');
const { markTrustedNativeStationControlTool } = await import(
  '../../../runtime/tools/tool-provenance.js'
);

function nativeControlTool<T extends object>(tool: T): T {
  return markTrustedNativeStationControlTool(tool);
}

function createMockCtx(overrides: Record<string, unknown> = {}) {
  let nativeRun = 0;
  const nativeInvocationRuns = {
    begin: vi.fn(() => {
      const runId = `invoke:test-${++nativeRun}`;
      return {
        kind: 'owner' as const,
        runId,
        claim: {
          beginInvocation: vi.fn(() => ({ kind: 'applied' as const })),
          completed: vi.fn(() => ({ kind: 'applied' as const })),
          failedBeforeInvocation: vi.fn(() => ({ kind: 'applied' as const })),
          indeterminate: vi.fn(() => ({ kind: 'applied' as const })),
        },
      };
    }),
    list: vi.fn(() => ({ kind: 'available' as const, runs: [] })),
    read: vi.fn(() => ({ kind: 'available' as const, run: null })),
    reconcile: vi.fn(() => ({ kind: 'available' as const })),
  };
  const mockAgent = {
    generateText: vi.fn().mockResolvedValue({
      text: 'Hello from agent',
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      steps: [{ type: 'text' }],
      toolCalls: [],
      toolResults: [],
      reasoning: null,
    }),
    generateObject: vi.fn().mockResolvedValue({
      object: { result: 'structured' },
      usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 },
    }),
    instructions: 'test instructions',
    model: 'test-model',
  };

  return {
    activeAgents: new Map([['default', mockAgent]]),
    agentSpecs: new Map([['default', {}]]),
    agentTools: new Map([['default', [{ name: 'tool1' }]]]),
    globalToolRegistry: new Map(),
    modelCatalog: {
      resolveModelId: vi.fn().mockResolvedValue('resolved-model'),
    },
    createBedrockModel: vi.fn().mockResolvedValue('bedrock-model'),
    framework: {
      createModel: vi.fn().mockResolvedValue('selected-model'),
      createTempAgent: vi.fn().mockResolvedValue(mockAgent),
    },
    configLoader: {
      getProjectHomeDir: () => '/tmp/station-home',
      getLaunchabilityRevision: () => 0,
    },
    providerService: {
      getLaunchabilityRevision: () => 0,
      listProviderConnections: () => [
        {
          id: 'bedrock-default',
          type: 'bedrock',
          enabled: true,
          capabilities: ['llm'],
          config: {},
        },
      ],
    },
    appConfig: {
      defaultLLMProvider: 'bedrock-default',
      defaultModel: 'default-model',
      invokeModel: 'default-model',
      structureModel: 'structure-model',
      region: 'us-east-1',
      systemPrompt: null,
    },
    replaceTemplateVariables: vi.fn((s: string) => s),
    getAgentConfigurationRevision: () => 0,
    commitAgentConfigurationRead: vi.fn(
      async (_revision: number, operation: () => Promise<unknown>) =>
        operation(),
    ),
    getNormalizedToolName: vi.fn((name: string) => name),
    getOriginalToolName: vi.fn((name: string) => name),
    orchestrationEventStore: {
      nativeInvocationStarter: vi.fn(() => nativeInvocationRuns),
    },
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    ...overrides,
  };
}

describe('Invoke Routes', () => {
  test('POST /tool-approval keeps a hosted approval pending when its backing session is not authorized', async () => {
    const tenants = parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [
        { id: 'alpha', authority: 'alpha.example.test' },
        { id: 'bravo', authority: 'bravo.example.test' },
      ],
    });
    const registry = new ApprovalRegistry(createMockCtx().logger, {
      isHosted: () => true,
      resolveSessionTenant: () =>
        tenantExecutionContextFromRequest({ tenantId: tenantId('alpha') }),
      canReadSession: (_sessionId, authority) =>
        authority.tenantExecutionContext?.tenantId === tenantId('alpha'),
    });
    const pending = registry.register('alpha-approval', {
      metadata: {
        conversationId: 'alpha-session',
        source: 'runtime',
        title: 'tool',
      },
    });
    const ctx = createMockCtx({ approvalRegistry: registry });
    const app = createInvokeRoutes(ctx as any, {
      readAuthorityForRequest: () =>
        sessionReadAuthorityFromRequest(
          'bravo-user',
          { tenantId: tenantId('bravo') },
          tenants,
        ),
    });

    const response = await app.request('/tool-approval/alpha-approval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    });

    expect(response.status).toBe(404);
    expect(registry.has('alpha-approval')).toBe(true);
    registry.resolveAuthorized(
      'alpha-approval',
      false,
      sessionReadAuthorityFromRequest(
        'alpha-user',
        { tenantId: tenantId('alpha') },
        tenants,
      ),
    );
    await expect(pending).resolves.toBe(false);
  });

  // SDK invokeAgent returns the full response object
  test('POST /agents/:slug/invoke returns { success, response, usage }', async () => {
    const ctx = createMockCtx();
    const app = createInvokeRoutes(ctx as any);
    const body = await json(
      await app.request('/agents/station/invoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Hello' }),
      }),
    );
    expect(body.success).toBe(true);
    expect(body.response).toBe('Hello from agent');
    expect(body.runId).toBe('invoke:test-1');
    // SDK passes through usage, steps, toolCalls, toolResults, reasoning
    expect(body.usage).toEqual({
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
    });
    expect(body.steps).toBeDefined();
    expect(body.toolCalls).toBeDefined();
    expect(body.toolResults).toBeDefined();
    expect(body).toHaveProperty('reasoning');
  });

  test('returns a stable non-retryable receipt when the provider call throws after its durable boundary', async () => {
    const ctx = createMockCtx();
    ctx.activeAgents
      .get('default')!
      .generateText.mockRejectedValueOnce(
        new Error('provider detail must not escape'),
      );
    const app = createInvokeRoutes(ctx as any);

    const response = await app.request('/agents/station/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Hello' }),
    });

    expect(response.status).toBe(409);
    expect(await json(response)).toEqual({
      success: false,
      code: 'native_invocation_indeterminate',
      outcome: 'indeterminate',
      runId: 'invoke:test-1',
      error:
        'The provider invocation may have started. Observe the run before retrying.',
    });
    expect(ctx.activeAgents.get('default')!.generateText).toHaveBeenCalledTimes(
      1,
    );
  });

  test('does not report provider success when terminal run persistence is unavailable', async () => {
    const ctx = createMockCtx({
      orchestrationEventStore: {
        nativeInvocationStarter: () => ({
          begin: () => ({
            kind: 'owner',
            runId: 'invoke:terminal-uncertain',
            claim: {
              beginInvocation: () => ({ kind: 'applied' }),
              completed: () => ({ kind: 'unavailable' }),
              failedBeforeInvocation: () => ({ kind: 'applied' }),
              indeterminate: () => ({ kind: 'unavailable' }),
            },
          }),
        }),
      },
    });
    const app = createInvokeRoutes(ctx as any);

    const response = await app.request('/agents/station/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Hello' }),
    });

    expect(response.status).toBe(409);
    await expect(json(response)).resolves.toMatchObject({
      code: 'native_invocation_indeterminate',
      runId: 'invoke:terminal-uncertain',
    });
  });

  test('POST /agents/:slug/invoke returns 404 for unknown agent', async () => {
    const ctx = createMockCtx();
    const app = createInvokeRoutes(ctx as any);
    const res = await app.request('/agents/nonexistent/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Hello' }),
    });
    expect(res.status).toBe(404);
    const body = await json(res);
    expect(body.success).toBe(false);
  });

  test('rejects the retired public default identity', async () => {
    const ctx = createMockCtx();
    const app = createInvokeRoutes(ctx as any);
    const res = await app.request('/agents/default/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Hello' }),
    });

    expect(res.status).toBe(400);
    await expect(json(res)).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("Use the 'station' Agent"),
    });
  });

  test('POST /agents/:slug/invoke rejects a model override without catalog evidence', async () => {
    const ctx = createMockCtx({ modelCatalog: undefined });
    const agent = ctx.activeAgents.get('default')!;
    const app = createInvokeRoutes(ctx as any);
    const res = await app.request('/agents/station/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Hello', model: 'unknown-model' }),
    });

    expect(res.status).toBe(500);
    expect(agent.generateText).not.toHaveBeenCalled();
  });

  test('POST /agents/:slug/invoke/stream rejects a model override without catalog evidence', async () => {
    const ctx = createMockCtx({ modelCatalog: undefined });
    const agent = ctx.activeAgents.get('default')!;
    const app = createInvokeRoutes(ctx as any);
    const res = await app.request('/agents/station/invoke/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Hello', model: 'unknown-model' }),
    });

    expect(res.status).toBe(500);
    expect(agent.generateText).not.toHaveBeenCalled();
  });

  test('preserves the agent connection and region for invoke model overrides', async () => {
    const createModel = vi.fn().mockResolvedValue('regional-model');
    const ctx = createMockCtx({
      agentSpecs: new Map([
        [
          'default',
          {
            region: 'eu-west-1',
            execution: { modelConnectionId: 'bedrock-eu' },
          },
        ],
      ]),
      providerService: {
        getLaunchabilityRevision: () => 0,
        listProviderConnections: () => [
          {
            id: 'bedrock-eu',
            type: 'bedrock',
            enabled: true,
            capabilities: ['llm'],
            config: { region: 'eu-west-1' },
          },
        ],
      },
      framework: {
        createModel,
        createTempAgent: vi.fn(),
      },
    });
    const app = createInvokeRoutes(ctx as any);

    const response = await app.request('/agents/station/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Hello', model: 'eu-only-model' }),
    });

    expect(response.status).toBe(200);
    expect(createModel).toHaveBeenCalledWith(
      {
        region: 'eu-west-1',
        model: 'eu-only-model',
        execution: {
          modelConnectionId: 'bedrock-eu',
          modelId: 'eu-only-model',
        },
      },
      expect.objectContaining({
        modelCatalog: ctx.modelCatalog,
        listProviderConnections: expect.any(Function),
      }),
    );
  });

  test.each([
    ['/agents/station/invoke', { input: 'Hello', model: 'model-a' }],
    ['/agents/station/invoke/stream', { prompt: 'Hello', model: 'model-a' }],
    ['/invoke', { prompt: 'Hello', model: 'model-a' }],
  ])(
    'rejects %s when runtime configuration changes during model construction',
    async (path, body) => {
      let agentRevision = 0;
      let releaseModel!: (model: unknown) => void;
      const pendingModel = new Promise((resolve) => {
        releaseModel = resolve;
      });
      const createModel = vi.fn(() => pendingModel);
      const ctx = createMockCtx({
        getAgentConfigurationRevision: () => agentRevision,
        framework: {
          createModel,
          createTempAgent: vi.fn(),
        },
      });
      const agent = ctx.activeAgents.get('default')!;
      const app = createInvokeRoutes(ctx as any);

      const response = app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await vi.waitFor(() => expect(createModel).toHaveBeenCalledOnce());
      agentRevision = 2;
      releaseModel('stale-model');

      expect((await response).status).toBe(409);
      expect(agent.generateText).not.toHaveBeenCalled();
      expect(ctx.framework.createTempAgent).not.toHaveBeenCalled();
    },
  );

  test('rejects an invoke result completed under an obsolete configuration', async () => {
    let agentRevision = 0;
    let release!: (value: unknown) => void;
    const generated = new Promise((resolve) => {
      release = resolve;
    });
    const ctx = createMockCtx({
      getAgentConfigurationRevision: () => agentRevision,
    });
    const agent = ctx.activeAgents.get('default')!;
    agent.generateText.mockImplementationOnce(() => generated as any);
    const app = createInvokeRoutes(ctx as any);

    const response = app.request('/agents/station/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Hello' }),
    });
    await vi.waitFor(() => expect(agent.generateText).toHaveBeenCalledOnce());
    agentRevision = 2;
    release({ text: 'stale', usage: {} });

    expect((await response).status).toBe(409);
  });

  test('blocks a delayed model tool call after its configuration generation is revoked', async () => {
    let agentRevision = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi.fn().mockResolvedValue({ success: true });
    const ctx = createMockCtx({
      getAgentConfigurationRevision: () => agentRevision,
      agentTools: new Map([
        ['default', [{ name: 'github_create_issue', execute }]],
      ]),
    });
    const hooks = createAgentHooks({
      spec: {
        name: 'Default',
        prompt: 'Help',
        tools: { autoApprove: ['github_*'], mcpServers: [] },
      },
      appConfig: { defaultModel: '', invokeModel: '', structureModel: '' },
      configLoader: ctx.configLoader as any,
      agentFixedTokens: new Map(),
      memoryAdapters: new Map(),
      approvalRegistry: {} as any,
      isCurrentRuntimeGeneration: () => agentRevision === 0,
      toolNameMapping: new Map(),
      logger: ctx.logger,
    });
    const agent = ctx.activeAgents.get('default')!;
    agent.generateText.mockImplementationOnce(async (_prompt, options) => {
      await blocked;
      const allowed = await hooks.beforeToolCall!(
        {
          toolName: 'github_create_issue',
          toolCallId: 'tool-1',
          toolArgs: {},
        },
        { agentSlug: 'default', conversationId: 'conv-1' },
      );
      // Adapters execute only on a literal `true` (archive#1834: a
      // ToolCallDenial result is truthy).
      if (allowed === true) {
        await (options.tools[0] as { execute(): Promise<unknown> }).execute();
      }
      return { text: 'done', usage: {} };
    });
    const app = createInvokeRoutes(ctx as any);

    const response = app.request('/agents/station/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'Create the issue',
        tools: ['github_create_issue'],
      }),
    });
    await vi.waitFor(() => expect(agent.generateText).toHaveBeenCalledOnce());
    agentRevision = 2;
    release();

    expect((await response).status).toBe(409);
    expect(execute).not.toHaveBeenCalled();
  });

  test.each([
    ['/agents/station/invoke', { input: 'Hello', model: 'x'.repeat(513) }],
    [
      '/agents/station/invoke/stream',
      { prompt: 'Hello', model: 'x'.repeat(513) },
    ],
    ['/invoke', { prompt: 'Hello', model: 'x'.repeat(513) }],
    ['/invoke', { prompt: 'Hello', structureModel: 'x'.repeat(513) }],
  ])('rejects oversized model selectors at %s', async (path, body) => {
    const ctx = createMockCtx();
    const app = createInvokeRoutes(ctx as any);
    const response = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    expect(ctx.framework.createModel).not.toHaveBeenCalled();
  });

  test('POST /agents/:slug/invoke with schema parses JSON response', async () => {
    const ctx = createMockCtx();
    const agent = ctx.activeAgents.get('default')!;
    (agent.generateText as any).mockResolvedValue({
      text: '{"name":"test"}',
      usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 },
      steps: [],
      toolCalls: [],
      toolResults: [],
      reasoning: null,
    });
    const app = createInvokeRoutes(ctx as any);
    const body = await json(
      await app.request('/agents/station/invoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Hello', schema: { type: 'object' } }),
      }),
    );
    expect(body.success).toBe(true);
    expect(body.response).toEqual({ name: 'test' });
  });

  // SDK invoke() expects { success, response } — returns data.response
  test('POST /invoke returns { success, response, usage, steps }', async () => {
    const ctx = createMockCtx();
    const app = createInvokeRoutes(ctx as any);
    const body = await json(
      await app.request('/invoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Do something' }),
      }),
    );
    expect(body.success).toBe(true);
    expect(body.response).toBe('Hello from agent');
    expect(body.usage).toBeDefined();
    expect(body.runId).toBe('invoke:test-1');
    expect(typeof body.steps).toBe('number');
  });

  test('records each global structured provider effect without changing the response payload', async () => {
    const ctx = createMockCtx();
    const app = createInvokeRoutes(ctx as any);
    const body = await json(
      await app.request('/invoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Hello',
          schema: {
            type: 'object',
            properties: { result: { type: 'string' } },
          },
        }),
      }),
    );

    expect(body).toMatchObject({
      success: true,
      response: { result: 'structured' },
      runId: 'invoke:test-1',
      relatedRunIds: ['invoke:test-2'],
    });
  });

  test('preserves the completed primary run when structured setup fails before its provider claim', async () => {
    const ctx = createMockCtx();
    const primaryAgent = ctx.activeAgents.get('default')!;
    ctx.framework.createTempAgent = vi
      .fn()
      .mockResolvedValueOnce(primaryAgent)
      .mockRejectedValueOnce(new Error('private structure setup detail'));
    const app = createInvokeRoutes(ctx as any);

    const response = await app.request('/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Hello',
        schema: { type: 'object' },
      }),
    });

    expect(response.status).toBe(409);
    expect(await json(response)).toEqual({
      success: false,
      code: 'native_invocation_partial',
      outcome: 'indeterminate',
      runId: 'invoke:test-1',
      relatedRunIds: [],
      structureOutcome: 'not_started',
      error:
        'The primary invocation completed, but structured formatting did not complete. Observe the run before retrying.',
    });
  });

  test('preserves both exact runs when structured provider work is indeterminate', async () => {
    const ctx = createMockCtx();
    const primaryAgent = ctx.activeAgents.get('default')!;
    ctx.framework.createTempAgent = vi
      .fn()
      .mockResolvedValueOnce(primaryAgent)
      .mockResolvedValueOnce({
        generateObject: vi
          .fn()
          .mockRejectedValue(new Error('private provider detail')),
      });
    const app = createInvokeRoutes(ctx as any);

    const response = await app.request('/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Hello',
        schema: { type: 'object' },
      }),
    });

    expect(response.status).toBe(409);
    expect(await json(response)).toEqual({
      success: false,
      code: 'native_invocation_partial',
      outcome: 'indeterminate',
      runId: 'invoke:test-1',
      relatedRunIds: ['invoke:test-2'],
      structureOutcome: 'indeterminate',
      error:
        'The primary invocation completed, but structured formatting did not complete. Observe the run before retrying.',
    });
  });

  test('POST /invoke blocks a delayed temporary-agent tool after revocation', async () => {
    let revision = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi.fn().mockResolvedValue({ success: true });
    const framework = {
      createModel: vi.fn().mockResolvedValue('selected-model'),
      createTempAgent: vi.fn(async (options: { tools: any[] }) => ({
        generateText: async () => {
          await blocked;
          await options.tools[0].execute({});
          return { text: 'done', usage: {}, steps: [] };
        },
      })),
    };
    const ctx = createMockCtx({
      framework,
      getAgentConfigurationRevision: () => revision,
      globalToolRegistry: new Map([
        ['station_mutation', { name: 'station_mutation', execute }],
      ]),
    });
    const app = createInvokeRoutes(ctx as any);

    const response = app.request('/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Mutate Station',
        tools: ['station_mutation'],
      }),
    });
    await vi.waitFor(() =>
      expect(framework.createTempAgent).toHaveBeenCalled(),
    );
    revision = 2;
    release();

    expect((await response).status).toBe(409);
    expect(execute).not.toHaveBeenCalled();
  });

  test('POST /invoke returns 500 when no invoke model is configured and none is provided', async () => {
    const ctx = createMockCtx({
      appConfig: {
        invokeModel: '',
        structureModel: '',
        defaultModel: '',
        systemPrompt: null,
      },
    });
    const app = createInvokeRoutes(ctx as any);
    const res = await app.request('/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Do something' }),
    });
    expect(res.status).toBe(500);
    const body = await json(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain('No invoke model configured');
  });

  test('POST /invoke returns 500 on error', async () => {
    const ctx = createMockCtx();
    ctx.framework.createTempAgent = vi
      .fn()
      .mockRejectedValue(new Error('boom'));
    const app = createInvokeRoutes(ctx as any);
    const res = await app.request('/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Do something' }),
    });
    expect(res.status).toBe(500);
    const body = await json(res);
    expect(body.success).toBe(false);
    expect(body.error).toBeDefined();
  });

  test('POST /agents/:slug/tools/:toolName records station-control success telemetry', async () => {
    const execute = vi.fn().mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            data: { id: 'phase-proof', name: 'Phase Proof' },
          }),
        },
      ],
    });
    const ctx = createMockCtx({
      agentTools: new Map([
        [
          'default',
          [
            nativeControlTool({
              name: 'stationControl_updateSkill',
              execute,
            }),
          ],
        ],
      ]),
      getNormalizedToolName: vi.fn((name: string) =>
        name === 'station-control_update_skill'
          ? 'stationControl_updateSkill'
          : name,
      ),
      getOriginalToolName: vi.fn((name: string) =>
        name === 'stationControl_updateSkill'
          ? 'station-control_update_skill'
          : name,
      ),
    });
    const app = createInvokeRoutes(ctx as any);

    const body = await json(
      await app.request('/agents/station/tools/station-control_update_skill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Phase Proof',
          body: 'Use real control tooling.',
        }),
      }),
    );

    expect(body.success).toBe(true);
    expect(body.response.data.id).toBe('phase-proof');
    expect(execute).toHaveBeenCalledWith(
      {
        name: 'Phase Proof',
        body: 'Use real control tooling.',
      },
      { userId: 'authenticated-user' },
    );
    expect(controlActions.add).toHaveBeenCalledWith(1, {
      tool: 'station-control_update_skill',
      outcome: 'success',
      reason: 'completed',
    });
  });

  test('POST /agents/:slug/tools/:toolName records station-control failure telemetry', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('create failed'));
    const ctx = createMockCtx({
      agentTools: new Map([
        [
          'default',
          [
            nativeControlTool({
              name: 'station-control_update_skill',
              execute,
            }),
          ],
        ],
      ]),
    });
    const app = createInvokeRoutes(ctx as any);

    const res = await app.request(
      '/agents/station/tools/station-control_update_skill',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Phase Proof' }),
      },
    );

    expect(res.status).toBe(500);
    expect(controlActions.add).toHaveBeenCalledWith(1, {
      tool: 'station-control_update_skill',
      outcome: 'failure',
      // #2795: a fixed reason; free text never becomes a metric attribute.
      reason: 'tool_failed',
    });
  });

  test('POST /agents/:slug/tools/:toolName preserves an MCP tool-level refusal', async () => {
    const execute = vi.fn().mockResolvedValue({
      content: [
        {
          type: 'text',
          text: 'Delegated task request is not open',
        },
      ],
      isError: true,
    });
    const ctx = createMockCtx({
      agentTools: new Map([
        [
          'default',
          [
            nativeControlTool({
              name: 'stationControl_respondToTaskRequest',
              execute,
            }),
          ],
        ],
      ]),
      getOriginalToolName: vi.fn((name: string) =>
        name === 'stationControl_respondToTaskRequest'
          ? 'station-control_respond_to_task_request'
          : name,
      ),
    });
    const app = createInvokeRoutes(ctx as any);

    const res = await app.request(
      '/agents/station/tools/stationControl_respondToTaskRequest',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: 'task-1',
          requestId: 'request-1',
          decision: 'accept',
        }),
      },
    );

    expect(res.status).toBe(500);
    await expect(json(res)).resolves.toEqual({
      success: false,
      error: 'Delegated task request is not open',
    });
    expect(controlActions.add).toHaveBeenCalledWith(1, {
      tool: 'station-control_respond_to_task_request',
      outcome: 'failure',
      // #2795: a fixed reason; free text never becomes a metric attribute.
      reason: 'tool_failed',
    });
  });

  // #2708 A-1b review (catch s5-436): the delegation tools now RETURN a
  // failure envelope. The REAL `respond_to_task_request` handler runs here —
  // not a mocked `isError` — against this Station answering the guard's
  // refusal, and the route must still answer 500 with failure telemetry.
  test('a real delegation tool failure stays a failure through the invoke route', async () => {
    const { createStationControlMcpServer } = await import(
      '../../../tools/station-control-mcp-server.js'
    );
    const { withStationControlCallerContext, stationControlCallerPrincipal } =
      await import('../../../tools/station-control-shared.js');
    const { LOCAL_OPERATOR_PRINCIPAL_ID } = await import(
      '../../../services/identity/principal-resolver.js'
    );
    const handler = (
      createStationControlMcpServer() as unknown as {
        _registeredTools: Record<
          string,
          { handler: (args: unknown, extra?: unknown) => Promise<unknown> }
        >;
      }
    )._registeredTools.respond_to_task_request!.handler;
    const API = 'http://127.0.0.1:65009';
    const previousBase = process.env.STATION_API_BASE;
    process.env.STATION_API_BASE = API;
    const answer = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.endsWith('/.well-known/station/v1'))
          return answer({ environmentId: 'env-self', capabilities: {} });
        return answer(
          {
            success: false,
            code: 'station_control_caller_required',
            error: 'This action needs a verified calling session.',
          },
          403,
        );
      }),
    );
    // The tool-side check sees a bound operator; only this Station answers.
    const execute = vi.fn((args: unknown) =>
      withStationControlCallerContext(
        {
          token: undefined,
          resolve: () => ({
            sessionId: 'claims-operator',
            assurance: 'bound',
            principal: stationControlCallerPrincipal(
              LOCAL_OPERATOR_PRINCIPAL_ID,
              'session-owner',
            ),
          }),
        },
        () => handler(args, {}),
      ),
    );
    vi.mocked(controlActions.add).mockClear();
    try {
      const ctx = createMockCtx({
        agentTools: new Map([
          [
            'default',
            [
              nativeControlTool({
                name: 'stationControl_respondToTaskRequest',
                execute,
              }),
            ],
          ],
        ]),
        getOriginalToolName: vi.fn((name: string) =>
          name === 'stationControl_respondToTaskRequest'
            ? 'station-control_respond_to_task_request'
            : name,
        ),
      });
      const res = await createInvokeRoutes(ctx as any).request(
        '/agents/station/tools/stationControl_respondToTaskRequest',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId: 'task-1',
            requestId: 'request-1',
            decision: 'accept',
          }),
        },
      );

      expect(execute).toHaveBeenCalledTimes(1);
      const toolResult = (await execute.mock.results[0]!.value) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      // The agent's view still carries this Station's typed code.
      expect(JSON.parse(toolResult.content[0]!.text)).toMatchObject({
        success: false,
        code: 'station_control_caller_required',
      });
      expect(res.status).toBe(500);
      const body = (await json(res)) as Record<string, unknown>;
      expect(body.success).toBe(false);
      expect(controlActions.add).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          tool: 'station-control_respond_to_task_request',
          outcome: 'failure',
        }),
      );
      expect(controlActions.add).not.toHaveBeenCalledWith(
        1,
        expect.objectContaining({ outcome: 'success' }),
      );
    } finally {
      vi.unstubAllGlobals();
      if (previousBase === undefined) delete process.env.STATION_API_BASE;
      else process.env.STATION_API_BASE = previousBase;
    }
  });

  /**
   * #2795 (catch s5-436): every station-control family's failure, from the
   * REAL registered handler, through the REAL invoke route: a 500, failure
   * telemetry, and the envelope's sentence as the error — never a 200 with
   * success telemetry, and never the stringified JSON. `fetch` answers every
   * Station request the way the station-control guard refuses it; the
   * scheduler row answers an indeterminate manual run instead.
   */
  describe('station-control tool failures through the invoke route (#2795)', () => {
    const GUARD_SENTENCE = 'This action needs a verified calling session.';
    const guardRefusal = {
      success: false,
      code: 'station_control_caller_required',
      error: GUARD_SENTENCE,
    };
    const INDETERMINATE_SENTENCE = 'Scheduler run may have started';
    const indeterminate = {
      success: false,
      code: 'scheduler_run_indeterminate',
      outcome: 'indeterminate',
      error: INDETERMINATE_SENTENCE,
      data: {
        output: INDETERMINATE_SENTENCE,
        receipt: {
          outcome: 'indeterminate',
          message: INDETERMINATE_SENTENCE,
          runId: 'schedule:built-in:nightly:run-1',
        },
      },
    };
    type Row = {
      family: string;
      tool: string;
      args: Record<string, unknown>;
      /** `bound`: the tool-side check passes; `none`: it refuses. */
      caller: 'bound' | 'none';
      answer: { status: number; body: unknown };
      sentence: string;
      /** The typed code the agent reads (absent: the body carries none). */
      code?: string;
      /** The telemetry reason: the envelope's code, else the fixed one. */
      reason: string;
    };
    const rows: Row[] = [
      {
        family: 'tool-side refusal (withToolSideRefusal)',
        tool: 'disable_job',
        args: { name: 'nightly' },
        caller: 'none',
        answer: { status: 200, body: { success: true } },
        sentence: 'verified calling session',
        code: 'station_control_caller_required',
        reason: 'station_control_caller_required',
      },
      {
        family: 'agent',
        tool: 'delete_agent',
        args: { slug: 'a' },
        caller: 'bound',
        answer: { status: 403, body: guardRefusal },
        sentence: GUARD_SENTENCE,
        code: 'station_control_caller_required',
        reason: 'station_control_caller_required',
      },
      {
        family: 'board',
        tool: 'board_pin',
        args: {
          reference: { kind: 'session', id: 's' },
          name: 'w',
          block: { type: 'card', body: 'hello' },
        },
        caller: 'bound',
        answer: { status: 403, body: guardRefusal },
        sentence: GUARD_SENTENCE,
        code: 'station_control_caller_required',
        reason: 'station_control_caller_required',
      },
      {
        family: 'catalog',
        tool: 'install_skill',
        args: { id: 'x' },
        caller: 'bound',
        answer: { status: 403, body: guardRefusal },
        sentence: GUARD_SENTENCE,
        code: 'station_control_caller_required',
        reason: 'station_control_caller_required',
      },
      {
        family: 'operations',
        tool: 'disable_job',
        args: { name: 'nightly' },
        caller: 'bound',
        answer: { status: 403, body: guardRefusal },
        sentence: GUARD_SENTENCE,
        code: 'station_control_caller_required',
        reason: 'station_control_caller_required',
      },
      {
        family: 'operations (indeterminate run)',
        tool: 'run_job',
        args: { name: 'nightly' },
        caller: 'bound',
        answer: { status: 409, body: indeterminate },
        sentence: INDETERMINATE_SENTENCE,
        code: 'scheduler_run_indeterminate',
        reason: 'scheduler_run_indeterminate',
      },
      {
        family: 'platform',
        tool: 'list_plugins',
        args: {},
        caller: 'bound',
        answer: { status: 403, body: guardRefusal },
        sentence: GUARD_SENTENCE,
        code: 'station_control_caller_required',
        reason: 'station_control_caller_required',
      },
      {
        family: 'delegation',
        tool: 'respond_to_task_request',
        args: { taskId: 'task-1', requestId: 'request-1', decision: 'accept' },
        caller: 'bound',
        answer: { status: 403, body: guardRefusal },
        sentence: 'could not resolve the delegated task request',
        code: 'station_control_caller_required',
        reason: 'station_control_caller_required',
      },
      {
        family: 'agent notification, no caller (notify_user)',
        tool: 'notify_user',
        args: { title: 'Build finished' },
        caller: 'none',
        answer: { status: 200, body: { status: 'sent' } },
        sentence: 'Tool call failed',
        reason: 'tool_failed',
      },
      {
        family: 'agent notification, guard refusal (notify_user)',
        tool: 'notify_user',
        args: { title: 'Build finished' },
        caller: 'bound',
        answer: { status: 403, body: guardRefusal },
        sentence: 'Tool call failed',
        code: 'station_control_caller_required',
        reason: 'station_control_caller_required',
      },
      {
        family: 'platform guidance (install_plugin)',
        tool: 'install_plugin',
        args: { source: './my-plugin' },
        caller: 'bound',
        answer: { status: 200, body: { success: true } },
        sentence: 'Station did not install ./my-plugin',
        reason: 'tool_failed',
      },
      {
        // The runtime's generic 500: no sentence, and a correlation id that
        // must reach neither the HTTP error nor the metric attribute.
        family: 'runtime internal error (forwarded envelope)',
        tool: 'get_usage',
        args: {},
        caller: 'bound',
        answer: {
          status: 500,
          body: {
            success: false,
            error: {
              code: 'internal_error',
              correlationId: 'corr-7f3a9c11-e2b4',
            },
          },
        },
        sentence: 'Tool call failed',
        reason: 'internal_error',
      },
      {
        // The runtime auth boundary's object error: its message is the
        // sentence, its code the reason.
        family: 'object error with a message (forwarded envelope)',
        tool: 'get_usage',
        args: {},
        caller: 'bound',
        answer: {
          status: 403,
          body: {
            error: { code: 'insufficient_scope', message: 'Scope is missing.' },
            success: false,
          },
        },
        sentence: 'Scope is missing.',
        reason: 'insufficient_scope',
      },
      {
        // A code that is not a bounded token never becomes the attribute.
        family: 'free-text code (forwarded envelope)',
        tool: 'get_usage',
        args: {},
        caller: 'bound',
        answer: {
          status: 409,
          body: {
            success: false,
            code: 'Retry after request 8841 finishes',
            error: 'Busy.',
          },
        },
        sentence: 'Busy.',
        reason: 'tool_failed',
      },
    ];

    test.each(rows)('$family: $tool', async (row) => {
      const { createStationControlMcpServer } = await import(
        '../../../tools/station-control-mcp-server.js'
      );
      const { withStationControlCallerContext, stationControlCallerPrincipal } =
        await import('../../../tools/station-control-shared.js');
      const { LOCAL_OPERATOR_PRINCIPAL_ID } = await import(
        '../../../services/identity/principal-resolver.js'
      );
      const handler = (
        createStationControlMcpServer() as unknown as {
          _registeredTools: Record<
            string,
            { handler: (args: unknown, extra?: unknown) => Promise<unknown> }
          >;
        }
      )._registeredTools[row.tool]!.handler;
      const previousBase = process.env.STATION_API_BASE;
      process.env.STATION_API_BASE = 'http://127.0.0.1:65009';
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: unknown) => {
          const url = String(input);
          const respond = (body: unknown, status: number) =>
            new Response(JSON.stringify(body), {
              status,
              headers: { 'content-type': 'application/json' },
            });
          if (url.endsWith('/.well-known/station/v1'))
            return respond(
              { environmentId: 'env-self', capabilities: {} },
              200,
            );
          return respond(row.answer.body, row.answer.status);
        }),
      );
      const execute = vi.fn((args: unknown) =>
        withStationControlCallerContext(
          {
            token: undefined,
            resolve: () =>
              row.caller === 'bound'
                ? {
                    sessionId: 'claims-operator',
                    assurance: 'bound' as const,
                    principal: stationControlCallerPrincipal(
                      LOCAL_OPERATOR_PRINCIPAL_ID,
                      'session-owner',
                    ),
                  }
                : null,
          },
          () => handler(args, {}),
        ),
      );
      vi.mocked(controlActions.add).mockClear();
      const toolName = `station-control_${row.tool}`;
      try {
        const ctx = createMockCtx({
          agentTools: new Map([
            [
              'default',
              [nativeControlTool({ name: 'stationControl_tool', execute })],
            ],
          ]),
          getOriginalToolName: vi.fn((name: string) =>
            name === 'stationControl_tool' ? toolName : name,
          ),
        });
        const res = await createInvokeRoutes(ctx as any).request(
          '/agents/station/tools/stationControl_tool',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(row.args),
          },
        );

        expect(execute).toHaveBeenCalledTimes(1);
        const toolResult = (await execute.mock.results[0]!.value) as {
          isError?: boolean;
          content: Array<{ text: string }>;
        };
        // The agent reads the whole envelope, typed code included.
        expect(toolResult.isError).toBe(true);
        if (row.code !== undefined)
          expect(JSON.parse(toolResult.content[0]!.text)).toMatchObject({
            code: row.code,
          });
        // The route answers a failure, in a sentence.
        expect(res.status).toBe(500);
        const body = (await json(res)) as { success: boolean; error: string };
        expect(body.success).toBe(false);
        expect(body.error).toContain(row.sentence);
        expect(body.error.trim().startsWith('{')).toBe(false);
        expect(body.error).not.toContain('corr-');
        expect(controlActions.add).toHaveBeenCalledTimes(1);
        const [, attributes] = vi.mocked(controlActions.add).mock.calls[0]!;
        // A bounded code or the fixed reason: never free text or an id.
        expect(attributes).toEqual({
          tool: toolName,
          outcome: 'failure',
          reason: row.reason,
        });
      } finally {
        vi.unstubAllGlobals();
        if (previousBase === undefined) delete process.env.STATION_API_BASE;
        else process.env.STATION_API_BASE = previousBase;
      }
    });
  });

  test('a station-control-named remote tool has no native-control exemption', async () => {
    const canary = 'remote-control-name-prefix-canary';
    vi.mocked(controlActions.add).mockClear();
    const ctx = createMockCtx({
      agentTools: new Map([
        [
          'default',
          [
            {
              name: 'station-control_impostor',
              execute: vi.fn().mockResolvedValue({
                isError: true,
                content: [{ type: 'text', text: canary }],
              }),
            },
          ],
        ],
      ]),
    });
    const app = createInvokeRoutes(ctx as any);

    const res = await app.request(
      '/agents/station/tools/station-control_impostor',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
    );

    expect(res.status).toBe(500);
    expect(JSON.stringify(await json(res))).not.toContain(canary);
    expect(
      JSON.stringify(
        Object.values(ctx.logger).map((logger) => logger.mock.calls),
      ),
    ).not.toContain(canary);
    expect(controlActions.add).not.toHaveBeenCalled();
  });

  test('holds the configuration commit lease through raw tool execution', async () => {
    let releaseTool!: () => void;
    let commitActive = false;
    const execute = vi.fn(() => {
      expect(commitActive).toBe(true);
      return new Promise<void>((resolve) => (releaseTool = resolve));
    });
    const commitAgentConfigurationRead = vi.fn(
      async (_revision: number, operation: () => Promise<unknown>) => {
        commitActive = true;
        try {
          return await operation();
        } finally {
          commitActive = false;
        }
      },
    );
    const ctx = createMockCtx({
      agentTools: new Map([['default', [{ name: 'slow-tool', execute }]]]),
      commitAgentConfigurationRead,
    });
    const app = createInvokeRoutes(ctx as any);

    const pending = app.request('/agents/station/tools/slow-tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(commitActive).toBe(true);
    releaseTool();

    expect((await pending).status).toBe(200);
    expect(commitActive).toBe(false);
  });
});
