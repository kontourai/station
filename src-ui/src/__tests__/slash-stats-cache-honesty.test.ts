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
 * when reported, dashes (never invented zeros) for absent figures.
 */
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

  test('an absent-cache session gets no invented cache rows and dashes for absent figures', async () => {
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
    // Absent figures render as the shared dash, never an invented zero.
    expect(html).toContain('Out: <strong>—</strong>');
    expect(html).toContain('Total: <strong>—</strong>');
    expect(html).not.toContain('Out: <strong>0</strong>');
    expect(html).not.toContain('Total: <strong>0</strong>');
  });
});
