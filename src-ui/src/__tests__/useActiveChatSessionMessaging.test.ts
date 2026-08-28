/** @vitest-environment jsdom */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const outboundQueueMode = vi.hoisted(() => ({ useActual: false }));

class CodedOrchestrationError extends Error {
  constructor(
    readonly status: number,
    readonly serverMessage: string,
    readonly code: string,
  ) {
    super(serverMessage);
  }
}

const sendExecutionMessageMock = vi.fn();
vi.mock('../hooks/useOrchestration', () => ({
  sendExecutionMessage: (...args: unknown[]) =>
    sendExecutionMessageMock(...args),
}));

const updateChatMock = vi.fn((sessionId: string, updates: unknown) => {
  activeChatsStore.updateChat(sessionId, updates as never);
});
const clearInputMock = vi.fn((sessionId: string) => {
  activeChatsStore.clearInput(sessionId);
});
const assignConversationIdMock = vi.fn(
  (sessionId: string, conversationId: string) => {
    activeChatsStore.assignConversationId(sessionId, conversationId);
  },
);
const addEphemeralMessageMock = vi.fn((sessionId: string, message: unknown) => {
  activeChatsStore.addEphemeralMessage(sessionId, message as never);
});
const clearEphemeralMessagesMock = vi.fn((sessionId: string) => {
  activeChatsStore.clearEphemeralMessages(sessionId);
});

vi.mock('../contexts/ActiveChatsContext', () => ({
  useActiveChatActions: () => ({
    updateChat: updateChatMock,
    clearInput: clearInputMock,
    assignConversationId: assignConversationIdMock,
    addEphemeralMessage: addEphemeralMessageMock,
    clearEphemeralMessages: clearEphemeralMessagesMock,
  }),
}));

vi.mock('../hooks/useStreamingMessage', () => ({
  useStreamingMessage: () => ({ clearStreamingMessage: vi.fn() }),
}));

const agentConnectionsMock = vi.fn(() => ({ data: [] as unknown[] }));
const cooperativeStop = {
  outcome: 'cooperative' as const,
  threadId: 'server-thread-1',
  turnId: 'turn-1',
};
const interruptOrchestrationTurnMock = vi
  .fn()
  .mockResolvedValue(cooperativeStop);
// archive#1146: stable across renders so a test can assert WHICH query keys
// were invalidated. A fresh `vi.fn` per `useInvalidateQuery` call records
// nothing an assertion can reach.
const invalidateMock = vi.fn();
// `isProvablyNotSent` is deliberately the REAL implementation, not a stub:
// it is the one derivation that decides whether a failed Stop reads "Stop
// failed" (the request provably never left this browser) or the honest
// indeterminate state, and a stub would let the hook pass while wired to
// nothing.
vi.mock('@kontourai/station-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@kontourai/station-sdk')>();
  return {
    conversationQueries: {
      inventory: () => ({ queryKey: ['conversation-inventory'] }),
    },
    useAgentConnectionsQuery: () => agentConnectionsMock(),
    useInvalidateQuery: () => invalidateMock,
    interruptOrchestrationTurn: (...args: unknown[]) =>
      interruptOrchestrationTurnMock(...args),
    isProvablyNotSent: actual.isProvablyNotSent,
  };
});

const enqueueOutboundTurnMock = vi.fn().mockResolvedValue(undefined);
const discardOutboundTurnMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../lib/outboundQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/outboundQueue')>();
  return {
    ...actual,
    outboundDispatch: {
      ...actual.outboundDispatch,
      enqueue: (...args: Parameters<typeof actual.outboundDispatch.enqueue>) =>
        outboundQueueMode.useActual
          ? actual.outboundDispatch.enqueue(...args)
          : enqueueOutboundTurnMock(...args),
      discard: (...args: Parameters<typeof actual.outboundDispatch.discard>) =>
        outboundQueueMode.useActual
          ? actual.outboundDispatch.discard(...args)
          : discardOutboundTurnMock(...args),
    },
  };
});

import { shouldBindPanelProjectContext } from '../components/acp-connections/project-context-binding';
import {
  activeChatDurableId,
  hydrateActiveChats,
  serializeActiveChats,
} from '../contexts/active-chats-state';
import { activeChatsStore } from '../contexts/active-chats-store';
import {
  describeStopTurnOutcome,
  type StopTurnOutcome,
  useCancelMessage,
  useSendMessage,
} from '../hooks/useActiveChatSessionMessaging';
import {
  _resetOutboundQueueStorage,
  _setOutboundQueueStorage,
  type OutboundDispatchClaim,
  outboundDispatch,
  type QueuedOutboundTurn,
} from '../lib/outboundQueue';

const sessionId = 'chat-session-1';

function successReceipt(conversationId = sessionId) {
  return {
    conversationId,
    sessionId: conversationId,
    providerTurnId: 'provider-turn-success',
    target: { kind: 'agent', id: 'codex' },
    resolution: {},
  };
}

const stagedAttachment = {
  id: 'staged-file',
  name: 'notes.txt',
  type: 'text/plain',
  size: 2,
  data: 'data:text/plain;base64,aGk=',
};

const stagedSnapshot = {
  clientAttachmentId: 'staged-file',
  name: 'notes.txt',
  mimeType: 'text/plain',
  size: 2,
  state: 'complete' as const,
  progress: 1,
  delivery: 'staged' as const,
  stageId: 'stage-1',
  reference: {
    stageId: 'stage-1',
    clientAttachmentId: 'staged-file',
    source: 'current-composer' as const,
    kind: 'file' as const,
    name: 'notes.txt',
    mimeType: 'text/plain' as const,
    size: 2,
    digest: `sha256-${'a'.repeat(64)}` as const,
    expiresAt: '2030-01-01T00:00:00.000Z',
  },
};

