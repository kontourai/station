import type { EnrichedAgentProjection } from '@kontourai/station-contracts/enriched-agent';
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type {
  ConversationSummary,
  OrchestrationProviderSummary,
} from '../query-domains/chatRuntimeTypes';

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://example.test'),
}));
const { authenticatedFetchMock } = vi.hoisted(() => ({
  authenticatedFetchMock: vi.fn(),
}));
vi.mock('../client/http', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  authenticatedFetch: authenticatedFetchMock,
}));

import {
  agentQueries,
  conversationQueries,
  orchestrationQueries,
} from '../queryFactories';

describe('query factories authenticate (station#2614)', () => {
  beforeEach(() => {
    authenticatedFetchMock.mockReset();
    // A plain global fetch would bypass auth — make any use of it loud.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('unauthenticated fetch used by a query factory');
      }),
    );
  });

  it('conversation stats go through authenticatedFetch, never bare fetch', async () => {
    const stats = {
      inputTokens: 1,
      outputTokens: 0,
      totalTokens: 1,
      turns: 1,
      toolCalls: 0,
      estimatedCost: 0,
      modelId: 'test-model',
      systemPromptTokens: 0,
      mcpServerTokens: 0,
      userMessageTokens: 1,
      assistantMessageTokens: 0,
      contextFilesTokens: 0,
    };
    authenticatedFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: stats }),
    } as Response);

    const result = await agentQueries.stats('codex', 'conv-1').queryFn();

    expect(result).toEqual(stats);
    expect(authenticatedFetchMock).toHaveBeenCalledWith(
      'http://example.test/agents/codex/conversations/conv-1/stats',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects malformed stats but accepts an omitted unknown percentage', async () => {
    authenticatedFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: { totalTokens: Number.NaN } }),
    } as Response);
    await expect(agentQueries.stats('codex', 'bad').queryFn()).rejects.toThrow(
      'Invalid conversation stats response',
    );
  });

  it('validates every nested model stat while accepting a valid multi-model response', async () => {
    const base = {
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
      turns: 1,
      toolCalls: 0,
      estimatedCost: 0,
      modelId: 'current',
      systemPromptTokens: 0,
      mcpServerTokens: 0,
      userMessageTokens: 1,
      assistantMessageTokens: 2,
      contextFilesTokens: 0,
    };
    const model = {
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
      contextTokens: 3,
      turns: 1,
      toolCalls: 0,
      estimatedCost: 0,
    };
    authenticatedFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          ...base,
          modelStats: { first: model, second: { ...model, totalTokens: 4 } },
        },
      }),
    } as Response);
    await expect(
      agentQueries.stats('codex', 'valid').queryFn(),
    ).resolves.toMatchObject({
      modelStats: { first: model },
    });

    authenticatedFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          ...base,
          modelStats: { broken: { ...model, contextTokens: Number.NaN } },
        },
      }),
    } as Response);
    await expect(
      agentQueries.stats('codex', 'invalid').queryFn(),
    ).rejects.toThrow('Invalid conversation stats response');
  });

  it('rejects exotic modelStats containers but accepts a null-prototype record', async () => {
    const base = {
      inputTokens: 1,
      outputTokens: 0,
      totalTokens: 1,
      turns: 1,
      toolCalls: 0,
      estimatedCost: 0,
      modelId: 'current',
      systemPromptTokens: 0,
      mcpServerTokens: 0,
      userMessageTokens: 1,
      assistantMessageTokens: 0,
      contextFilesTokens: 0,
    };
    authenticatedFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: { ...base, modelStats: new Date() },
      }),
    } as Response);
    await expect(
      agentQueries.stats('codex', 'exotic').queryFn(),
    ).rejects.toThrow('Invalid conversation stats response');

    const modelStats = Object.assign(Object.create(null), {
      current: {
        inputTokens: 1,
        outputTokens: 0,
        totalTokens: 1,
        contextTokens: 1,
        turns: 1,
        toolCalls: 0,
        estimatedCost: 0,
      },
    });
    authenticatedFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: { ...base, modelStats } }),
    } as Response);
    await expect(
      agentQueries.stats('codex', 'null-prototype').queryFn(),
    ).resolves.toMatchObject({
      modelStats: { current: { totalTokens: 1 } },
    });
  });

  it('keeps typed Agent, tool, conversation and provider data without changing authenticated paths', async () => {
    const agent = { slug: 'agent/one', name: 'One' };
    authenticatedFetchMock.mockResolvedValueOnce(
      Response.json({ success: true, data: agent }),
    );
    const detail = await agentQueries.agent('agent/one').queryFn();
    expectTypeOf(detail).toEqualTypeOf<EnrichedAgentProjection>();
    expect(detail).toEqual(agent);
    expect(authenticatedFetchMock).toHaveBeenLastCalledWith(
      'http://example.test/api/agents/agent%2Fone',
    );
    const tools = [{ id: 'lookup', name: 'lookup', server: null }];
    authenticatedFetchMock.mockResolvedValueOnce(
      Response.json({ success: true, data: tools }),
    );
    const toolData = await agentQueries.tools('one').queryFn();
    expectTypeOf(toolData).toEqualTypeOf<unknown[]>();
    expect(toolData).toEqual(tools);
    const conversations = [
      { id: 'conversation', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    ];
    for (const data of [conversations, { items: conversations }]) {
      authenticatedFetchMock.mockResolvedValueOnce(
        Response.json({ success: true, data }),
      );
      const listed = await conversationQueries.list('agent/one').queryFn();
      expectTypeOf(listed).toEqualTypeOf<ConversationSummary[]>();
      expect(listed).toEqual(conversations);
    }
    authenticatedFetchMock.mockResolvedValueOnce(
      Response.json({ success: true }),
    );
    expect(await conversationQueries.list('one').queryFn()).toEqual([]);
    const providers = [
      { provider: 'codex', activeSessions: 0, prerequisites: [] },
    ];
    authenticatedFetchMock.mockResolvedValueOnce(
      Response.json({ success: true, data: providers }),
    );
    const available = await orchestrationQueries.providers().queryFn();
    expectTypeOf(available).toEqualTypeOf<OrchestrationProviderSummary[]>();
    expect(available).toEqual(providers);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves Agent HTTP precedence and successful-HTTP envelope failures', async () => {
    for (const [status, message] of [
      [404, 'Agent not found'],
      [500, 'Failed to fetch agent'],
    ] as const) {
      authenticatedFetchMock.mockResolvedValueOnce(
        Response.json({ success: false, error: 'server detail' }, { status }),
      );
      await expect(agentQueries.agent('one').queryFn()).rejects.toThrow(
        message,
      );
    }
    authenticatedFetchMock.mockResolvedValueOnce(
      Response.json({ success: false, error: 'Envelope refusal' }),
    );
    await expect(agentQueries.agent('one').queryFn()).rejects.toThrow(
      'Envelope refusal',
    );
    authenticatedFetchMock.mockResolvedValueOnce(
      Response.json(
        {
          success: false,
          error: 'Validation failed',
          details: { formErrors: ['Action unavailable'] },
        },
        { status: 400 },
      ),
    );
    await expect(orchestrationQueries.providers().queryFn()).rejects.toThrow(
      'Action unavailable',
    );
  });

  it('keeps tools status and server detail while accepting unknown or malformed failure bodies', async () => {
    for (const status of [409, 503]) {
      authenticatedFetchMock.mockResolvedValueOnce(
        Response.json({ error: 'Server tools detail' }, { status }),
      );
      await expect(agentQueries.tools('one').queryFn()).rejects.toMatchObject({
        message: 'Server tools detail',
        status,
        activating: status === 503,
      });
    }
    authenticatedFetchMock.mockResolvedValueOnce(
      Response.json(null, { status: 503 }),
    );
    await expect(agentQueries.tools('one').queryFn()).rejects.toMatchObject({
      status: 503,
      activating: true,
      message: 'Agent tools are not available yet; it is still activating.',
    });
    authenticatedFetchMock.mockResolvedValueOnce(
      new Response('not json', { status: 500 }),
    );
    await expect(agentQueries.tools('one').queryFn()).rejects.toMatchObject({
      status: 500,
      activating: false,
      message: 'Failed to fetch tools',
    });
  });
});
