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
vi.mock('@kontourai/station-sdk/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk/client')>()),
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
// #2144 slice 6: the hook reads `AppConfig.defaultApprovalMode` through
// ConfigContext, which reads this query.
const stationAppConfig = vi.hoisted(
  () => ({ current: undefined }) as { current: unknown },
);
const configQueryMock = vi.fn(() => ({
  data: stationAppConfig.current,
  error: null,
  dataUpdatedAt: 0,
  refetch: vi.fn(),
}));
const cooperativeStop = {
  outcome: 'cooperative' as const,
  threadId: 'server-thread-1',
  turnId: 'turn-1',
};
const interruptOrchestrationTurnMock = vi
  .fn()
  .mockResolvedValue(cooperativeStop);
const steerOrchestrationTurnMock = vi.fn();
// archive#1146: stable across renders so a test can assert WHICH query keys
// were invalidated. A fresh `vi.fn` per `useInvalidateQuery` call records
// nothing an assertion can reach.
const invalidateMock = vi.fn();
// #2310 review H1: the session-list cache the send path consults. Tests set
// what the cache holds; the default is an empty list.
let cachedSessionList: unknown[] = [];
const queryClientMock = {
  getQueryData: (key: unknown[]) =>
    JSON.stringify(key) === JSON.stringify(['orchestration-sessions'])
      ? cachedSessionList
      : undefined,
};
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
    useEngineConnectionsQuery: () => agentConnectionsMock(),
    useConfigQuery: () => configQueryMock(),
    // The Agent-record link of the engine-connection chain; this fixture's
    // chats carry their own binding, so the catalog is empty here.
    useAgentsQuery: () => ({ data: [], error: null }),
    useInvalidateQuery: () => invalidateMock,
    useQueryClient: () => queryClientMock,
    interruptOrchestrationTurn: (...args: unknown[]) =>
      interruptOrchestrationTurnMock(...args),
    steerOrchestrationTurn: (...args: unknown[]) =>
      steerOrchestrationTurnMock(...args),
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
  isTurnInFlight,
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
    steerOrchestrationTurnMock.mockReset();
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
    const input = sendExecutionMessageMock.mock.calls[0][1];
    expect(input).toMatchObject({
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
    expect(sendExecutionMessageMock.mock.calls[0][0]).toBe('http://api.test');
    expect(sendExecutionMessageMock.mock.calls[0][2].signal).toBeInstanceOf(
      AbortSignal,
    );
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

    expect(sendExecutionMessageMock.mock.calls[0][1].target).not.toHaveProperty(
      'model',
    );
  });

  /**
   * #2436: the server resolves the defaults (the Agent's, then this
   * Station's) at a session start, so the send path puts none on the wire,
   * whatever the chat's liveness. The only posture a send carries is a pick
   * the server has not received yet, as its own compare-and-set command.
   */
  describe('approval posture on the wire', () => {
    beforeEach(() => {
      activeChatsStore.updateChat(sessionId, {
        agentConnectionId: 'claude',
        executionMode: 'external',
        requestedProviderOptions: undefined,
        providerOptions: {},
      });
      stationAppConfig.current = { defaultApprovalMode: 'never' };
    });

    afterEach(() => {
      stationAppConfig.current = undefined;
    });

    async function bodyAfterSend() {
      const { result } = renderHook(() => useSendMessage('http://api.test'));
      await act(async () => {
        await result.current(sessionId, 'codex', undefined, 'go');
      });
      return sendExecutionMessageMock.mock.calls[0][1];
    }

    it.each([
      ['a chat starting its session', {}],
      [
        'a session that exited',
        {
          orchestrationSessionStarted: false,
          orchestrationStatus: 'exited',
          currentSessionId: 'dead-session-1',
        },
      ],
      [
        'a live session',
        {
          orchestrationSessionStarted: true,
          orchestrationStatus: 'running',
          currentSessionId: 'live-session-1',
        },
      ],
    ])('sends no default for %s', async (_label, state) => {
      activeChatsStore.updateChat(sessionId, state);
      const body = await bodyAfterSend();
      expect(body.target.model?.options ?? {}).not.toHaveProperty(
        'approvalMode',
      );
      expect(body).not.toHaveProperty('setApprovalMode');
    });

    it('carries a queued pick as setApprovalMode, compare-and-set against the folded decision', async () => {
      activeChatsStore.updateChat(sessionId, {
        queuedApprovalMode: 'ask',
        approvalPostureSequence: 41,
      });
      const body = await bodyAfterSend();
      expect(body).toMatchObject({
        setApprovalMode: 'ask',
        setApprovalModeBasedOn: 41,
      });
      expect(body.target.model?.options ?? {}).not.toHaveProperty(
        'approvalMode',
      );
    });

    it('a pick made having folded no decision says so (null), not "unconditional"', async () => {
      activeChatsStore.updateChat(sessionId, { queuedApprovalMode: 'auto' });
      expect(await bodyAfterSend()).toMatchObject({
        setApprovalMode: 'auto',
        setApprovalModeBasedOn: null,
      });
    });
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

    const first = sendExecutionMessageMock.mock.calls[0]?.[1];
    const followUp = sendExecutionMessageMock.mock.calls[1]?.[1];
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
    const firstId = sendExecutionMessageMock.mock.calls[0][1].clientTurnId;
    const retry = activeChatsStore
      .getSnapshot()
      [sessionId]?.ephemeralMessages?.at(-1)?.action?.handler;
    expect(retry).toBeTypeOf('function');

    await act(async () => {
      await retry?.();
    });
    expect(sendExecutionMessageMock.mock.calls[1][1].clientTurnId).toBe(
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
      'http://api.test',
      expect.objectContaining({
        attachmentRefs: [stagedSnapshot.reference],
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
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
    activeChatsStore.updateChat(sessionId, {
      status: 'sending',
      orchestrationProvider: 'muse',
    });
    const { result } = renderHook(() => useSendMessage('http://api.test'));

    await act(async () => {
      await result.current(sessionId, 'muse', sessionId, 'next');
    });

    expect(sendExecutionMessageMock).not.toHaveBeenCalled();
    expect(steerOrchestrationTurnMock).not.toHaveBeenCalled();
    expect(activeChatsStore.getSnapshot()[sessionId].queuedMessages).toEqual([
      'next',
    ]);
  });

  it('steers a mid-turn message on Claude instead of queueing a new turn', async () => {
    steerOrchestrationTurnMock.mockResolvedValueOnce({
      outcome: 'steered',
      threadId: 'exec-claude-1',
      turnId: 'turn-open',
    });
    activeChatsStore.updateChat(sessionId, {
      status: 'sending',
      orchestrationProvider: 'claude',
      currentSessionId: 'exec-claude-1',
      openTurnId: 'turn-open',
      streamingMessage: {
        role: 'assistant',
        content: 'partial answer',
        contentParts: [{ type: 'text', content: 'partial answer' }],
      },
    });
    const { result } = renderHook(() => useSendMessage('http://api.test'));

    await act(async () => {
      await result.current(sessionId, 'claude', sessionId, 'course correct');
    });

    expect(steerOrchestrationTurnMock).toHaveBeenCalledWith({
      threadId: 'exec-claude-1',
      text: 'course correct',
      turnId: 'turn-open',
      apiBase: 'http://api.test',
    });
    expect(sendExecutionMessageMock).not.toHaveBeenCalled();
    expect(activeChatsStore.getSnapshot()[sessionId].queuedMessages).toEqual(
      [],
    );
    expect(
      activeChatsStore.getSnapshot()[sessionId].streamingMessage?.content,
    ).toBe('partial answer');
  });

  it('#2324 (D4): queues, never steers, while the engine runs a turn of its own', async () => {
    activeChatsStore.updateChat(sessionId, {
      status: 'sending',
      orchestrationProvider: 'claude',
      currentSessionId: 'exec-claude-1',
      conversationId: 'conversation-p',
      conversationActivity: {
        conversationId: 'conversation-p',
        asOfSequence: 7,
        openTurn: {
          turnId: 'provider:p',
          threadId: 'exec-claude-1',
          startedAt: '2026-09-23T00:00:00.000Z',
          trigger: 'provider',
        },
      },
    });
    const { result } = renderHook(() => useSendMessage('http://api.test'));

    await act(async () => {
      await result.current(sessionId, 'claude', sessionId, 'after it');
    });

    expect(steerOrchestrationTurnMock).not.toHaveBeenCalled();
    expect(sendExecutionMessageMock).not.toHaveBeenCalled();
    expect(activeChatsStore.getSnapshot()[sessionId].queuedMessages).toEqual([
      'after it',
    ]);
  });

  it('#2324 (D4): a send refused because the engine began its own turn moves into the queue instead of failing', async () => {
    sendExecutionMessageMock.mockRejectedValueOnce(
      new CodedOrchestrationError(
        400,
        'The agent is replying on its own; your message will be sent when it finishes.',
        'provider_turn_in_progress',
      ),
    );
    // The server shows the provider turn open by the time the refusal lands,
    // so the queue waits for its end rather than draining at once.
    activeChatsStore.updateChat(sessionId, {
      conversationId: 'conversation-q',
    });
    const { result } = renderHook(() => useSendMessage('http://api.test'));
    const sent = act(async () => {
      await result.current(sessionId, 'claude', sessionId, 'raced it');
    });
    activeChatsStore.updateChat(sessionId, {
      conversationActivity: {
        conversationId: 'conversation-q',
        asOfSequence: 9,
        openTurn: {
          turnId: 'provider:q',
          threadId: sessionId,
          startedAt: '2026-09-23T00:00:00.000Z',
          trigger: 'provider',
        },
      },
    });
    await sent;

    const chat = activeChatsStore.getSnapshot()[sessionId];
    expect(chat.queuedMessages).toEqual(['raced it']);
    expect(chat.status).not.toBe('error');
    expect(chat.error).toBeUndefined();
    // Not left as a sent row, and not restored as a draft too.
    expect(
      chat.messages?.some(
        (message) => message.role === 'user' && message.content === 'raced it',
      ),
    ).toBe(false);
    expect(chat.input ?? '').toBe('');
    expect(chat.ephemeralMessages ?? []).toEqual([]);
  });

  it('#2324 (D4): a refused send whose provider turn already ended by the time the refusal lands starts draining from the queue at once', async () => {
    // Only the drain's settle timer is faked, so its send never runs here:
    // what is under test is that the drain STARTED (it pops the head and
    // marks itself settling synchronously), not the drained send.
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      sendExecutionMessageMock.mockRejectedValueOnce(
        new CodedOrchestrationError(
          400,
          'The agent is replying on its own; your message will be sent when it finishes.',
          'provider_turn_in_progress',
        ),
      );
      // The server shows no open turn: the provider turn's end — the queue's
      // only trigger — has already passed.
      activeChatsStore.updateChat(sessionId, {
        conversationId: 'conversation-r',
        conversationActivity: {
          conversationId: 'conversation-r',
          asOfSequence: 3,
        },
      });
      const { result } = renderHook(() => useSendMessage('http://api.test'));
      await act(async () => {
        await result.current(sessionId, 'claude', sessionId, 'after it ended');
      });
      const chat = activeChatsStore.getSnapshot()[sessionId];
      expect(chat.queuedMessages).toEqual([]);
      expect(chat.queueDrainSettling).toBe(true);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('#2324 review J4: a refused send WITH attachments is not dropped into the text queue — it keeps its attachments and the ordinary error', async () => {
    activeChatsStore.updateChat(sessionId, {
      attachments: [stagedAttachment],
      attachmentStages: [stagedSnapshot],
    });
    sendExecutionMessageMock.mockRejectedValueOnce(
      new CodedOrchestrationError(
        400,
        'The agent is replying on its own; your message will be sent when it finishes.',
        'provider_turn_in_progress',
      ),
    );
    const { result } = renderHook(() => useSendMessage('http://api.test'));
    await act(async () => {
      await result.current(sessionId, 'claude', undefined, 'with a file', [
        stagedAttachment,
      ]);
    });
    const chat = activeChatsStore.getSnapshot()[sessionId];
    expect(chat.queuedMessages ?? []).toEqual([]);
    expect(chat).toMatchObject({
      attachments: [stagedAttachment],
      attachmentStages: [stagedSnapshot],
    });
    expect(chat.ephemeralMessages?.at(-1)?.content).toBeTruthy();
  });

  it('#2324 review J4b: a durable dispatch refused by a provider turn is not also put in the in-memory queue', async () => {
    // Only the drain's settle timer is faked: a conversion would start a
    // drain (popping the head at once), which is what this must not do.
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      sendExecutionMessageMock.mockRejectedValueOnce(
        new CodedOrchestrationError(
          400,
          'The agent is replying on its own; your message will be sent when it finishes.',
          'provider_turn_in_progress',
        ),
      );
      const claim = { indeterminate: vi.fn(async () => 'applied' as const) };
      const { result } = renderHook(() => useSendMessage('http://api.test'));
      await act(async () => {
        await result
          .current(
            sessionId,
            'claude',
            undefined,
            'durable send',
            undefined,
            undefined,
            'claimed-turn',
            { skipInMemoryQueueOnBusy: true, dispatch: claim },
          )
          .catch(() => undefined);
      });
      const chat = activeChatsStore.getSnapshot()[sessionId];
      // The durable claim owns the outcome; the in-memory queue took nothing
      // and started no drain of its own.
      expect(claim.indeterminate).toHaveBeenCalledOnce();
      expect(chat.queuedMessages ?? []).toEqual([]);
      expect(chat.queueDrainSettling).toBeUndefined();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('queues on a steering engine when queueOnBusy is requested', async () => {
    activeChatsStore.updateChat(sessionId, {
      status: 'sending',
      orchestrationProvider: 'claude',
      openTurnId: 'turn-open',
    });
    const { result } = renderHook(() => useSendMessage('http://api.test'));

    await act(async () => {
      await result.current(
        sessionId,
        'claude',
        sessionId,
        'wait for this turn',
        undefined,
        undefined,
        undefined,
        { queueOnBusy: true },
      );
    });

    expect(steerOrchestrationTurnMock).not.toHaveBeenCalled();
    expect(sendExecutionMessageMock).not.toHaveBeenCalled();
    expect(activeChatsStore.getSnapshot()[sessionId].queuedMessages).toEqual([
      'wait for this turn',
    ]);
  });

  it('steers a mid-turn message on Codex instead of queueing a new turn', async () => {
    steerOrchestrationTurnMock.mockResolvedValueOnce({
      outcome: 'steered',
      threadId: 'exec-codex-1',
      turnId: 'turn-open',
    });
    activeChatsStore.updateChat(sessionId, {
      status: 'sending',
      orchestrationProvider: 'codex',
      currentSessionId: 'exec-codex-1',
      openTurnId: 'turn-open',
    });
    const { result } = renderHook(() => useSendMessage('http://api.test'));

    await act(async () => {
      await result.current(sessionId, 'codex', sessionId, 'focus on fails');
    });

    expect(steerOrchestrationTurnMock).toHaveBeenCalledWith({
      threadId: 'exec-codex-1',
      text: 'focus on fails',
      turnId: 'turn-open',
      apiBase: 'http://api.test',
    });
    expect(sendExecutionMessageMock).not.toHaveBeenCalled();
    expect(activeChatsStore.getSnapshot()[sessionId].queuedMessages).toEqual(
      [],
    );
  });

  it('queues a Claude follow-up that carries attachments (steer has no file channel)', async () => {
    activeChatsStore.updateChat(sessionId, {
      status: 'sending',
      orchestrationProvider: 'claude',
      openTurnId: 'turn-open',
    });
    const { result } = renderHook(() => useSendMessage('http://api.test'));

    await act(async () => {
      await result.current(sessionId, 'claude', sessionId, 'with file', [
        stagedAttachment,
      ]);
    });

    expect(steerOrchestrationTurnMock).not.toHaveBeenCalled();
    expect(sendExecutionMessageMock).not.toHaveBeenCalled();
    expect(activeChatsStore.getSnapshot()[sessionId].queuedMessages).toEqual([
      'with file',
    ]);
  });

  it('restores the draft when a steer is refused', async () => {
    steerOrchestrationTurnMock.mockResolvedValueOnce({
      outcome: 'no-active-turn',
      threadId: sessionId,
    });
    activeChatsStore.updateChat(sessionId, {
      status: 'sending',
      orchestrationProvider: 'claude',
      openTurnId: 'turn-open',
    });
    const { result } = renderHook(() => useSendMessage('http://api.test'));

    await act(async () => {
      await result.current(sessionId, 'claude', sessionId, 'too late');
    });

    expect(sendExecutionMessageMock).not.toHaveBeenCalled();
    expect(activeChatsStore.getSnapshot()[sessionId]).toMatchObject({
      input: 'too late',
      queuedMessages: [],
    });
    expect(
      activeChatsStore.getSnapshot()[sessionId].ephemeralMessages?.at(-1)
        ?.content,
    ).toBe('The turn ended before the steer could be sent.');
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

  it('does not re-invalidate the session list when the same execution Session remains current', async () => {
    activeChatsStore.updateChat(sessionId, {
      orchestrationSessionStarted: true,
      currentSessionId: sessionId,
    });

    const { result } = renderHook(() => useSendMessage('http://api.test'));

    await act(async () => {
      await result.current(sessionId, 'codex', sessionId, 'hello again');
    });

    expect(invalidateMock).not.toHaveBeenCalledWith(['orchestration-sessions']);
    expect(invalidateMock).not.toHaveBeenCalledWith(['conversation-inventory']);
  });

  // #2310 review H1: opening a Draft marks the chat started with its
  // session current, so neither condition above fires on the first send. The
  // cached list still says Draft, and without a re-read every surface keeps
  // reading "nothing was ever sent" after the turn completes.
  it('invalidates the session list when the cached summary still calls the conversation a Draft', async () => {
    activeChatsStore.updateChat(sessionId, {
      orchestrationSessionStarted: true,
      currentSessionId: sessionId,
    });
    cachedSessionList = [{ threadId: sessionId, draft: true }];
    try {
      const { result } = renderHook(() => useSendMessage('http://api.test'));
      await act(async () => {
        await result.current(sessionId, 'codex', sessionId, 'first message');
      });
    } finally {
      cachedSessionList = [];
    }

    expect(invalidateMock).toHaveBeenCalledWith(['orchestration-sessions']);
  });

  // #2310 review F4: a Failed row whose only failure is that its sends did
  // not take is stale the moment a retry is accepted.
  it('invalidates the session list when the cached summary is a first-send failure', async () => {
    activeChatsStore.updateChat(sessionId, {
      orchestrationSessionStarted: true,
      currentSessionId: sessionId,
    });
    cachedSessionList = [
      {
        threadId: sessionId,
        draft: false,
        lifecycleState: 'queued',
        terminalAttribution: {
          kind: 'send_refused',
          detail: 'Station refused the send before it started.',
        },
      },
    ];
    try {
      const { result } = renderHook(() => useSendMessage('http://api.test'));
      await act(async () => {
        await result.current(sessionId, 'codex', sessionId, 'retry');
      });
    } finally {
      cachedSessionList = [];
    }

    expect(invalidateMock).toHaveBeenCalledWith(['orchestration-sessions']);
  });

  it('does not invalidate for a cached summary that is not a Draft', async () => {
    activeChatsStore.updateChat(sessionId, {
      orchestrationSessionStarted: true,
      currentSessionId: sessionId,
    });
    cachedSessionList = [{ threadId: sessionId, draft: false }];
    try {
      const { result } = renderHook(() => useSendMessage('http://api.test'));
      await act(async () => {
        await result.current(sessionId, 'codex', sessionId, 'next message');
      });
    } finally {
      cachedSessionList = [];
    }

    expect(invalidateMock).not.toHaveBeenCalledWith(['orchestration-sessions']);
  });

  it('invalidates inventories when a continuation child becomes the current execution Session', async () => {
    activeChatsStore.updateChat(sessionId, {
      orchestrationSessionStarted: true,
      currentSessionId: sessionId,
    });
    sendExecutionMessageMock.mockResolvedValueOnce({
      ...successReceipt(),
      sessionId: `${sessionId}:session:child-1`,
    });

    const { result } = renderHook(() => useSendMessage('http://api.test'));

    await act(async () => {
      await result.current(sessionId, 'codex', sessionId, 'continue');
    });

    expect(activeChatsStore.getSnapshot()[sessionId]?.currentSessionId).toBe(
      `${sessionId}:session:child-1`,
    );
    expect(invalidateMock).toHaveBeenCalledWith(['orchestration-sessions']);
    expect(invalidateMock).toHaveBeenCalledWith(['conversation-inventory']);
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
    expect(steerOrchestrationTurnMock).not.toHaveBeenCalled();
    expect(activeChatsStore.getSnapshot()[sessionId]?.queuedMessages).toEqual(
      [],
    );
  });

  it('does not steer a durable replay into the open Claude turn', async () => {
    activeChatsStore.updateChat(sessionId, {
      status: 'sending',
      orchestrationProvider: 'claude',
      openTurnId: 'turn-open',
    });
    const { result } = renderHook(() => useSendMessage('http://api.test'));

    await act(async () => {
      await result.current(
        sessionId,
        'claude',
        undefined,
        'durable replay only',
        undefined,
        undefined,
        'existing-turn-id',
        { skipInMemoryQueueOnBusy: true },
      );
    });

    expect(steerOrchestrationTurnMock).not.toHaveBeenCalled();
    expect(sendExecutionMessageMock).not.toHaveBeenCalled();
    expect(activeChatsStore.getSnapshot()[sessionId]?.queuedMessages).toEqual(
      [],
    );
  });

  describe('#2309: busy, steer and the send window come from the server record', () => {
    const openRecord = (conversationId: string, turnId = 'server-turn') => ({
      conversationId,
      asOfSequence: 10,
      openTurn: {
        turnId,
        threadId: `${conversationId}:child`,
        startedAt: '2026-09-22T18:55:25.000Z',
      },
    });

    it('steers the server-named child turn when the record shows one open, even with local status idle', async () => {
      const conv = 'claude:steer-record-conv';
      steerOrchestrationTurnMock.mockResolvedValueOnce({
        outcome: 'steered',
        threadId: `${conv}:child`,
        turnId: 'server-turn',
      });
      activeChatsStore.updateChat(sessionId, {
        status: 'idle',
        orchestrationProvider: 'claude',
        conversationId: conv,
        currentSessionId: 'stale-root',
        openTurnId: 'stale-local-turn',
        conversationActivity: openRecord(conv),
      });
      const { result } = renderHook(() => useSendMessage('http://api.test'));
      await act(async () => {
        await result.current(sessionId, 'claude', sessionId, 'steer me');
      });
      expect(sendExecutionMessageMock).not.toHaveBeenCalled();
      expect(steerOrchestrationTurnMock).toHaveBeenCalledWith({
        threadId: `${conv}:child`,
        text: 'steer me',
        turnId: 'server-turn',
        apiBase: 'http://api.test',
      });
    });

    it('queues behind a turn only the record knows about (another device, local status idle)', async () => {
      const conv = 'claude:queue-record-conv';
      activeChatsStore.updateChat(sessionId, {
        status: 'idle',
        orchestrationProvider: 'claude',
        conversationId: conv,
        conversationActivity: openRecord(conv),
      });
      const { result } = renderHook(() => useSendMessage('http://api.test'));
      await act(async () => {
        await result.current(
          sessionId,
          'claude',
          sessionId,
          'after that turn',
          undefined,
          undefined,
          undefined,
          { queueOnBusy: true },
        );
      });
      expect(sendExecutionMessageMock).not.toHaveBeenCalled();
      expect(steerOrchestrationTurnMock).not.toHaveBeenCalled();
      expect(activeChatsStore.getSnapshot()[sessionId]?.queuedMessages).toEqual(
        ['after that turn'],
      );
    });

    it('a stale status sending outside the send window, with a closed record, does not block a new send', async () => {
      const conv = 'claude:stale-sending-conv';
      activeChatsStore.updateChat(sessionId, {
        status: 'sending',
        orchestrationProvider: 'claude',
        conversationId: conv,
        conversationActivity: { conversationId: conv, asOfSequence: 20 },
      });
      // Premise: the window flag is not set.
      expect(
        activeChatsStore.getSnapshot()[sessionId]?.sendAwaitingTurnStart,
      ).toBeUndefined();
      const { result } = renderHook(() => useSendMessage('http://api.test'));
      await act(async () => {
        await result.current(sessionId, 'claude', sessionId, 'fresh turn');
      });
      expect(steerOrchestrationTurnMock).not.toHaveBeenCalled();
      expect(sendExecutionMessageMock).toHaveBeenCalledTimes(1);
      expect(activeChatsStore.getSnapshot()[sessionId]?.queuedMessages).toEqual(
        [],
      );
    });

    it('a real send opens the window: the turn is in flight before the server opens it, and the record opening it closes the window', async () => {
      const conv = 'claude:window-send-conv';
      let resolveDispatch: (value: unknown) => void = () => {};
      sendExecutionMessageMock.mockImplementationOnce(
        () => new Promise((resolve) => (resolveDispatch = resolve)),
      );
      activeChatsStore.updateChat(sessionId, {
        status: 'idle',
        orchestrationProvider: 'claude',
        conversationId: conv,
        conversationActivity: { conversationId: conv, asOfSequence: 30 },
      });
      const { result } = renderHook(() => useSendMessage('http://api.test'));
      let pending: Promise<unknown> = Promise.resolve();
      await act(async () => {
        pending = result.current(sessionId, 'claude', sessionId, 'go');
        await Promise.resolve();
      });
      const during = activeChatsStore.getSnapshot()[sessionId];
      expect(during?.sendAwaitingTurnStart).toBe(true);
      expect(isTurnInFlight(during)).toBe(true);

      act(() =>
        activeChatsStore.applyConversationActivity({
          ...openRecord(conv, 'turn-from-this-send'),
          asOfSequence: 31,
        }),
      );
      expect(
        activeChatsStore.getSnapshot()[sessionId]?.sendAwaitingTurnStart,
      ).toBeUndefined();
      expect(isTurnInFlight(activeChatsStore.getSnapshot()[sessionId])).toBe(
        true,
      );
      await act(async () => {
        resolveDispatch(successReceipt(conv));
        await pending;
      });
    });

    it('a send right after a settled Stop stays in flight while the record still names the stopped turn (review F3)', async () => {
      const conv = 'claude:after-stop-conv';
      let resolveDispatch: (value: unknown) => void = () => {};
      sendExecutionMessageMock.mockImplementationOnce(
        () => new Promise((resolve) => (resolveDispatch = resolve)),
      );
      // The Stop receipt settled turn T1; its turn.aborted has not landed, so
      // the record still shows T1 open.
      activeChatsStore.updateChat(sessionId, {
        status: 'idle',
        orchestrationProvider: 'claude',
        conversationId: conv,
        conversationActivity: openRecord(conv, 'T1'),
        stopSettledTurnId: 'T1',
      });
      expect(isTurnInFlight(activeChatsStore.getSnapshot()[sessionId])).toBe(
        false,
      );
      const { result } = renderHook(() => useSendMessage('http://api.test'));
      let pending: Promise<unknown> = Promise.resolve();
      await act(async () => {
        pending = result.current(sessionId, 'claude', sessionId, 'next');
        await Promise.resolve();
      });
      // A new turn, not a steer into the stopped one...
      expect(steerOrchestrationTurnMock).not.toHaveBeenCalled();
      // ...and in flight, so a second Enter queues instead of dispatching.
      const during = activeChatsStore.getSnapshot()[sessionId];
      expect(during?.sendAwaitingTurnStart).toBe(true);
      expect(isTurnInFlight(during)).toBe(true);
      await act(async () => {
        resolveDispatch(successReceipt(conv));
        await pending;
      });
    });
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

  it('keeps a successful Stop out of the send-failure projection when abort releases the foreground request (#898)', async () => {
    activeChatsStore.updateChat(sessionId, {
      status: 'idle',
      abortController: undefined,
    });
    sendExecutionMessageMock.mockImplementationOnce(
      (_base: string, _input: unknown, { signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const { result } = renderHook(() => ({
      send: useSendMessage('http://api.test'),
      cancel: useCancelMessage('http://api.test'),
    }));

    let send: Promise<unknown> | undefined;
    await act(async () => {
      send = result.current.send(
        sessionId,
        'codex',
        'server-thread-1',
        'please stop this turn',
      );
      await vi.waitFor(() =>
        expect(sendExecutionMessageMock).toHaveBeenCalledOnce(),
      );
    });

    let outcome: StopTurnOutcome | undefined;
    await act(async () => {
      outcome = await result.current.cancel(sessionId);
      await send;
    });

    expect(outcome).toEqual({ kind: 'settled', result: cooperativeStop });
    expect(activeChatsStore.getSnapshot()[sessionId]).toMatchObject({
      status: 'idle',
      stopPending: false,
      abortController: undefined,
    });
    expect(activeChatsStore.getSnapshot()[sessionId]?.error).toBeUndefined();
    expect(clearEphemeralMessagesMock).not.toHaveBeenCalled();
    expect(addEphemeralMessageMock).not.toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        content: expect.stringContaining('An unknown error occurred'),
      }),
    );
  });

  it('interrupts the receipted continuation Session instead of the conversation root', async () => {
    activeChatsStore.updateChat(sessionId, {
      currentSessionId: 'server-thread-1:session:child-2',
    });
    const { result } = renderHook(() => useCancelMessage('http://api.test'));

    await act(async () => {
      await result.current(sessionId);
    });

    expect(interruptOrchestrationTurnMock).toHaveBeenCalledWith({
      threadId: 'server-thread-1:session:child-2',
      apiBase: 'http://api.test',
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

  it('does not dispatch a second interrupt after the first receipt settles but before its terminal event arrives (#921)', async () => {
    interruptOrchestrationTurnMock
      .mockResolvedValueOnce(cooperativeStop)
      .mockResolvedValueOnce({
        outcome: 'no-active-turn',
        threadId: 'server-thread-1',
      });
    activeChatsStore.updateChat(sessionId, {
      orchestrationTurnOpen: true,
      error: undefined,
    });
    const { result } = renderHook(() => useCancelMessage('http://api.test'));

    let first: StopTurnOutcome | undefined;
    let second: StopTurnOutcome | undefined;
    await act(async () => {
      first = await result.current(sessionId);
      // A real double-click can put the second click after the fast HTTP
      // receipt but before turn.aborted reaches the browser event stream.
      second = await result.current(sessionId);
    });

    expect(first).toEqual({ kind: 'settled', result: cooperativeStop });
    expect(second).toEqual({ kind: 'not-running' });
    expect(interruptOrchestrationTurnMock).toHaveBeenCalledTimes(1);
    expect(activeChatsStore.getSnapshot()[sessionId]).toMatchObject({
      status: 'idle',
      orchestrationTurnOpen: false,
      stopPending: false,
    });
    expect(activeChatsStore.getSnapshot()[sessionId]?.error).toBeUndefined();
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