describe('useSendMessage canonical ExecutionTarget path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    outboundQueueMode.useActual = false;
    sendExecutionMessageMock.mockResolvedValue(successReceipt());
    activeChatsStore.initChat(sessionId, {
      agentSlug: 'codex',
      agentName: 'Codex',
      title: 'New chat',
      projectSlug: 'station',
      agentConnectionId: 'connection-that-ui-must-not-route',
      provider: 'claude',
      model: 'gpt-5.6-codex',
      providerOptions: { reasoningEffort: 'high' },
// A reconnect can update these reported fields before the user sends.
// The picker-owned request must still win at the send seam.
      requestedModel: 'gpt-5.6-codex-requested',
      requestedProviderOptions: { reasoningEffort: 'low' },
    });
  });

  afterEach(() => {
    outboundQueueMode.useActual = false;
    _resetOutboundQueueStorage();
    activeChatsStore.removeChat(sessionId);
  });

  it('leaves a project environment unresolved while sending Agent + model/workspace', async () => {
    const attachment = {
      id: 'screen-1',
      name: 'screen.png',
      type: 'image/png',
      size: 3,
      data: 'data:image/png;base64,YWJj',
      preview: 'data:image/png;base64,YWJj',
    };
    activeChatsStore.updateChat(sessionId, {
      attachmentStages: [
        {
          clientAttachmentId: attachment.id,
          name: attachment.name,
          mimeType: 'image/png',
          size: attachment.size,
          state: 'complete',
          progress: 1,
          delivery: 'legacy-inline',
        },
      ],
    });
    const { result } = renderHook(() => useSendMessage('http://api.test'));

    await act(async () => {
      await result.current(
        sessionId,
        'codex',
        undefined,
        'Inspect this',
        [attachment],
        '[Timezone: America/Denver]',
      );
    });

    expect(sendExecutionMessageMock).toHaveBeenCalledTimes(1);
    const input = sendExecutionMessageMock.mock.calls[0][0];
    expect(input).toMatchObject({
      apiBase: 'http://api.test',
      target: {
        agent: 'codex',
        model: {
          override: 'gpt-5.6-codex-requested',
          options: { reasoningEffort: 'low' },
        },
        workspace: { kind: 'project', projectSlug: 'station' },
      },
      message: 'Inspect this',
      conversationId: sessionId,
      attachments: [
        {
          kind: 'image',
          name: 'screen.png',
          mimeType: 'image/png',
          size: 3,
          dataUrl: 'data:image/png;base64,YWJj',
        },
      ],
      ambientContext: '[Timezone: America/Denver]',
    });
    expect(input.target).not.toHaveProperty('environment');
    expect(input.clientTurnId).toEqual(expect.any(String));
    expect(input.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(input.target)).not.toMatch(
      /provider|connection|engine|apiBase|transport|credential/i,
    );
    expect(activeChatsStore.getSnapshot()[sessionId]).toMatchObject({
      status: 'sending',
      orchestrationSessionStarted: true,
    });
  });

  it('omits every model override after the picker explicitly requests the default', async () => {
    activeChatsStore.updateChat(sessionId, {
      requestedModel: null,
      requestedModelSource: 'agent default',
      requestedProviderOptions: undefined,
    });
    const { result } = renderHook(() => useSendMessage('http://api.test'));

    await act(async () => {
      await result.current(sessionId, 'codex', undefined, 'use default');
    });

    expect(sendExecutionMessageMock.mock.calls[0][0].target).not.toHaveProperty(
      'model',
    );
  });

  it('uses the receipt conversation identity and preserves SSE-owned completion', async () => {
    sendExecutionMessageMock.mockResolvedValueOnce(successReceipt('conv-2'));
    const onActiveSessionChange = vi.fn();
    const { result } = renderHook(() =>
      useSendMessage('http://api.test', onActiveSessionChange),
    );

    await act(async () => {
      await result.current(sessionId, 'codex', undefined, 'hello');
    });

    expect(assignConversationIdMock).toHaveBeenCalledWith(sessionId, 'conv-2');
    expect(onActiveSessionChange).toHaveBeenCalledWith(sessionId);
// The request acknowledgement does not pretend the streamed turn is done;
// turn.completed on the global orchestration SSE moves this to idle.
    expect(activeChatsStore.getSnapshot()[sessionId].status).toBe('sending');
  });

