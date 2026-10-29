/**
 * @vitest-environment jsdom
 *
 * "Send again" on a failed turn resends that turn's attachments through
 * `handleSend(text, attachments)`. Those files were recovered from the
 * transcript and never staged in this composer (the original stage was
 * released when the turn was accepted), and the foreground dispatch refuses
 * any attachment without a completed supervised stage. The resend must stage
 * them through the composer's own queue first, then send their references.
 *
 * Staging runs against the real `AttachmentStagingService`, which refuses a
 * clientAttachmentId its login already staged. Recovered ids
 * (`retry-<index>-<n>`) repeat across chats and repeated clicks.
 */

import { EXECUTION_MODE } from '@kontourai/station-contracts/tool';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AttachmentStagingService } from '../../../src-server/services/orchestration/attachment-staging-service.js';
import type { FileAttachment } from '../types';

const sdk = vi.hoisted(() => ({
  sendExecutionMessage: vi.fn(),
  prepareAttachmentStage: vi.fn(),
  uploadAttachmentStage: vi.fn(),
  dispatchErrors: [] as unknown[],
  showToast: vi.fn(),
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
  useToast: () => ({ showToast: sdk.showToast }),
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
      attachments: FileAttachment[],
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
          clientTurnId: `turn-${sessionId}`,
        });
        activeChatsStore.updateChat(sessionId, {
          attachments: [],
          attachmentStages: [],
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

const CHAT_A = 'codex:send-again-a';
const CHAT_B = 'codex:send-again-b';

/** What `findPrecedingUserTurn` recovers for a chat's first failed turn. */
const recovered: FileAttachment = {
  id: 'retry-0-0',
  name: 'notes.txt',
  type: 'text/plain',
  size: 5,
  data: 'data:text/plain;base64,aGVsbG8=',
};

function renderChatInput(sessionId: string) {
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
        sessionId,
        agentSlug: 'codex',
        conversationId: sessionId,
        availableModels: [],
        attachmentCapabilities: { images: true, files: true },
      }),
    { wrapper },
  );
}

function initChat(sessionId: string) {
  activeChatsStore.removeChat(sessionId);
  activeChatsStore.initChat(sessionId, {
    agentSlug: 'codex',
    agentName: 'Codex',
    title: 'resend',
    conversationId: sessionId,
  });
  activeChatsStore.updateChat(sessionId, {
    executionMode: EXECUTION_MODE.EXTERNAL,
  });
}

function sentRefs(call: number) {
  return sdk.sendExecutionMessage.mock.calls[call]![1].attachmentRefs as {
    stageId: string;
    clientAttachmentId: string;
  }[];
}

