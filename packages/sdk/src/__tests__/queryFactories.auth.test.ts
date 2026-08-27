import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { agentQueries } from '../queryFactories';

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
});