/**
* archive#3782: a runtime chat is durable from its first successful turn —
* that promotion IS what survives the reload, because `serializeActiveChats`
* persists a chat only once it has a conversation identity. Asserting the
* `assignConversationId` call alone would not notice the chat still being
* dropped from the persisted set, so this asserts the persisted set itself.
*/
  it('promotes the chat to a durable, persistable conversation on its first successful turn', async () => {
    expect(
      serializeActiveChats(activeChatsStore.getSnapshot()),
    ).not.toContainEqual(expect.objectContaining({ sessionId }));
    sendExecutionMessageMock.mockResolvedValueOnce(
      successReceipt('conv-durable'),
    );
    const { result } = renderHook(() => useSendMessage('http://api.test'));

    await act(async () => {
      await result.current(sessionId, 'codex', undefined, 'remember this turn');
    });

    expect(activeChatsStore.getSnapshot()[sessionId].conversationId).toBe(
      'conv-durable',
    );
    expect(serializeActiveChats(activeChatsStore.getSnapshot())).toContainEqual(
      expect.objectContaining({
        sessionId,
        conversationId: 'conv-durable',
      }),
    );
    expect(
      activeChatDurableId(sessionId, activeChatsStore.getSnapshot()[sessionId]),
    ).toBe('conv-durable');
  });

  it('keeps a globally-created conversation global through completion, persistence, project navigation, and a follow-up', async () => {
// archive#3147: the first turn ran in Station's global cwd. On the next
// render a Project coding panel used to write its own projectSlug into
// this durable chat, so the follow-up claimed a different workspace.
    activeChatsStore.updateChat(sessionId, {
      projectSlug: undefined,
      projectName: undefined,
      model: undefined,
      providerOptions: {},
    });
    sendExecutionMessageMock
      .mockResolvedValueOnce(successReceipt('global-conversation'))
      .mockResolvedValueOnce(successReceipt('global-conversation'));
    const { result } = renderHook(() => useSendMessage('http://api.test'));

    await act(async () => {
      await result.current(sessionId, 'codex', undefined, 'first global turn');
    });

// `turn.completed` settles UI state; the durable payload is what a
// reload reads before the user navigates to a Project coding panel.
    activeChatsStore.updateChat(sessionId, { status: 'idle' });
    const persisted = serializeActiveChats(activeChatsStore.getSnapshot());
    const rehydrated = hydrateActiveChats(persisted)[sessionId];
    expect(rehydrated).toMatchObject({
      conversationId: 'global-conversation',
      projectSlug: undefined,
    });
    expect(shouldBindPanelProjectContext(rehydrated, 'station')).toBe(false);

    await act(async () => {
      await result.current(sessionId, 'codex', undefined, 'second global turn');
    });

    const first = sendExecutionMessageMock.mock.calls[0]?.[0];
    const followUp = sendExecutionMessageMock.mock.calls[1]?.[0];
    expect(first).toMatchObject({
      conversationId: sessionId,
      target: { environment: { kind: 'current' }, agent: 'codex' },
    });
    expect(first.target).not.toHaveProperty('workspace');
    expect(followUp).toMatchObject({
      conversationId: 'global-conversation',
      target: { environment: { kind: 'current' }, agent: 'codex' },
    });
    expect(followUp.target).not.toHaveProperty('workspace');
  });

  it('reuses the same client turn id from the Retry affordance', async () => {
    sendExecutionMessageMock
      .mockRejectedValueOnce(new Error('temporarily unavailable'))
      .mockResolvedValueOnce(successReceipt());
    const { result } = renderHook(() => useSendMessage('http://api.test'));

    await act(async () => {
      await result.current(sessionId, 'codex', undefined, 'retry me');
    });
    const firstId = sendExecutionMessageMock.mock.calls[0][0].clientTurnId;
    const retry = activeChatsStore
      .getSnapshot()
      [sessionId]?.ephemeralMessages?.at(-1)?.action?.handler;
    expect(retry).toBeTypeOf('function');

    await act(async () => {
      await retry?.();
    });
    expect(sendExecutionMessageMock.mock.calls[1][0].clientTurnId).toBe(
      firstId,
    );
  });

  it('renders a workspace-resume hint instead of a Model-connection hint for an orchestration refusal', async () => {
    sendExecutionMessageMock.mockRejectedValueOnce(
      new CodedOrchestrationError(
        400,
        "This conversation's worktree is gone and cannot be resumed.",
        'continuation_workspace_worktree_gone',
      ),
    );
    const { result } = renderHook(() => useSendMessage('http://api.test'));

    await act(async () => {
      await result.current(sessionId, 'codex', undefined, 'resume me');
    });

    const notice = activeChatsStore
      .getSnapshot()
      [sessionId]?.ephemeralMessages?.at(-1)?.content;
    expect(notice).toContain("Can't resume");
    expect(notice).not.toMatch(/Model connection/i);
    expect(
      activeChatsStore.getSnapshot()[sessionId]?.ephemeralMessages?.at(-1)
        ?.action,
    ).toBeUndefined();
  });

// archive#3690: the queue path stopped attributing a
// Station-side refusal to the agent, but the direct composer path still
// wrote `status: 'error'` — which `chatLifecycleLabel` turns into "Failed"
// in the inbox, outranking the server's truthful "Completed". The agent
// never ran. Covering the store state here, and the label it derives in
// `home-view-model.test.ts`, spans the whole misattribution.
  it('does not mark the chat failed when Station refuses a send into an ended session', async () => {
    sendExecutionMessageMock.mockRejectedValueOnce(
      new CodedOrchestrationError(400, 'This chat has ended.', 'session_ended'),
    );
    const { result } = renderHook(() => useSendMessage('http://api.test'));

    await act(async () => {
      await result.current(sessionId, 'codex', undefined, 'one more thing');
    });

    const chat = activeChatsStore.getSnapshot()[sessionId];
    expect(chat?.status).not.toBe('error');
// The refusal is still surfaced — as a notice about the SESSION, with no
// Retry, because it is permanent for this conversation.
    const notice = chat?.ephemeralMessages?.at(-1);
    expect(notice?.content).toContain('This chat has ended');
    expect(notice?.action).toBeUndefined();
  });

