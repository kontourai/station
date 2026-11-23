import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@kontourai/station-sdk', () => ({
  agentQueries: {
    tools: (slug: string) => ({ queryKey: ['agent-tools', slug] }),
    stats: (slug: string, conversationId: string) => ({
      queryKey: ['stats', slug, conversationId],
    }),
  },
}));

/**
 * The /stats slash command renders the SAME ConversationStatsResponse the
 * stats modal renders, under the same section heading — so it must apply the
 * same cache-honesty rules (archive#4196): summed and "(uncached)" figures
 * only when the provider's declared inclusivity backs them, cache rows only
 * when reported, "Not reported" (never invented zeros) for absent figures.
 */
/** See `ConversationStatsModal.test.tsx`, which renders the same responses. */
const NO_USAGE = {
  turns: 1,
  toolCalls: 0,
  conversationId: 'station:1',
  modelId: '',
  modelStats: {},
  mcpServerTokens: 26_238,
  userMessageTokens: 3,
  contextFilesTokens: 0,
  measurement: { source: 'station-memory' },
};

const REPORTED_ZERO = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  contextTokens: 0,
  turns: 1,
  toolCalls: 0,
  estimatedCost: 0,
  engines: [
    {
      provider: 'claude',
      turns: 1,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCost: 0,
    },
  ],
  conversationId: 'conv',
  modelId: 'configured-model',
  modelStats: {},
  assistantMessageTokens: 0,
  measurement: { source: 'engine-events', provider: 'claude' },
};

