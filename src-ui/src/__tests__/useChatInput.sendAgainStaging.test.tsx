/**
 * @vitest-environment jsdom
 *
 * "Send again" on a failed turn resends that turn's attachments through
 * `handleSend(text, attachments)`. Those files were recovered from the
 * transcript and never staged in this composer (the original stage was
 * released when the turn was accepted), and the foreground dispatch refuses
 * any attachment without a completed supervised stage. The resend must stage
 * them through the composer's own queue first, then send their references.
 */

import { EXECUTION_MODE } from '@kontourai/station-contracts/tool';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  sendExecutionMessage: vi.fn(),
  prepareAttachmentStage: vi.fn(),
  uploadAttachmentStage: vi.fn(),
  dispatchErrors: [] as unknown[],
}));

vi.mock('@kontourai/station-sdk/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk/client')>()),
  sendExecutionMessage: sdk.sendExecutionMessage,
  assertClientRawEgressAllowed: () => undefined,
  getAttachmentStagingCapability: async () => ({ state: 'supported' }),
  prepareAttachmentStage: sdk.prepareAttachmentStage,
  uploadAttachmentStage: sdk.uploadAttachmentStage,
  xhrAttachmentStageUpload: vi.fn(),
  reconcileAttachmentStages: async () => [],
  cancelAttachmentStage: async () => undefined,
}));

vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [],
  useAgent: () => ({ slug: 'codex', name: 'Codex' }),
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useSkillsQuery: () => ({ data: [] }),
  useProviderCommandsQuery: () => ({ data: [] }),
  useRunSkill: () => ({ mutateAsync: vi.fn() }),
  useSkillDetailReader: () => vi.fn(),
  agentMcpPromptsQueryKey: (slug: string) => ['agent-mcp-prompts', slug],
  runAgentMcpPrompt: vi.fn(),
  useAgentMcpPromptsQuery: () => ({ data: undefined }),
}));
vi.mock('../contexts/ActiveChatsContext', async () => {
  const { activeChatsStore } = await import('../contexts/active-chats-store');
  return {
    useActiveChatActions: () => ({
      updateChat: activeChatsStore.updateChat.bind(activeChatsStore),
      clearInput: activeChatsStore.clearInput.bind(activeChatsStore),
      addToInputHistory:
        activeChatsStore.addToInputHistory.bind(activeChatsStore),
    }),
    useActiveChatSelector: (
      sessionId: string,
      selector: (s: unknown) => unknown,
    ) => selector(activeChatsStore.getSnapshot()[sessionId] || null),
  };
});
// The messaging hook hands the chat's stored stages to the real foreground
// dispatch (`useActiveChatSessionMessaging`: `attachmentStages:
// currentState?.attachmentStages`); this stand-in does exactly that.
vi.mock('../hooks/useActiveChatSessions', () => ({
  useSendMessage:
    () =>
    async (
      sessionId: string,
      agentSlug: string,
      conversationId: string | undefined,
      message: string,
      attachments: import('../types').FileAttachment[],
    ) => {
      const { dispatchForeground } = await import(
        '../lib/foregroundMessageDispatch'
      );
      const { activeChatsStore } = await import(
        '../contexts/active-chats-store'
      );
      try {
        await dispatchForeground({
          apiBase: 'http://station.test',
          sessionId,
          agentSlug,
          conversationId,
          message,
          attachments,
          attachmentStages:
            activeChatsStore.getSnapshot()[sessionId]?.attachmentStages,
          clientTurnId: 'turn-resend',
        });
        return true;
      } catch (error) {
        sdk.dispatchErrors.push(error);
        return false;
      }
    },
  useCancelMessage: () => vi.fn(),
}));

import { activeChatsStore } from '../contexts/active-chats-store';
import { useChatInput } from '../hooks/useChatInput';

const SESSION_ID = 'codex:send-again-staging';

const recovered = {
  id: 'retry-3-0',
  name: 'screenshot.png',
  type: 'image/png',
  size: 5,
  data: 'data:image/png;base64,aGVsbG8=',
};

function renderChatInput() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(
    () =>
      useChatInput({
        apiBase: 'http://station.test',
        sessionId: SESSION_ID,
        agentSlug: 'codex',
        conversationId: SESSION_ID,
        availableModels: [],
        attachmentCapabilities: { images: true, files: true },
      }),
    { wrapper },
  );
}

describe('Send again with a recovered attachment', () => {
  beforeEach(() => {
    localStorage.clear();
    activeChatsStore.removeChat(SESSION_ID);
    activeChatsStore.initChat(SESSION_ID, {
      agentSlug: 'codex',
      agentName: 'Codex',
      title: 'resend',
      conversationId: SESSION_ID,
    });
    activeChatsStore.updateChat(SESSION_ID, {
      executionMode: EXECUTION_MODE.EXTERNAL,
    });
    sdk.dispatchErrors.length = 0;
    sdk.sendExecutionMessage.mockResolvedValue({ conversationId: SESSION_ID });
    sdk.prepareAttachmentStage.mockResolvedValue({ stageId: 'stage-2' });
    sdk.uploadAttachmentStage.mockResolvedValue({
      stageId: 'stage-2',
      clientAttachmentId: recovered.id,
      source: 'current-composer',
      kind: 'image',
      name: recovered.name,
      mimeType: 'image/png',
      size: 5,
      digest: 'sha256-abc',
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
  });

  afterEach(() => {
    activeChatsStore.removeChat(SESSION_ID);
    localStorage.clear();
    vi.clearAllMocks();
  });

  test('stages the recovered file, then sends its staged reference', async () => {
    const { result } = renderChatInput();

    await act(async () => {
      await result.current.handleSend('look at this', [recovered]);
    });

    expect(sdk.dispatchErrors).toEqual([]);
    expect(sdk.prepareAttachmentStage).toHaveBeenCalledTimes(1);
    expect(sdk.uploadAttachmentStage).toHaveBeenCalledWith(
      'http://station.test',
      { stageId: 'stage-2' },
      recovered.data,
      expect.anything(),
    );
    expect(sdk.sendExecutionMessage).toHaveBeenCalledTimes(1);
    const sent = sdk.sendExecutionMessage.mock.calls[0]![1];
    expect(sent.message).toBe('look at this');
    expect(sent.attachmentRefs).toEqual([
      expect.objectContaining({
        stageId: 'stage-2',
        clientAttachmentId: recovered.id,
      }),
    ]);
  });

  test('a stage that fails leaves the turn in the composer and sends nothing', async () => {
    sdk.uploadAttachmentStage.mockRejectedValue(new Error('upload dropped'));
    const { result } = renderChatInput();

    await act(async () => {
      await result.current.handleSend('look at this', [recovered]);
    });

    expect(sdk.sendExecutionMessage).not.toHaveBeenCalled();
    const chat = activeChatsStore.getSnapshot()[SESSION_ID]!;
    expect(chat.input).toBe('look at this');
    expect(chat.attachments?.map((attachment) => attachment.id)).toEqual([
      recovered.id,
    ]);
    expect(chat.attachmentStages).toEqual([
      expect.objectContaining({
        clientAttachmentId: recovered.id,
        state: 'retryable',
      }),
    ]);
  });
});