// The discriminating counter-case: an ordinary send failure is NOT a
// Station-side refusal and must still read as an error, or the fix above
// would have silently swallowed real failures.
  it('still marks the chat failed for a non-terminal send failure', async () => {
    sendExecutionMessageMock.mockRejectedValueOnce(
      new CodedOrchestrationError(500, 'Provider exploded.', 'provider_error'),
    );
    const { result } = renderHook(() => useSendMessage('http://api.test'));

    await act(async () => {
      await result.current(sessionId, 'codex', undefined, 'hello');
    });

    expect(activeChatsStore.getSnapshot()[sessionId]?.status).toBe('error');
  });

  it('restores supervised attachments and stage refs after a definitive rejection', async () => {
    activeChatsStore.updateChat(sessionId, {
      attachments: [stagedAttachment],
      attachmentStages: [stagedSnapshot],
    });
    sendExecutionMessageMock.mockRejectedValueOnce(
      new CodedOrchestrationError(
        400,
        'Attachment was refused.',
        'attachment_refused',
      ),
    );
    const { result } = renderHook(() => useSendMessage('http://api.test'));

    await act(async () => {
      await result.current(
        sessionId,
        'codex',
        undefined,
        'retry this attachment',
        [stagedAttachment],
      );
    });

    expect(activeChatsStore.getSnapshot()[sessionId]).toMatchObject({
      attachments: [stagedAttachment],
      attachmentStages: [stagedSnapshot],
    });
    sendExecutionMessageMock.mockResolvedValueOnce(successReceipt());
    await act(async () => {
      await result.current(
        sessionId,
        'codex',
        undefined,
        'retry this attachment',
        [stagedAttachment],
      );
    });
    expect(sendExecutionMessageMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        attachmentRefs: [stagedSnapshot.reference],
      }),
    );
  });

  it('does not restore consumed stages after an accepted send', async () => {
    activeChatsStore.updateChat(sessionId, {
      attachments: [stagedAttachment],
      attachmentStages: [stagedSnapshot],
    });
    const { result } = renderHook(() => useSendMessage('http://api.test'));
    await act(async () => {
      await result.current(
        sessionId,
        'codex',
        undefined,
        'accepted attachment',
        [stagedAttachment],
      );
    });
    expect(activeChatsStore.getSnapshot()[sessionId]).toMatchObject({
      attachments: [],
      attachmentStages: [],
    });
  });

  it('does not restore a stage after an indeterminate send', async () => {
    const { ForegroundMessageIndeterminateError } = await import(
      '@kontourai/station-sdk/client'
    );
    activeChatsStore.updateChat(sessionId, {
      attachments: [stagedAttachment],
      attachmentStages: [stagedSnapshot],
    });
    sendExecutionMessageMock.mockRejectedValueOnce(
      new ForegroundMessageIndeterminateError(409, 'Receipt unknown.', {
        code: 'foreground_message_indeterminate',
        outcome: 'indeterminate',
        receipt: {
          commandId: 'command-1',
          threadId: 'observed-session',
          commandType: 'startSession',
          status: 'accepted',
          createdAt: '2026-08-25T00:00:00.000Z',
        },
        receiptStatus: 'unavailable',
        session: {
          threadId: 'observed-session',
          provider: 'codex',
          status: 'running',
          createdAt: '2026-08-25T00:00:00.000Z',
          updatedAt: '2026-08-25T00:00:00.000Z',
        },
      }),
    );
    const { result } = renderHook(() => useSendMessage('http://api.test'));
    await act(async () => {
      await expect(
        result.current(sessionId, 'codex', undefined, 'do not replay stage', [
          stagedAttachment,
        ]),
      ).rejects.toMatchObject({ outcome: 'indeterminate' });
    });
    expect(activeChatsStore.getSnapshot()[sessionId]).toMatchObject({
      attachments: [],
      attachmentStages: [],
    });
  });

  it('restores legacy-inline attachments without inventing stage refs', async () => {
    const legacySnapshot = {
      ...stagedSnapshot,
      delivery: 'legacy-inline' as const,
      reference: undefined,
    };
    activeChatsStore.updateChat(sessionId, {
      attachments: [stagedAttachment],
      attachmentStages: [legacySnapshot],
    });
    sendExecutionMessageMock.mockRejectedValueOnce(
      new CodedOrchestrationError(
        400,
        'Legacy attachment refused.',
        'attachment_refused',
      ),
    );
    const { result } = renderHook(() => useSendMessage('http://api.test'));
    await act(async () => {
      await result.current(
        sessionId,
        'codex',
        undefined,
        'retry legacy attachment',
        [stagedAttachment],
      );
    });
    expect(activeChatsStore.getSnapshot()[sessionId]).toMatchObject({
      attachments: [stagedAttachment],
      attachmentStages: [legacySnapshot],
    });
  });

  it('does not retry an actual SDK indeterminate foreground error and preserves its session evidence', async () => {
    const { ForegroundMessageIndeterminateError } = await import(
      '@kontourai/station-sdk/client'
    );
    sendExecutionMessageMock.mockRejectedValueOnce(
      new ForegroundMessageIndeterminateError(
        409,
        'The foreground receipt could not be persisted.',
        {
          code: 'foreground_message_indeterminate',
          outcome: 'indeterminate',
          receipt: {
            commandId: 'command-1',
            threadId: 'observed-session',
            commandType: 'startSession',
            status: 'accepted',
            createdAt: '2026-08-13T00:00:00.000Z',
          },
          receiptStatus: 'unavailable',
          session: {
            threadId: 'observed-session',
            provider: 'codex',
            status: 'running',
            createdAt: '2026-08-13T00:00:00.000Z',
            updatedAt: '2026-08-13T00:00:00.000Z',
          },
        },
      ),
    );
    const onActiveSessionChange = vi.fn();
    const { result } = renderHook(() =>
      useSendMessage('http://api.test', onActiveSessionChange),
    );

    await act(async () => {
      await expect(
        result.current(sessionId, 'codex', undefined, 'do not replay'),
      ).rejects.toMatchObject({
        code: 'foreground_message_indeterminate',
        outcome: 'indeterminate',
      });
    });

    const chat = activeChatsStore.getSnapshot()[sessionId]!;
    expect(sendExecutionMessageMock).toHaveBeenCalledTimes(1);
    expect(chat).toMatchObject({
      status: 'idle',
      conversationId: 'observed-session',
      orchestrationSessionStarted: true,
      messages: [expect.objectContaining({ content: 'do not replay' })],
    });
    expect(assignConversationIdMock).toHaveBeenCalledWith(
      sessionId,
      'observed-session',
    );
    expect(onActiveSessionChange).toHaveBeenCalledWith(sessionId);
    const notice = chat.ephemeralMessages?.at(-1);
    expect(notice?.content).toContain('observed-session');
    expect(notice?.content).toContain('not sent again');
    expect(notice?.action).toBeUndefined();
// Live foreground execution never enters the offline queue; this outcome
// keeps session evidence in the chat instead of attempting storage.
  });

  it('does not offer Retry for a detail-less remote indeterminate foreground result', async () => {
    sendExecutionMessageMock.mockRejectedValueOnce(
      Object.assign(new Error('Remote response was ambiguous.'), {
        code: 'foreground_message_indeterminate',
        outcome: 'indeterminate',
      }),
    );
    const { result } = renderHook(() => useSendMessage('http://api.test'));

    await act(async () => {
      await expect(
        result.current(sessionId, 'codex', undefined, 'do not replay remotely'),
      ).rejects.toMatchObject({
        code: 'foreground_message_indeterminate',
        outcome: 'indeterminate',
      });
    });

    const notice = activeChatsStore
      .getSnapshot()
      [sessionId]?.ephemeralMessages?.at(-1);
    expect(notice?.content).toContain('may already have started');
    expect(notice?.action).toBeUndefined();
    expect(sendExecutionMessageMock).toHaveBeenCalledTimes(1);
  });

  it('latches queued indeterminate evidence before isolating a throwing error observer', async () => {
    outboundQueueMode.useActual = true;
    let entries: unknown;
    _setOutboundQueueStorage({
      getItem: async () => entries,
      setItem: async (_key, next) => {
        entries = next;
      },
      updateItem: async (_key, updater) => {
        entries = updater(entries);
      },
    });
    await outboundDispatch.enqueue({
      clientTurnId: 'observer-safe',
      sessionId,
      agentSlug: 'codex',
      content: 'must not replay',
    });
    const { ForegroundMessageIndeterminateError } = await import(
      '@kontourai/station-sdk/client'
    );
    sendExecutionMessageMock.mockRejectedValue(
      new ForegroundMessageIndeterminateError(409, 'receipt unavailable', {
        code: 'foreground_message_indeterminate',
        outcome: 'indeterminate',
        receipt: {
          commandId: 'command-1',
          threadId: 'observed-session',
          commandType: 'startSession',
          status: 'accepted',
          createdAt: '2026-08-13T00:00:00.000Z',
        },
        receiptStatus: 'unavailable',
        session: {
          threadId: 'observed-session',
          provider: 'codex',
          status: 'running',
          createdAt: '2026-08-13T00:00:00.000Z',
          updatedAt: '2026-08-13T00:00:00.000Z',
        },
      }),
    );
    const observer = vi.fn(() => {
      throw new Error('observer failure');
    });
    const { result } = renderHook(() =>
      useSendMessage('http://api.test', undefined, observer),
    );
    const replay = async (
      turn: QueuedOutboundTurn,
      claim: OutboundDispatchClaim,
    ) => {
      const outcome = await result.current(
        turn.sessionId,
        turn.agentSlug,
        turn.conversationId,
        turn.content,
        turn.attachments,
        turn.ambientContext,
        turn.clientTurnId,
        { skipInMemoryQueueOnBusy: true, dispatch: claim },
      );
      return outcome && typeof outcome === 'object' && 'kind' in outcome
        ? outcome
        : outcome === true
          ? { kind: 'accepted' as const, providerTurnId: 'provider-turn-1' }
          : { kind: 'not-invoked' as const };
    };

    await outboundDispatch.flush(replay);
    await outboundDispatch.flush(replay);

    expect(observer).toHaveBeenCalledTimes(1);
    expect(sendExecutionMessageMock).toHaveBeenCalledTimes(1);
    expect(await outboundDispatch.snapshot()).toEqual([
      expect.objectContaining({
        clientTurnId: 'observer-safe',
        status: 'may-have-started',
      }),
    ]);
  });

  it('fences an indeterminate replay when its durable settlement write fails, then never sends it again', async () => {
    outboundQueueMode.useActual = true;
    let entries: unknown;
    let updates = 0;
    _setOutboundQueueStorage({
      getItem: async () => entries,
      setItem: async (_key, next) => {
        entries = next;
      },
      updateItem: async (_key, updater) => {
        updates += 1;
// enqueue, foreign-claim recovery, and dispatch claim succeed. The
// post-provider indeterminate transition is the first unavailable IO.
        if (updates === 4) throw new Error('IndexedDB unavailable');
        entries = updater(entries);
      },
    });
    await outboundDispatch.enqueue({
      clientTurnId: 'queued-indeterminate',
      sessionId,
      agentSlug: 'codex',
      content: 'may have started',
    });
    const { ForegroundMessageIndeterminateError } = await import(
      '@kontourai/station-sdk/client'
    );
    sendExecutionMessageMock.mockRejectedValue(
      new ForegroundMessageIndeterminateError(
        409,
        'The foreground receipt could not be persisted.',
        {
          code: 'foreground_message_indeterminate',
          outcome: 'indeterminate',
          receipt: {
            commandId: 'command-1',
            threadId: 'observed-session',
            commandType: 'startSession',
            status: 'accepted',
            createdAt: '2026-08-13T00:00:00.000Z',
          },
          receiptStatus: 'unavailable',
          session: {
            threadId: 'observed-session',
            provider: 'codex',
            status: 'running',
            createdAt: '2026-08-13T00:00:00.000Z',
            updatedAt: '2026-08-13T00:00:00.000Z',
          },
        },
      ),
    );
    const { result } = renderHook(() => useSendMessage('http://api.test'));

    await act(async () => {
      await outboundDispatch.flush(async (turn, claim) => {
        const outcome = await result.current(
          turn.sessionId,
          turn.agentSlug,
          turn.conversationId,
          turn.content,
          turn.attachments,
          turn.ambientContext,
          turn.clientTurnId,
          { skipInMemoryQueueOnBusy: true, dispatch: claim },
        );
        return outcome && typeof outcome === 'object' && 'kind' in outcome
          ? outcome
          : { kind: 'not-invoked' as const };
      });
      await outboundDispatch.flush(async (turn, claim) => {
        const outcome = await result.current(
          turn.sessionId,
          turn.agentSlug,
          turn.conversationId,
          turn.content,
          turn.attachments,
          turn.ambientContext,
          turn.clientTurnId,
          { skipInMemoryQueueOnBusy: true, dispatch: claim },
        );
        return outcome && typeof outcome === 'object' && 'kind' in outcome
          ? outcome
          : { kind: 'not-invoked' as const };
      });
    });

    expect(sendExecutionMessageMock).toHaveBeenCalledTimes(1);
    expect(activeChatsStore.getSnapshot()[sessionId]).toMatchObject({
      conversationId: 'observed-session',
      orchestrationSessionStarted: true,
      messages: [expect.objectContaining({ content: 'may have started' })],
    });
    expect((entries as { turns: unknown[] }).turns).toEqual([
      expect.objectContaining({
        clientTurnId: 'queued-indeterminate',
        status: 'may-have-started',
      }),
    ]);
  });

  it('never offers Retry after a generic dispatch-claim transport failure', async () => {
    sendExecutionMessageMock.mockRejectedValueOnce(
      new TypeError('connection reset'),
    );
    const claim = { indeterminate: vi.fn(async () => 'applied' as const) };
    const { result } = renderHook(() => useSendMessage('http://api.test'));

    await expect(
      result.current(
        sessionId,
        'codex',
        undefined,
        'do not replay',
        undefined,
        undefined,
        'claimed-turn',
        { skipInMemoryQueueOnBusy: true, dispatch: claim },
      ),
    ).rejects.toThrow('connection reset');

    expect(claim.indeterminate).toHaveBeenCalledOnce();
    expect(
      activeChatsStore.getSnapshot()[sessionId]?.ephemeralMessages?.at(-1)
        ?.action,
    ).toBeUndefined();
  });

  it('queues a network-level failure without rolling back the optimistic turn', async () => {
    sendExecutionMessageMock.mockRejectedValueOnce(new TypeError('offline'));
    const { result } = renderHook(() => useSendMessage('http://api.test'));

    await act(async () => {
      await result.current(sessionId, 'codex', undefined, 'send later');
    });

    expect(enqueueOutboundTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        agentSlug: 'codex',
        content: 'send later',
        clientTurnId: expect.any(String),
      }),
      expect.any(TypeError),
    );
    expect(activeChatsStore.getSnapshot()[sessionId]).toMatchObject({
      status: 'queued',
      messages: [expect.objectContaining({ content: 'send later' })],
    });
  });

