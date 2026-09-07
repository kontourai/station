import type { ConversationOpenResolution } from '@kontourai/station-contracts/orchestration';
import { describe, expect, test, vi } from 'vitest';
import {
  commitConversationOpen,
  conversationOpenPatch,
} from '../components/chat-dock/conversationOpenController';
import {
  conversationCanMutate,
  conversationOpenPhase,
} from '../contexts/conversation-open-policy';

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

function resolved(canContinue = true): ConversationOpenResolution {
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

  // #1582 E3/B6. The gate above says what may be WRITTEN; the phase says what
  // is KNOWN, and the two answers differ exactly where the defect was: pending
  // and failed both block writes, and only one of them is a failure.
  test('the phase separates a don-t-know-yet from a verdict', () => {
    expect(conversationOpenPhase({})).toBe('writable');
    expect(conversationOpenPhase({ conversationOpenPending: true })).toBe(
      'resolving',
    );
    expect(conversationOpenPhase({ conversationOpenFailed: true })).toBe(
      'read-only',
    );
    expect(
      conversationOpenPhase({ conversationOpenState: resolved(false) }),
    ).toBe('read-only');
    expect(
      conversationOpenPhase({ conversationOpenState: resolved(true) }),
    ).toBe('writable');
    // A resolution left over from a prior read is not an answer about the read
    // now in flight: pending wins over BOTH a stale success and a stale
    // failure, so a re-open of a previously-broken conversation does not paint
    // the old verdict while the new read runs.
    expect(
      conversationOpenPhase({
        conversationOpenPending: true,
        conversationOpenState: resolved(true),
      }),
    ).toBe('resolving');
    expect(
      conversationOpenPhase({
        conversationOpenPending: true,
        conversationOpenFailed: true,
      }),
    ).toBe('resolving');
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
