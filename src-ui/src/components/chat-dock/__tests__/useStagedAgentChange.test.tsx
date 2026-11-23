// @vitest-environment jsdom

import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import { STAGED_CONVERSATION_HANDOFF_PREVIEW } from '@kontourai/station-contracts/orchestration';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import type { AgentData } from '../../../contexts/AgentsContext';
import type { ChatSession } from '../../../types';
import { useStagedAgentChange } from '../useStagedAgentChange';

const harness = vi.hoisted(() => ({
  post: vi.fn(),
  lookup: vi.fn(),
  withdraw: vi.fn(),
  updateChat: vi.fn(),
  readChats: vi.fn(),
  retained: new Map<string, unknown>(),
}));

vi.mock('@kontourai/station-sdk', () => ({
  useFeaturePreviewsQuery: () => ({
    data: [{ id: STAGED_CONVERSATION_HANDOFF_PREVIEW.id, enabled: true }],
  }),
}));

vi.mock('@kontourai/station-sdk/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk/client')>()),
  handoffExecutionMessage: harness.post,
  getConversationHandoffStatus: harness.lookup,
  withdrawUnreservedConversationHandoff: harness.withdraw,
}));

vi.mock('../../../contexts/ActiveChatsContext', () => ({
  activeChatsStore: { getSnapshot: harness.readChats },
  useActiveChatActions: () => ({ updateChat: harness.updateChat }),
}));

vi.mock('../../../lib/staged-handoff-attempt-store', () => ({
  stagedHandoffAttempts: {
    read: async (key: string) => harness.retained.get(key),
    write: async (key: string, value: unknown) => {
      harness.retained.set(key, value);
    },
    remove: async (key: string) => {
      harness.retained.delete(key);
    },
  },
}));

vi.mock('../../../lib/outboundQueue', () => ({
  outboundDispatch: {
    fenceConversationHandoff: async (
      _source: unknown,
      dispatch: () => Promise<unknown>,
    ) => ({ status: 'completed', value: await dispatch() }),
  },
}));

const agentA: AgentData = {
  slug: agentId('agent-a'),
  name: 'Agent A',
  execution: { agentConnectionId: engineConnectionId('engine-a') },
};
const agentB: AgentData = {
  slug: agentId('agent-b'),
  name: 'Agent B',
  execution: { agentConnectionId: engineConnectionId('engine-b') },
};
const source: ChatSession = {
  id: 'chat',
  conversationId: 'conversation',
  currentSessionId: 'source',
  agentSlug: agentA.slug,
  agentName: 'Agent A',
  status: 'idle',
  title: 'Conversation',
  source: 'manual',
  messages: [],
  input: 'first turn',
  inputHistory: [],
  attachments: [],
  queuedMessages: [],
  createdAt: 1,
  updatedAt: 1,
  model: 'original-model',
  providerOptions: { effort: 'low' },
};
const scope = { apiBase: 'http://station.test', authorityKey: 'authority' };

function mount(requestScope = scope) {
  const report = vi.fn();
  const clear = vi.fn();
  const prepared = vi.fn(async () => ({
    text: 'first turn',
    draft: 'first turn',
    quotes: [],
  }));
  const composer = {
    attachments: [],
    attachmentStages: [],
    prepareOutgoingText: prepared,
    handleClearInput: clear,
    cancelAttachmentStage: vi.fn(),
  };
  const mounted = renderHook(() =>
    useStagedAgentChange({
      apiBase: scope.apiBase,
      chat: source,
      scope: requestScope,
      recoveryAuthority: 'stable-principal-and-station',
      agents: [agentA, agentB],
      scopeIsCurrent: () => true,
      composer,
      onAccepted: vi.fn(),
      report,
    }),
  );
  return { ...mounted, clear, prepared, report };
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  harness.retained.clear();
  harness.lookup.mockRejectedValue(
    Object.assign(new Error('No reservation'), {
      status: 404,
      stationEnvelope: true,
    }),
  );
  harness.readChats.mockReturnValue({
    chat: { ...source, input: 'first turn', attachments: [] },
  });
});