// archive#3686. Two things are asserted together on purpose: the COPY
// differs by cause, and everything else — the durable enqueue, its
// arguments, the resulting status — is identical. The fix claims queueing
// behaviour is untouched and only the claim to the user changed; a test that
// checked copy alone would let a cause-specific enqueue regression through
 //which would lose the message on reload.
  const undeliverableCases = [
    {
      name: 'a send that threw while the browser reports a network',
      onLine: true,
      expected: "Send wasn't confirmed — queued to retry automatically",
      forbidden: /offline/i,
    },
    {
      name: 'a send that threw while the browser reports no network',
      onLine: false,
      expected:
        'Your browser reports no network — queued to retry automatically',
      forbidden: /couldn't reach/i,
    },
  ] as const;

  for (const testCase of undeliverableCases) {
    it(`queues ${testCase.name} identically, and says only what it observed`, async () => {
// jsdom inherits `onLine` from Navigator.prototype, so cleanup must
// DELETE the injected own property; a restore-if-present cleanup never
// runs and leaks the value into later tests.
      Object.defineProperty(window.navigator, 'onLine', {
        configurable: true,
        get: () => testCase.onLine,
      });
      try {
        sendExecutionMessageMock.mockRejectedValueOnce(
          new TypeError('Failed to fetch'),
        );
        const { result } = renderHook(() => useSendMessage('http://api.test'));

        await act(async () => {
          await result.current(sessionId, 'codex', undefined, 'send later');
        });

// Identical for both causes: the message reaches the durable queue
// with the same intent.
        expect(enqueueOutboundTurnMock).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId,
            agentSlug: 'codex',
            content: 'send later',
            clientTurnId: expect.any(String),
          }),
          expect.any(TypeError),
        );
        const chat = activeChatsStore.getSnapshot()[sessionId];
        expect(chat?.status).toBe('queued');
        expect(chat?.messages).toEqual([
          expect.objectContaining({ content: 'send later' }),
        ]);

// Only this differs.
        const notice = chat?.ephemeralMessages?.at(-1);
        expect(notice?.content).toBe(testCase.expected);
        expect(notice?.content).not.toMatch(testCase.forbidden);
        expect(notice?.action?.label).toBe('Discard');
      } finally {
        delete (window.navigator as { onLine?: unknown }).onLine;
      }
    });
  }