describe('Send again with a recovered attachment', () => {
  let staging: AttachmentStagingService;
  const stagingRefusals: string[] = [];

  beforeEach(() => {
    localStorage.clear();
    initChat(CHAT_A);
    initChat(CHAT_B);
    sdk.dispatchErrors.length = 0;
    stagingRefusals.length = 0;
    staging = new AttachmentStagingService();
    // One login: the server keys stages per user, across all of its chats.
    const owner = { principalId: 'operator' };
    sdk.prepareAttachmentStage.mockImplementation(
      async (
        _apiBase: string,
        input: {
          clientAttachmentId: string;
          kind: 'file' | 'image';
          name: string;
          mimeType: 'text/plain';
          size: number;
        },
      ) => {
        try {
          return staging.prepare(owner, {
            clientAttachmentId: input.clientAttachmentId,
            kind: input.kind,
            name: input.name,
            mimeType: input.mimeType,
            size: input.size,
          });
        } catch (refusal) {
          stagingRefusals.push((refusal as Error).message);
          throw refusal;
        }
      },
    );
    sdk.uploadAttachmentStage.mockImplementation(
      async (
        _apiBase: string,
        preparation: { stageId: string; uploadGrant: string },
        dataUrl: string,
      ) =>
        staging.upload(preparation.stageId, preparation.uploadGrant, dataUrl),
    );
    sdk.sendExecutionMessage.mockResolvedValue({ conversationId: CHAT_A });
  });

  afterEach(async () => {
    const { chatDraftsStore } = await import('../contexts/chat-drafts-store');
    chatDraftsStore.consumeQuotes(CHAT_A, chatDraftsStore.getQuotes(CHAT_A));
    staging.dispose();
    activeChatsStore.removeChat(CHAT_A);
    activeChatsStore.removeChat(CHAT_B);
    localStorage.clear();
    vi.clearAllMocks();
  });

  test('stages the recovered file, then sends its staged reference', async () => {
    const { result } = renderChatInput(CHAT_A);

    await act(async () => {
      await result.current.handleSend('look at this', [recovered]);
    });

    expect(stagingRefusals).toEqual([]);
    expect(sdk.dispatchErrors).toEqual([]);
    expect(sdk.sendExecutionMessage).toHaveBeenCalledTimes(1);
    expect(sdk.sendExecutionMessage.mock.calls[0]![1].message).toBe(
      'look at this',
    );
    const [ref] = sentRefs(0);
    expect(ref!.stageId).toMatch(/^stage_/);
  });

  test('two chats that each resend their first turn both send', async () => {
    const a = renderChatInput(CHAT_A);
    const b = renderChatInput(CHAT_B);

    await act(async () => {
      await a.result.current.handleSend('first chat', [recovered]);
    });
    await act(async () => {
      await b.result.current.handleSend('second chat', [{ ...recovered }]);
    });

    expect(stagingRefusals).toEqual([]);
    expect(sdk.dispatchErrors).toEqual([]);
    expect(activeChatsStore.getSnapshot()[CHAT_B]?.attachmentStages).toEqual(
      [],
    );
    expect(sdk.sendExecutionMessage).toHaveBeenCalledTimes(2);
    expect(sentRefs(1)[0]!.stageId).not.toBe(sentRefs(0)[0]!.stageId);
  });

  test('pressing Send again twice in one chat sends twice', async () => {
    const { result } = renderChatInput(CHAT_A);

    await act(async () => {
      await result.current.handleSend('again', [recovered]);
    });
    await act(async () => {
      await result.current.handleSend('again', [recovered]);
    });

    expect(stagingRefusals).toEqual([]);
    expect(sdk.dispatchErrors).toEqual([]);
    expect(sdk.sendExecutionMessage).toHaveBeenCalledTimes(2);
  });

  test('a failed upload restores the recovered text, not the composed one', async () => {
    sdk.uploadAttachmentStage.mockRejectedValue(new Error('upload dropped'));
    const { chatDraftsStore } = await import('../contexts/chat-drafts-store');
    chatDraftsStore.addQuote(CHAT_A, {
      version: 1,
      origin: 'http://station.test',
      sessionId: CHAT_A,
      turnId: 'turn-1',
      messageId: 'message-1',
      revision: 'a'.repeat(64),
      excerpt: 'quoted line',
    });
    const { result } = renderChatInput(CHAT_A);

    await act(async () => {
      await result.current.handleSend('look at this', [recovered]);
    });

    expect(sdk.sendExecutionMessage).not.toHaveBeenCalled();
    const chat = activeChatsStore.getSnapshot()[CHAT_A]!;
    expect(chat.input).toBe('look at this');
    expect(chat.attachmentStages).toEqual([
      expect.objectContaining({ state: 'retryable' }),
    ]);
    expect(chat.attachments?.map((attachment) => attachment.name)).toEqual([
      'notes.txt',
    ]);
  });

  test('a failed upload keeps an existing draft and says so', async () => {
    sdk.uploadAttachmentStage.mockRejectedValue(new Error('upload dropped'));
    activeChatsStore.updateChat(CHAT_A, { input: 'my next message' });
    const { result } = renderChatInput(CHAT_A);

    await act(async () => {
      await result.current.handleSend('look at this', [recovered]);
    });

    expect(sdk.sendExecutionMessage).not.toHaveBeenCalled();
    expect(activeChatsStore.getSnapshot()[CHAT_A]!.input).toBe(
      'my next message',
    );
    expect(sdk.showToast).toHaveBeenCalledWith(
      'An attachment did not upload. Your draft was kept with the attachment; retry it in the composer, then send.',
      'error',
    );
  });
});