test('choosing A after staging B restores A without a send or a chat update', () => {
  const { result, prepared } = mount();
  act(() => result.current.stage(agentB));
  act(() => result.current.changeModel('different-model'));
  act(() => result.current.changeOption('effort', 'high'));
  expect(result.current.selected?.agent.slug).toBe('agent-b');
  act(() => result.current.stage(agentA));
  expect(result.current.selected).toBeUndefined();
  expect(harness.post).not.toHaveBeenCalled();
  expect(harness.updateChat).not.toHaveBeenCalled();
  expect(prepared).not.toHaveBeenCalled();
});

test('Send binds the selected model and source, then retries the original request after response loss', async () => {
  const { result, clear, prepared } = mount();
  act(() => result.current.stage(agentB));
  act(() => result.current.changeModel('engine-b/model-2'));
  harness.post.mockRejectedValueOnce(new TypeError('connection lost'));
  await act(async () => result.current.send());
  expect(clear).not.toHaveBeenCalled();
  expect(result.current.pending).toBeDefined();
  expect(harness.post).toHaveBeenCalledWith(
    scope.apiBase,
    'conversation',
    expect.objectContaining({
      message: 'first turn',
      target: expect.objectContaining({
        agent: 'agent-b',
        expectedEngine: { kind: 'connection', connectionId: 'engine-b' },
        model: { override: 'engine-b/model-2', options: undefined },
      }),
      stagedHandoff: {
        expectedCurrentSessionId: 'source',
        contextPolicy: 'continue-from-history',
      },
    }),
    { requestScope: scope },
  );
  const exact = harness.post.mock.calls[0]?.[2];
  act(() => result.current.changeModel('later-model'));
  prepared.mockResolvedValueOnce({
    text: 'newer draft',
    draft: 'newer draft',
    quotes: [],
  });
  harness.post.mockResolvedValueOnce({
    handoff: {
      currentSessionId: 'new-session',
      predecessorSessionId: 'source',
      target: {
        agentId: 'agent-b',
        engine: { kind: 'connection', connectionId: 'engine-b' },
        modelId: 'engine-b/model-2',
      },
    },
  });
  await act(async () => result.current.send());
  expect(harness.post.mock.calls[1]?.[2]).toEqual(exact);
  expect(prepared).toHaveBeenCalledTimes(1);
  expect(harness.updateChat).toHaveBeenCalledWith(
    'chat',
    expect.objectContaining({
      currentSessionId: 'new-session',
      requestedModel: 'engine-b/model-2',
    }),
  );
  expect(clear).toHaveBeenCalledTimes(1);
  expect(result.current.pending).toBeUndefined();
});

test('a verified refusal with no reservation keeps the draft and allows a corrected Send', async () => {
  const { result, clear } = mount();
  act(() => result.current.stage(agentB));
  harness.post.mockRejectedValueOnce(
    Object.assign(new Error('Queued follow-up'), {
      status: 409,
      stationEnvelope: true,
    }),
  );
  harness.lookup.mockRejectedValueOnce(
    Object.assign(new Error('No reservation'), {
      status: 404,
      stationEnvelope: true,
    }),
  );
  await act(async () => result.current.send());
  expect(clear).not.toHaveBeenCalled();
  expect(result.current.selected?.agent.slug).toBe('agent-b');
  expect(result.current.pending).toBeUndefined();
});

test('reload checks the same key without sending or consuming the draft', async () => {
  const first = mount();
  act(() => first.result.current.stage(agentB));
  harness.post.mockRejectedValueOnce(new TypeError('connection lost'));
  await act(async () => first.result.current.send());
  const sent = harness.post.mock.calls[0]?.[2];
  first.unmount();

  const newScope = { ...scope, authorityKey: 'new-activation' };
  const restored = mount(newScope);
  expect(restored.result.current.selected).toBeUndefined();
  expect(restored.result.current.pending).toBeDefined();
  harness.lookup.mockResolvedValueOnce({
    status: 'completed',
    providerTurnId: 'turn',
  });
  await act(async () => restored.result.current.send());
  expect(harness.lookup).toHaveBeenCalledWith(
    scope.apiBase,
    'conversation',
    sent.idempotencyKey,
    { requestScope: newScope },
  );
  expect(harness.post).toHaveBeenCalledTimes(1);
  expect(restored.clear).not.toHaveBeenCalled();
  expect(restored.result.current.pending).toBeUndefined();
});