// A response is proof the address answered, so the send is not undeliverable
// and must NOT be queued for a retry that cannot help — even while the
// browser claims to be offline. The draft returns to the composer instead.
  it('does not queue a response-bearing failure, even when the browser claims offline', async () => {
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      get: () => false,
    });
    try {
      sendExecutionMessageMock.mockRejectedValueOnce(
        new CodedOrchestrationError(401, 'Unauthorized', 'unauthorized'),
      );
      const { result } = renderHook(() => useSendMessage('http://api.test'));

      await act(async () => {
        await result.current(sessionId, 'codex', undefined, 'send later');
      });

      expect(enqueueOutboundTurnMock).not.toHaveBeenCalled();
      expect(activeChatsStore.getSnapshot()[sessionId]?.status).not.toBe(
        'queued',
      );
// The user's text is not lost — it goes back to the composer.
      expect(activeChatsStore.getSnapshot()[sessionId]?.input).toBe(
        'send later',
      );
    } finally {
      delete (window.navigator as { onLine?: unknown }).onLine;
    }
  });

  it('awaits the original offline Discard and surfaces durable-delete rejection', async () => {
    sendExecutionMessageMock.mockRejectedValueOnce(new TypeError('offline'));
    let rejectDelete!: (error: Error) => void;
    discardOutboundTurnMock.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectDelete = reject;
        }),
    );
    const { result } = renderHook(() => useSendMessage('http://api.test'));

    await act(async () => {
      await result.current(sessionId, 'codex', undefined, 'send later');
    });
    const discard = activeChatsStore
      .getSnapshot()
      [sessionId]?.ephemeralMessages?.at(-1)?.action?.handler;

    let discardRequest!: Promise<unknown>;
    act(() => {
      discardRequest = Promise.resolve(discard?.());
    });
    expect(activeChatsStore.getSnapshot()[sessionId]?.status).toBe('queued');
    await vi.waitFor(() => {
      expect(rejectDelete).toBeTypeOf('function');
    });

    await act(async () => {
      rejectDelete(new Error('disk full'));
      await discardRequest;
    });
    expect(activeChatsStore.getSnapshot()[sessionId]).toMatchObject({
      status: 'error',
      error: 'Discard failed: disk full',
    });
  });

  it('fails loudly when a network-level failure cannot be durably queued', async () => {
    sendExecutionMessageMock.mockRejectedValueOnce(new TypeError('offline'));
    enqueueOutboundTurnMock.mockRejectedValueOnce(
      new Error('Persistent outbound queue requires IndexedDB'),
    );
    const { result } = renderHook(() => useSendMessage('http://api.test'));

    await act(async () => {
      await result.current(sessionId, 'codex', undefined, 'cannot save');
    });

    expect(activeChatsStore.getSnapshot()[sessionId]).toMatchObject({
      status: 'error',
      error: 'Send unavailable: Persistent outbound queue requires IndexedDB',
    });
  });

  it('queues a mid-turn message when the bound adapter cannot steer', async () => {
    activeChatsStore.updateChat(sessionId, { status: 'sending' });
    const { result } = renderHook(() => useSendMessage('http://api.test'));

    await act(async () => {
      await result.current(sessionId, 'codex', sessionId, 'next');
    });

    expect(sendExecutionMessageMock).not.toHaveBeenCalled();
    expect(activeChatsStore.getSnapshot()[sessionId].queuedMessages).toEqual([
      'next',
    ]);
  });

