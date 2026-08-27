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
      // Adapters execute only on a literal `true` (station#1834: a
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
      reason: 'create failed',
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
      reason: 'Delegated task request is not open',
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