describe('/stats cache-honest totals (station#4196)', () => {
  beforeEach(async () => {
    vi.resetModules();
    await import('../slashCommands/builtins');
  });

  async function renderStatsHtml(stats: Record<string, unknown>) {
    const { getCommand } = await import('../slashCommands/registry');
    const handler = getCommand('stats');
    expect(handler).toBeDefined();
    const addEphemeralMessage = vi.fn();
    await handler!({
      sessionId: 's1',
      chatState: { agentSlug: 'station', conversationId: 'c1' },
      addEphemeralMessage,
      queryClient: { fetchQuery: vi.fn(async () => stats) },
    } as any);
    expect(addEphemeralMessage).toHaveBeenCalledTimes(1);
    const [, message] = addEphemeralMessage.mock.calls[0];
    return message.content as string;
  }

  test('without an agent id it reports no usage instead of fetching stats', async () => {
    const { getCommand } = await import('../slashCommands/registry');
    const handler = getCommand('stats');
    const addEphemeralMessage = vi.fn();
    const fetchQuery = vi.fn();
    await handler!({
      sessionId: 's1',
      chatState: { conversationId: 'c1', messages: [] },
      addEphemeralMessage,
      queryClient: { fetchQuery },
    } as any);
    expect(fetchQuery).not.toHaveBeenCalled();
    expect(addEphemeralMessage).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        content: 'Messages: 0. No usage recorded yet.',
      }),
    );
  });

  test('the 212x fixture renders the backed cache-inclusive figures for a disjoint provider', async () => {
    // 3-turn cold-cache claude session from the archive#4048 audit probe:
    // input 30/45/60, cache_creation 9000/400/700, cache_read 0/9000/9400.
    const html = await renderStatsHtml({
      measurement: { source: 'engine-events', provider: 'claude' },
      inputTokens: 135,
      outputTokens: 600,
      totalTokens: 735,
      cacheReadTokens: 18_400,
      cacheWriteTokens: 10_100,
      turns: 3,
      messageCount: 6,
    });
    expect(html).toContain('In (uncached): <strong>135</strong>');
    expect(html).toContain('Cache read: <strong>18,400</strong>');
    expect(html).toContain('Cache write: <strong>10,100</strong>');
    expect(html).toContain('Prompt total: <strong>28,635</strong>');
    // The headline total includes cache — never the cache-exclusive 735
    // under a totality label.
    expect(html).toContain('Total: <strong>29,235</strong>');
    expect(html).not.toContain('Total: <strong>735</strong>');
  });

  test("an 'unverified' provider's figures are never summed", async () => {
    const html = await renderStatsHtml({
      measurement: { source: 'engine-events', provider: 'codex' },
      inputTokens: 3000,
      outputTokens: 500,
      totalTokens: 3500,
      cacheReadTokens: 900,
      turns: 1,
      messageCount: 2,
    });
    // Plain label — "(uncached)" would itself be an unbacked claim.
    expect(html).toContain('In: <strong>3,000</strong>');
    expect(html).not.toContain('In (uncached)');
    // Component disclosed separately; no Station-built sum anywhere.
    expect(html).toContain('Cache read: <strong>900</strong>');
    expect(html).not.toContain('Prompt total');
    expect(html).toContain('Total: <strong>3,500</strong>');
    expect(html).not.toContain('3,900');
    expect(html).not.toContain('4,400');
  });

  test('an absent-cache session gets no invented cache rows and "Not reported" for absent figures', async () => {
    const html = await renderStatsHtml({
      measurement: { source: 'engine-events', provider: 'claude' },
      inputTokens: 42,
      turns: 1,
      messageCount: 2,
    });
    // Declaration-backed qualifier survives without per-session cache.
    expect(html).toContain('In (uncached): <strong>42</strong>');
    expect(html).not.toContain('Cache read');
    expect(html).not.toContain('Cache write');
    expect(html).not.toContain('Prompt total');
    // Absent figures read "Not reported", never an invented zero.
    expect(html).toContain('Out: <strong>Not reported</strong>');
    expect(html).toContain('Total: <strong>Not reported</strong>');
    expect(html).not.toContain('Out: <strong>0</strong>');
    expect(html).not.toContain('Total: <strong>0</strong>');
  });

  test('a chat whose model reported no usage says so once, never $0.0000 or 0 (#5390)', async () => {
    // The stats route's response for a Station-agent chat whose model
    // reported no usage after one turn: Station counted the turn, nothing
    // reported tokens or cost, and the agent's prompt is unknown.
    const html = await renderStatsHtml(NO_USAGE);
    expect(html).not.toContain('Total LLM Consumption');
    expect(html).toContain(
      'The model did not report token counts for this chat.',
    );
    expect(html).toContain('Turns: <strong>1</strong>');
    expect(html).toContain('Total: <strong>Not reported</strong>');
    expect(html).toContain('Per Turn: <strong>Not reported</strong>');
    expect(html).not.toContain('$0.0000');
    // Only Station's own estimates that exist are listed.
    expect(html).not.toContain('System Prompt:');
    expect(html).not.toContain('Assistant Messages:');
    expect(html).toContain(
      'MCP Tools:</td><td style="text-align: right;">26,238<',
    );
  });

  test("an engine's chat lists only the breakdown rows the route sent, as the modal does (#5390)", async () => {
    // System prompt and tools are Station's estimates of its own prompt; an
    // external engine composed its own, so the route leaves them out rather
    // than this panel printing "Not reported" for them.
    const html = await renderStatsHtml(REPORTED_ZERO);
    expect(html).toContain(
      'Assistant Messages:</td><td style="text-align: right;">0<',
    );
    expect(html).not.toContain('System Prompt:');
    expect(html).not.toContain('MCP Tools:');
    expect(html).not.toContain('User Messages:');
    expect(html).not.toContain('Not reported');
  });

  test('a reported zero stays zero (#5390)', async () => {
    // The stats route's response after Claude Code reported a turn of zeros
    // and a zero cost (`conversation-stats-engine-change.routes.test.ts`).
    const html = await renderStatsHtml(REPORTED_ZERO);
    expect(html).toContain('In (uncached): <strong>0</strong>');
    expect(html).toContain('Out: <strong>0</strong>');
    expect(html).toContain('Total: <strong>0</strong>');
    expect(html).toContain('Total: <strong>$0.0000</strong>');
    expect(html).toContain('Per Turn: <strong>$0.0000</strong>');
    const consumption = html.slice(
      html.indexOf('Total LLM Consumption'),
      html.indexOf('Activity & Cost'),
    );
    expect(consumption).not.toContain('Not reported');
  });

  test('a model id from outside is escaped in the per-model rows', async () => {
    const html = await renderStatsHtml({
      ...REPORTED_ZERO,
      modelStats: {
        '<img src=x onerror=alert(1)>': { turns: 1, toolCalls: 0 },
      },
    });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  test('several engines that reported tokens each get their own rows, with no total across them (#5389)', async () => {
    // The stats route's response after Claude Code then Codex
    // (`conversation-stats-engine-change.routes.test.ts`).
    const html = await renderStatsHtml({
      conversationId: 'conv',
      modelId: 'codex-model',
      turns: 4,
      toolCalls: 0,
      estimatedCost: 0.25,
      modelStats: {},
      measurement: { source: 'engine-events', provider: 'codex' },
      engines: [
        {
          provider: 'claude',
          turns: 2,
          toolCalls: 0,
          inputTokens: 14,
          outputTokens: 11,
          totalTokens: 25,
          cacheReadTokens: 220,
          cacheWriteTokens: 20,
          estimatedCost: 0.25,
        },
        {
          provider: 'codex',
          turns: 2,
          toolCalls: 0,
          inputTokens: 700,
          outputTokens: 90,
          totalTokens: 790,
          cacheReadTokens: 500,
          modelId: 'codex-model',
        },
      ],
    });
    expect(html).toContain(
      'Each engine counts tokens its own way, so there is no total across engines',
    );
    const claude = html.slice(
      html.indexOf('<strong>Claude Code</strong>'),
      html.indexOf('<strong>Codex</strong>'),
    );
    expect(claude).toContain('In (uncached): <strong>14</strong>');
    expect(claude).toContain('Out: <strong>11</strong>');
    expect(claude).toContain('Total: <strong>265</strong>');
    const codex = html.slice(html.indexOf('<strong>Codex</strong>'));
    expect(codex).toContain('In: <strong>700</strong>');
    expect(codex).toContain('Total: <strong>790</strong>');
    // The engines reported their tokens: nothing in the section says
    // otherwise.
    const consumption = html.slice(
      html.indexOf('Total LLM Consumption'),
      html.indexOf('Activity & Cost'),
    );
    expect(consumption).not.toContain('Not reported');
    expect(html).toContain('Total: <strong>$0.2500</strong>');
  });
});