/**
* archive#1146: nothing else invalidates `['orchestration-sessions']` on
* this path, and `staleTime` alone never triggers a refetch — measured
* live, a dock whose session list was fetched before the session existed
* stayed on its stale value for 120s of polling. Without this the chat
* dock's directory label only becomes true on the next full page load.
*/
  it('invalidates session and conversation inventories once a session has been started', async () => {
    const { result } = renderHook(() => useSendMessage('http://api.test'));

    await act(async () => {
      await result.current(sessionId, 'codex', undefined, 'hello');
    });

    expect(invalidateMock).toHaveBeenCalledWith(['orchestration-sessions']);
    expect(invalidateMock).toHaveBeenCalledWith(['conversation-inventory']);
  });

  it('does not re-invalidate the session list on a send that starts no session', async () => {
    activeChatsStore.updateChat(sessionId, {
      orchestrationSessionStarted: true,
    });

    const { result } = renderHook(() => useSendMessage('http://api.test'));

    await act(async () => {
      await result.current(sessionId, 'codex', sessionId, 'hello again');
    });

    expect(invalidateMock).not.toHaveBeenCalledWith(['orchestration-sessions']);
    expect(invalidateMock).not.toHaveBeenCalledWith(['conversation-inventory']);
  });

  it('does not put a durable replay into the legacy in-memory busy queue', async () => {
    activeChatsStore.updateChat(sessionId, { status: 'sending' });
    const { result } = renderHook(() => useSendMessage('http://api.test'));

    await act(async () => {
      await result.current(
        sessionId,
        'codex',
        undefined,
        'durable replay only',
        undefined,
        undefined,
        'existing-turn-id',
        { skipInMemoryQueueOnBusy: true },
      );
    });

    expect(sendExecutionMessageMock).not.toHaveBeenCalled();
    expect(activeChatsStore.getSnapshot()[sessionId]?.queuedMessages).toEqual(
      [],
    );
  });
});

describe('useCancelMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    interruptOrchestrationTurnMock.mockReset();
    interruptOrchestrationTurnMock.mockResolvedValue(cooperativeStop);
    activeChatsStore.initChat(sessionId, {
      agentSlug: 'codex',
      agentName: 'Codex',
      title: 'New chat',
      conversationId: 'server-thread-1',
    });
    const controller = new AbortController();
    activeChatsStore.updateChat(sessionId, {
      status: 'sending',
      abortController: controller,
    });
  });

  afterEach(() => activeChatsStore.removeChat(sessionId));

  it('interrupts the server turn before aborting the local stream', async () => {
    const { result } = renderHook(() => useCancelMessage('http://api.test'));
    const controller = activeChatsStore.getSnapshot()[sessionId]
      ?.abortController as AbortController;

    await act(async () => {
      await result.current(sessionId);
    });

    expect(interruptOrchestrationTurnMock).toHaveBeenCalledWith({
      threadId: 'server-thread-1',
      apiBase: 'http://api.test',
    });
    expect(controller.signal.aborted).toBe(true);
    expect(activeChatsStore.getSnapshot()[sessionId]).toMatchObject({
      status: 'idle',
      abortController: undefined,
      stopPending: false,
    });
  });

 // the interrupt used to be awaited with no
