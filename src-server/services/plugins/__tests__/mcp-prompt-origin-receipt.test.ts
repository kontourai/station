import { expect, test, vi } from 'vitest';
import {
  issueMcpPromptOrigin,
  verifyMcpPromptOrigin,
} from '../mcp-prompt-origin-receipt.js';
import { runAgentMcpPrompt } from '../mcp-prompts.js';

test('prompt origin proof binds source, text, classification and expiry', () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const origin = issueMcpPromptOrigin('mail', 'summarize', 'message', true);
    expect(verifyMcpPromptOrigin(origin, 'message')).toEqual({
      serverId: 'mail',
      name: 'summarize',
      untrusted: true,
    });
    expect(() => verifyMcpPromptOrigin(origin, 'different')).toThrow(
      /invalid or expired/,
    );
    expect(() =>
      verifyMcpPromptOrigin({ ...origin, serverId: 'other' }, 'message'),
    ).toThrow(/invalid or expired/);
    expect(() =>
      verifyMcpPromptOrigin(
        { ...origin, receipt: `${origin.receipt}x` },
        'message',
      ),
    ).toThrow(/invalid or expired/);
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    expect(() => verifyMcpPromptOrigin(origin, 'message')).toThrow(
      /invalid or expired/,
    );
  } finally {
    vi.useRealTimers();
  }
});

test('a prompt read as untrusted stays marked if its classification changes before send', async () => {
  const source = {
    listMCPPrompts: vi.fn().mockResolvedValue([{ name: 'summarize' }]),
    getMCPPrompt: vi
      .fn()
      .mockResolvedValue({
        messages: [
          { role: 'user', content: { type: 'text', text: 'mail content' } },
        ],
      }),
    getIntegration: vi
      .fn()
      .mockResolvedValueOnce({
        id: 'mail',
        kind: 'mcp',
        contentTrust: 'untrusted',
      })
      .mockResolvedValueOnce({
        id: 'mail',
        kind: 'mcp',
        contentTrust: 'trusted',
      }),
  };
  const result = await runAgentMcpPrompt(
    {
      name: 'agent',
      prompt: '',
      tools: { mcpServers: ['mail'], available: ['*'] },
    },
    source,
    { serverId: 'mail', name: 'summarize', arguments: {} },
  );
  expect(
    verifyMcpPromptOrigin(
      {
        serverId: result.serverId,
        name: result.name,
        receipt: result.originReceipt!,
      },
      result.text,
    ).untrusted,
  ).toBe(true);
});
