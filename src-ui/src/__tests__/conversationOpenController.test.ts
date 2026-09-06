import type { ConversationOpenResolution } from '@kontourai/station-contracts/orchestration';
import { describe, expect, test, vi } from 'vitest';
import {
  commitConversationOpen,
  conversationOpenPatch,
} from '../components/chat-dock/conversationOpenController';
import { conversationCanMutate } from '../contexts/conversation-open-policy';

const conversation = {
  id: 'conversation-749',
  source: 'runtime' as const,
  agentSlug: 'codex' as any,
  title: 'Durable answer',
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:01:00.000Z',
  messageCount: 2,
  projectSlug: 'station',
  mutable: false,
  answerability: { answerable: true as const },
};
const notAnswerable = {
  answerable: false as const,
  qualification: 'past_resume' as const,
  observedBy: 'conversation-open-test',
  observedAt: '2026-08-29T00:02:00.000Z',
};

function resolved(
  canContinue = true,
): Extract<ConversationOpenResolution, { status: 'resolved' }> {
  return {
    status: 'resolved',
    conversation,
    currentSessionId: 'conversation-749:child:2',
    transcript: { available: true, owner: 'runtime', messageCount: 2 },
    canContinue,
    answerability: { answerable: true },
    recoveryActions: [],
  };
}

describe('#749 conversation open controller', () => {
  test('one policy gates composer, inventory, Basis, and actions', () => {
    expect(conversationCanMutate({})).toBe(true);
    expect(conversationCanMutate({ conversationOpenPending: true })).toBe(
      false,
    );
    expect(conversationCanMutate({ conversationOpenFailed: true })).toBe(false);
    expect(
      conversationCanMutate({ conversationOpenState: resolved(false) }),
    ).toBe(false);
    expect(
      conversationCanMutate({ conversationOpenState: resolved(true) }),
    ).toBe(true);
  });

  test('resolved binding commits the exact current child and established lifecycle', () => {
    expect(conversationOpenPatch(resolved(true))).toMatchObject({
      conversationOpenPending: false,
      conversationOpenFailed: false,
      currentSessionId: 'conversation-749:child:2',
      orchestrationSessionStarted: true,
    });
  });

  test('non-continuable binding clears stale child and established lifecycle', () => {
    const resolution: ConversationOpenResolution = {
      status: 'missing-session',
      conversation,
      transcript: { available: false, owner: 'runtime' },
      canContinue: false,
      answerability: notAnswerable,
      recoveryActions: ['retry', 'start-new'],
    };
    expect(conversationOpenPatch(resolution)).toMatchObject({
      currentSessionId: undefined,
      orchestrationSessionStarted: false,
      conversationOpenState: resolution,
    });
  });

  test('cross-project open finishes before the authoritative child is bound', async () => {
    const order: string[] = [];
    const open = vi.fn(async (...args: unknown[]) => {
      order.push('open');
      expect(args.slice(0, 4)).toEqual([
        conversation.id,
        conversation.agentSlug,
        'station',
        'Station',
      ]);
      return true;
    });
    const outcome = await commitConversationOpen({
      resolution: resolved(true),
      open,
      projectName: () => 'Station',
      findTab: () => {
        order.push('bind');
        return 'conversation-tab';
      },
    });
    expect(order).toEqual(['open', 'bind']);
    expect(outcome).toMatchObject({
      kind: 'opened',
      tabId: 'conversation-tab',
      patch: { currentSessionId: 'conversation-749:child:2' },
    });
  });

  test('missing session never opens a guessed tab', async () => {
    const open = vi.fn();
    const outcome = await commitConversationOpen({
      resolution: {
        status: 'missing-session',
        conversation,
        transcript: { available: false, owner: 'runtime' },
        canContinue: false,
        answerability: notAnswerable,
        recoveryActions: ['retry', 'start-new'],
      },
      open,
      projectName: () => 'Station',
      findTab: () => 'conversation-tab',
    });
    expect(open).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      kind: 'recovery',
      recovery: { status: 'missing-session' },
    });
  });
});