// try/finally, so any rejection — a refused connection, a 500, a forced
// teardown that threw — left the browser stream un-aborted and the composer
// pinned at `sending` forever, with no failure surfaced at all.
  it('releases the local stream and reports a failure when the interrupt provably never left the browser', async () => {
    interruptOrchestrationTurnMock.mockRejectedValueOnce(
      new Error('connect ECONNREFUSED 127.0.0.1:3141'),
    );
    const { result } = renderHook(() => useCancelMessage('http://api.test'));
    const controller = activeChatsStore.getSnapshot()[sessionId]
      ?.abortController as AbortController;

    let outcome: StopTurnOutcome | undefined;
    await act(async () => {
      outcome = await result.current(sessionId);
    });

    expect(outcome).toEqual({
      kind: 'failed',
      reason: 'connect ECONNREFUSED 127.0.0.1:3141',
    });
    expect(describeStopTurnOutcome(outcome as StopTurnOutcome)).toContain(
      'Stop failed',
    );
    expect(controller.signal.aborted).toBe(true);
    expect(activeChatsStore.getSnapshot()[sessionId]).toMatchObject({
      status: 'idle',
      abortController: undefined,
      stopPending: false,
    });
  });

// A POST that timed out may already have interrupted the turn. Reporting it
// as a failure would be a claim about the engine this client cannot make.
  it('reports an unanswered interrupt as indeterminate, not failed', async () => {
    interruptOrchestrationTurnMock.mockRejectedValueOnce(
      Object.assign(new Error('The request timed out.'), {
        name: 'StationRequestTimeoutError',
      }),
    );
    const { result } = renderHook(() => useCancelMessage('http://api.test'));
    const controller = activeChatsStore.getSnapshot()[sessionId]
      ?.abortController as AbortController;

    let outcome: StopTurnOutcome | undefined;
    await act(async () => {
      outcome = await result.current(sessionId);
    });

    expect(outcome?.kind).toBe('indeterminate');
    expect(describeStopTurnOutcome(outcome as StopTurnOutcome)).toContain(
      'Stop requested — waiting for the engine',
    );
    expect(controller.signal.aborted).toBe(true);
    expect(activeChatsStore.getSnapshot()[sessionId]?.status).toBe('idle');
  });

// The hang: while the request is outstanding the composer must show a
// pending state and refuse a second press, then release when it settles.
  it('marks the stop pending while the request is outstanding and refuses a second press', async () => {
    let settle: (value: unknown) => void = () => {};
    interruptOrchestrationTurnMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const { result } = renderHook(() => useCancelMessage('http://api.test'));

    let first: Promise<StopTurnOutcome> | undefined;
    await act(async () => {
      first = result.current(sessionId);
      await Promise.resolve();
    });
    expect(activeChatsStore.getSnapshot()[sessionId]?.stopPending).toBe(true);
    expect(activeChatsStore.getSnapshot()[sessionId]?.status).toBe('sending');

// The double click.
    let second: StopTurnOutcome | undefined;
    await act(async () => {
      second = await result.current(sessionId);
    });
    expect(second).toEqual({ kind: 'not-running' });
    expect(interruptOrchestrationTurnMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle(cooperativeStop);
      await first;
    });
    expect(activeChatsStore.getSnapshot()[sessionId]).toMatchObject({
      status: 'idle',
      stopPending: false,
    });
  });

 // (live verification): the send path clears `abortController`
// the moment the orchestration POST returns its receipt — seconds into a
// turn that then streams for minutes. Stop must still work for the whole of
// that turn; before this fix it silently did nothing.
  it('still interrupts the turn after the send path has released the browser stream', async () => {
    activeChatsStore.updateChat(sessionId, {
      abortController: undefined,
      status: 'sending',
      orchestrationTurnOpen: true,
    });
    const { result } = renderHook(() => useCancelMessage('http://api.test'));

    let outcome: StopTurnOutcome | undefined;
    await act(async () => {
      outcome = await result.current(sessionId);
    });

    expect(interruptOrchestrationTurnMock).toHaveBeenCalledWith({
      threadId: 'server-thread-1',
      apiBase: 'http://api.test',
    });
    expect(outcome?.kind).toBe('settled');
    expect(activeChatsStore.getSnapshot()[sessionId]?.status).toBe('idle');
  });

// The engine session may not exist yet when Stop is pressed; the server
// records the cancel and applies it to the turn that starts.
  it('renders the deferred stop the server recorded before the turn existed', async () => {
    interruptOrchestrationTurnMock.mockResolvedValueOnce({
      outcome: 'pending-turn-start',
      threadId: 'server-thread-1',
    });
    const { result } = renderHook(() => useCancelMessage('http://api.test'));

    let outcome: StopTurnOutcome | undefined;
    await act(async () => {
      outcome = await result.current(sessionId);
    });

    expect(describeStopTurnOutcome(outcome as StopTurnOutcome)).toContain(
      'interrupted as soon as it does',
    );
  });

// The label must describe what the SERVER derived. A cooperative stop keeps
// the engine warm; only the forced path ends the process.
  it.each([
    [
      'cooperative',
      { outcome: 'cooperative', threadId: 'server-thread-1', turnId: 't' },
      'engine is kept warm',
    ],
    [
      'forced',
      { outcome: 'forced', threadId: 'server-thread-1', turnId: 't' },
      'forced the turn to stop',
    ],
    [
      'turn-completed',
      { outcome: 'turn-completed', threadId: 'server-thread-1', turnId: 't' },
      'finished before the stop took effect',
    ],
    [
      'no-active-turn',
      { outcome: 'no-active-turn', threadId: 'server-thread-1' },
      'no turn running to stop',
    ],
  ])(
    'renders the %s outcome the server derived',
    async (_name, serverResult, expected) => {
      interruptOrchestrationTurnMock.mockResolvedValueOnce(serverResult);
      const { result } = renderHook(() => useCancelMessage('http://api.test'));

      let outcome: StopTurnOutcome | undefined;
      await act(async () => {
        outcome = await result.current(sessionId);
      });

      expect(outcome).toEqual({ kind: 'settled', result: serverResult });
      expect(describeStopTurnOutcome(outcome as StopTurnOutcome)).toContain(
        expected,
      );
    },
  );
});