test('reconnect retries an exact request that never reached Station', async () => {
  const first = mount();
  act(() => first.result.current.stage(agentB));
  harness.post.mockRejectedValueOnce(new TypeError('request dropped'));
  await act(async () => first.result.current.send());
  const exact = harness.post.mock.calls[0]?.[2];
  first.unmount();

  const restored = mount({ ...scope, authorityKey: 'reconnected' });
  harness.lookup.mockRejectedValue(
    Object.assign(new Error('No reservation'), {
      status: 404,
      stationEnvelope: true,
    }),
  );
  await act(async () => restored.result.current.send());
  expect(restored.result.current.canRetry).toBe(true);
  expect(harness.post).toHaveBeenCalledTimes(1);
  harness.post.mockResolvedValueOnce({
    handoff: {
      currentSessionId: 'successor',
      predecessorSessionId: 'source',
      target: {
        agentId: 'agent-b',
        engine: { kind: 'connection', connectionId: 'engine-b' },
      },
    },
  });
  await act(async () => restored.result.current.send());
  expect(harness.post.mock.calls[1]?.[2]).toEqual(exact);
  expect(restored.prepared).not.toHaveBeenCalled();
  expect(restored.result.current.pending).toBeUndefined();
});

test('the staged Send refuses while a recorded approval choice needs to be carried', async () => {
  const { result, clear } = mount();
  act(() => result.current.stage(agentB));
  harness.readChats.mockReturnValue({
    chat: { ...source, queuedApprovalMode: 'ask' },
  });
  await act(async () => result.current.send());
  expect(harness.post).not.toHaveBeenCalled();
  expect(clear).not.toHaveBeenCalled();
  expect(result.current.selected?.agent.slug).toBe('agent-b');
});

test('a recovered request refused without a reservation releases the fence and keeps the draft', async () => {
  const initial = mount();
  act(() => initial.result.current.stage(agentB));
  harness.post.mockRejectedValueOnce(new TypeError('request dropped'));
  await act(async () => initial.result.current.send());
  initial.unmount();

  const restored = mount({ ...scope, authorityKey: 'reconnected' });
  await act(async () => restored.result.current.send());
  harness.post.mockRejectedValueOnce(
    Object.assign(new Error('Source Session changed'), {
      status: 409,
      stationEnvelope: true,
    }),
  );
  await act(async () => restored.result.current.send());
  expect(harness.post).toHaveBeenCalledTimes(2);
  expect(harness.withdraw).toHaveBeenCalledTimes(1);
  expect(restored.result.current.pending).toBeUndefined();
  expect(restored.clear).not.toHaveBeenCalled();
  expect(harness.retained.size).toBe(0);
});

test('a refusal cannot release the fence if Station has reserved the earlier request', async () => {
  const { result, clear } = mount();
  act(() => result.current.stage(agentB));
  harness.post.mockRejectedValueOnce(new TypeError('request dropped'));
  await act(async () => result.current.send());
  harness.post.mockRejectedValueOnce(
    Object.assign(new Error('Preview disabled'), {
      status: 404,
      stationEnvelope: true,
    }),
  );
  harness.withdraw.mockRejectedValueOnce(new Error('Reservation exists'));
  await act(async () => result.current.send());
  expect(result.current.pending).toBeDefined();
  expect(clear).not.toHaveBeenCalled();
  expect(harness.retained.size).toBe(1);
});

test('an expired body can be withdrawn only with an exact Station receipt', async () => {
  const initial = mount();
  act(() => initial.result.current.stage(agentB));
  harness.post.mockRejectedValueOnce(new TypeError('request dropped'));
  await act(async () => initial.result.current.send());
  const exact = harness.post.mock.calls[0]?.[2];
  initial.unmount();
  harness.retained.clear();

  const restored = mount({ ...scope, authorityKey: 'reconnected' });
  await act(async () => restored.result.current.send());
  expect(restored.result.current.canWithdraw).toBe(true);
  expect(harness.withdraw).not.toHaveBeenCalled();
  await act(async () => restored.result.current.withdraw());
  expect(harness.withdraw).toHaveBeenCalledWith(
    scope.apiBase,
    'conversation',
    exact.idempotencyKey,
    { requestScope: { ...scope, authorityKey: 'reconnected' } },
  );
  expect(restored.result.current.pending).toBeUndefined();
  expect(restored.clear).not.toHaveBeenCalled();
});