test('restored Codex state adopts the current Claude child without carrying model or permission state', () => {
  const previous = {
    conversationId: conversation.id,
    currentSessionId: 'old-codex',
    agentSlug: 'codex',
    agentName: 'Old Codex',
    provider: 'codex',
    orchestrationModel: 'gpt-sidebar-old',
    agentConnectionId: 'old-codex-connection',
    model: 'gpt-old',
    requestedModel: 'gpt-deliberate',
    requestedProviderOptions: { reasoningEffort: 'high' },
    providerOptions: { fastMode: true },
    input: 'Keep this unsent follow-up',
    queuedMessages: ['Queued follow-up'],
    sessionAutoApprove: ['shell'],
    pendingApprovals: [],
  };
  const resolution: ConversationOpenResolution = {
    ...resolved(),
    conversation: { ...conversation, agentSlug: 'claude-agent' as any },
    execution: {
      sessionId: 'conversation-749:child:2',
      agentId: 'claude-agent' as any,
      provider: 'claude',
      engineConnectionId: 'claude-connection',
      model: 'sonnet-current',
    },
  };
  const patch = conversationOpenPatch(resolution, previous);
  const actual = { ...previous, ...patch };
  expect(actual).toMatchObject({
    currentSessionId: resolution.currentSessionId,
    agentSlug: 'claude-agent',
    provider: 'claude',
    agentConnectionId: 'claude-connection',
    model: 'sonnet-current',
    orchestrationModel: 'sonnet-current',
    requestedModel: null,
    requestedProviderOptions: {},
    providerOptions: {},
    sessionAutoApprove: [],
    input: 'Keep this unsent follow-up',
    queuedMessages: ['Queued follow-up'],
  });
  expect(actual.queuedMessageFailure?.message).toContain(
    'Review queued messages',
  );
  expect(conversationCanMutate(actual)).toBe(true);
});

test('same-child deliberate model intent waits for capability evidence and survives only a valid choice', () => {
  const resolution: ConversationOpenResolution = {
    ...resolved(),
    execution: {
      sessionId: 'conversation-749:child:2',
      agentId: conversation.agentSlug,
      provider: 'codex',
      model: 'current-model',
    },
  };
  const previous = {
    conversationId: conversation.id,
    currentSessionId: resolution.currentSessionId,
    agentSlug: conversation.agentSlug,
    provider: 'codex',
    requestedModel: 'chosen-model',
    requestedProviderOptions: { reasoningEffort: 'high' },
    input: 'draft',
  };
  const pending = conversationOpenPatch(resolution, previous);
  expect(pending.conversationOpenPending).toBe(true);
  expect(pending.requestedModel).toBe('chosen-model');
  expect(conversationCanMutate({ ...previous, ...pending })).toBe(false);
  const valid = conversationOpenPatch(resolution, previous, {
    validModelIds: ['chosen-model'],
    providerOptions: { effort: 'high' },
  });
  expect(valid).toMatchObject({
    conversationOpenPending: false,
    requestedModel: 'chosen-model',
    requestedProviderOptions: { effort: 'high' },
  });
  const invalid = conversationOpenPatch(resolution, previous, {
    validModelIds: [],
  });
  expect(invalid.requestedModel).toBeNull();
  expect(invalid.error).toContain('saved model choice');
});

test('a changed child from an older server cannot retain writable predecessor identity', () => {
  const previous = {
    conversationId: conversation.id,
    currentSessionId: 'old-codex',
    agentSlug: conversation.agentSlug,
    provider: 'codex',
    model: 'old-model',
    requestedModel: 'old-model',
    input: 'draft',
  };
  const actual = {
    ...previous,
    ...conversationOpenPatch(resolved(), previous),
  };
  expect(actual.agentSlug).toBeUndefined();
  expect(actual.provider).toBeUndefined();
  expect(actual.requestedModel).toBeNull();
  expect(actual.input).toBe('draft');
  expect(conversationCanMutate(actual)).toBe(false);
});
