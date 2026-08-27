// @vitest-environment jsdom

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { describe, expect, test, vi } from 'vitest';

const sendExecutionMessageRequest = vi.hoisted(() => vi.fn());

vi.mock('@kontourai/station-sdk/client', () => ({
  sendExecutionMessage: (...args: unknown[]) =>
    sendExecutionMessageRequest(...args),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useOrchestrationProvidersQuery: vi.fn(),
  useQueryClient: vi.fn(),
}));

import { sendExecutionMessage } from '../useOrchestration';

describe('sendExecutionMessage', () => {
  test('forwards a supervised staged reference to the SDK request seam', async () => {
    const reference = {
      stageId: 'stage-1',
      clientAttachmentId: 'file-1',
      source: 'current-composer' as const,
      kind: 'file' as const,
      name: 'notes.txt',
      mimeType: 'text/plain' as const,
      size: 2,
      digest: `sha256-${'a'.repeat(64)}` as const,
      expiresAt: '2030-01-01T00:00:00.000Z',
    };
    sendExecutionMessageRequest.mockResolvedValueOnce({
      conversationId: 'conversation-1',
      sessionId: 'session-1',
      providerTurnId: 'turn-1',
    });

    await sendExecutionMessage({
      apiBase: 'http://station.test',
      target: { agent: agentId('claude') },
      message: 'Use this.',
      attachmentRefs: [reference],
    });

    expect(sendExecutionMessageRequest).toHaveBeenCalledWith(
      'http://station.test',
      expect.objectContaining({ attachmentRefs: [reference] }),
      expect.anything(),
    );
  });
});
