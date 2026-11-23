import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { describe, expect, it } from 'vitest';
import {
  FOLD_FIXTURES,
  FOLD_SESSION_CREATED_AT,
} from '../../../tests/helpers/session-summary-fold-fixtures';
import { groupMobileActivity } from '../components/chat-dock/mobile-activity-groups';
import {
  type ChatUIState,
  createDefaultChatState,
} from '../contexts/active-chats-state';
import { partitionHomeWorkItems } from '../views/home/home-lane-model';
import {
  buildActiveChatTaskItems,
  buildHomeWorkItems,
} from '../views/home/home-view-model';
import { buildWorkFacts } from '../views/home/work-facts';
import { resolveWorkItemOpenAction } from '../views/home/work-item-open-policy';
import { workStatus } from '../views/home/work-status';

/**
 * #5398: a conversation holding a message whose delivery nothing can confirm
 * appears ONCE, under the group its status puts it in, with the unconfirmed
 * delivery as a flag beside that status. Before, the outbox projection's
 * `queued` status made the chat "Needs attention · Delivery unconfirmed" and
 * pulled the finished conversation into Needs you.
 *
 * Home and the dock each build their rows through the same chain:
 * `buildActiveChatTaskItems` (Home with `onlyWork`), `buildHomeWorkItems`
 * with those `chatItems`, `buildWorkFacts`, then `partitionHomeWorkItems`
 * (the dock through `groupMobileActivity`). Both are run here.
 */

const NOW = Date.parse('2026-09-30T10:01:15.000Z');
const CONVERSATION = 'station:1795332853880';

/** The server's own fold for a turn that completed (see work-status.test). */
const completed: OrchestrationSessionSummary = {
  provider: 'station',
  threadId: CONVERSATION,
  conversationId: CONVERSATION,
  status: 'running',
  createdAt: FOLD_SESSION_CREATED_AT,
  updatedAt: '2026-09-30T10:00:02.000Z',
  controlMode: 'station-owned',
  answerability: { answerable: true },
  isLoaded: true,
  isPersisted: true,
  eventCount: FOLD_FIXTURES.turnCompleted.events.length,
  ...FOLD_FIXTURES.turnCompleted.summary,
  displayTitle: 'Say hello in one short line.',
};

/**
 * What `outboundQueueProjection` writes for a chat whose outbox lists a send
 * Station may have started: `status: 'queued'` and the row's projection.
 */
function unconfirmedChat(over: Partial<ChatUIState> = {}): ChatUIState {
  return {
    ...createDefaultChatState(),
    agentSlug: 'station',
    title: 'Say hello in one short line.',
    createdAt: NOW - 120_000,
    messages: [
      {
        id: 'u1',
        role: 'user',
        content: 'Say hello in one short line.',
        timestamp: NOW - 110_000,
      },
    ] as ChatUIState['messages'],
    status: 'queued',
    outboundQueuedTurns: [
      {
        clientTurnId: 'turn-unconfirmed',
        content: 'Say hello in one short line.',
        createdAt: NOW - 110_000,
        status: 'may-have-started',
        lastError:
          'Dispatch may have started: Station could not confirm the start.',
      },
    ],
    ...over,
  };
}

function rows(
  chats: Record<string, ChatUIState>,
  sessions: OrchestrationSessionSummary[],
  surface: 'home' | 'dock',
) {
  const chatItems = buildActiveChatTaskItems({
    chats,
    agents: [],
    sessions,
    onlyWork: surface === 'home',
  });
  const items = buildHomeWorkItems({
    chats: {},
    sessions,
    retainTaskChildren: true,
    agents: [],
    chatItems,
  });
  const facts = buildWorkFacts({ items, chats, sessions });
  return { items, facts };
}

describe('an unconfirmed delivery is a flag, not a lane (#5398)', () => {
  for (const surface of ['home', 'dock'] as const) {
    it(`${surface}: the finished conversation is one Done row in Just finished, flagged`, () => {
      const { items, facts } = rows(
        { [CONVERSATION]: unconfirmedChat() },
        [completed],
        surface,
      );
      const partition = partitionHomeWorkItems({
        items,
        now: NOW,
        snoozedUntil: new Map(),
        workFacts: facts,
      });
      const all = [
        ...partition.needsYou,
        ...partition.running,
        ...partition.idle,
        ...partition.recentlyFinished,
        ...partition.settled,
      ];
      expect(all.map((item) => item.title)).toEqual([
        'Say hello in one short line.',
      ]);
      expect(partition.needsYou).toEqual([]);
      expect(partition.recentlyFinished).toHaveLength(1);
      const row = partition.recentlyFinished[0]!;
      expect(workStatus(row, NOW, facts.get(row.id))).toMatchObject({
        word: 'Done',
        lane: 'finished',
      });
      expect(facts.get(row.id)?.unconfirmedDelivery).toEqual([
        {
          chatSessionId: CONVERSATION,
          clientTurnId: 'turn-unconfirmed',
          createdAt: NOW - 110_000,
        },
      ]);

      const groups = groupMobileActivity(items, NOW, {}, facts);
      expect(
        groups
          .filter((group) => group.items.length > 0)
          .map((group) => [group.label, group.items.map((item) => item.id)]),
      ).toEqual([['Just finished', [row.id]]]);
    });
  }

  it('keeps the flag when a reopened chat of the same conversation is the one the row shows', () => {
    // A reopen mints a new chat key for the same conversation; the newer
    // chat wins the row, the older one still holds the outbox message.
    const reopened: ChatUIState = {
      ...createDefaultChatState(),
      agentSlug: 'station',
      title: 'Say hello in one short line.',
      conversationId: CONVERSATION,
      createdAt: NOW - 10_000,
      status: 'idle',
    };
    const { items, facts } = rows(
      {
        [CONVERSATION]: unconfirmedChat(),
        'station:1795332999999': reopened,
      },
      [completed],
      'dock',
    );
    expect(items).toHaveLength(1);
    expect(facts.get(items[0]!.id)?.unconfirmedDelivery).toEqual([
      {
        chatSessionId: CONVERSATION,
        clientTurnId: 'turn-unconfirmed',
        createdAt: NOW - 110_000,
      },
    ]);
    expect(workStatus(items[0]!, NOW, facts.get(items[0]!.id)).word).toBe(
      'Done',
    );
  });

  it('a send still waiting on the connection stays in Needs you as Queued to send', () => {
    const { items, facts } = rows(
      {
        [CONVERSATION]: unconfirmedChat({
          outboundQueuedTurns: [
            {
              clientTurnId: 'turn-unconfirmed',
              content: 'Say hello in one short line.',
              createdAt: NOW - 110_000,
              status: 'may-have-started',
            },
            {
              clientTurnId: 'turn-pending',
              content: 'And another.',
              createdAt: NOW - 100_000,
              status: 'pending',
            },
          ],
        }),
      },
      [completed],
      'dock',
    );
    expect(items).toHaveLength(1);
    const status = workStatus(items[0]!, NOW, facts.get(items[0]!.id));
    expect(status).toMatchObject({ word: 'Queued to send', lane: 'needsYou' });
    expect(facts.get(items[0]!.id)?.unconfirmedDelivery).toEqual([
      {
        chatSessionId: CONVERSATION,
        clientTurnId: 'turn-unconfirmed',
        createdAt: NOW - 110_000,
      },
    ]);
  });

  it('a send awaiting the delivery lookup is unconfirmed too', () => {
    const { items, facts } = rows(
      {
        [CONVERSATION]: unconfirmedChat({
          outboundQueuedTurns: [
            {
              clientTurnId: 'turn-lookup',
              content: 'Say hello in one short line.',
              createdAt: NOW - 110_000,
              status: 'invoking',
              awaitingLookup: true,
            },
          ],
        }),
      },
      [completed],
      'home',
    );
    expect(items).toHaveLength(1);
    expect(workStatus(items[0]!, NOW, facts.get(items[0]!.id)).lane).toBe(
      'finished',
    );
    expect(facts.get(items[0]!.id)?.unconfirmedDelivery).toEqual([
      {
        chatSessionId: CONVERSATION,
        clientTurnId: 'turn-lookup',
        createdAt: NOW - 110_000,
      },
    ]);
  });
  it('a chat with no server record that still reads running stays in Running, flagged', () => {
    // No session summary for this conversation, and the chat store still
    // says the send it could not confirm is running. With nothing better to
    // read, the chat's own running state stands (`chatLifecycleLabel`); the
    // flag says the message itself is in doubt.
    const { items, facts } = rows(
      {
        [CONVERSATION]: unconfirmedChat({ orchestrationStatus: 'running' }),
      },
      [],
      'dock',
    );
    expect(items).toHaveLength(1);
    expect(workStatus(items[0]!, NOW, facts.get(items[0]!.id))).toMatchObject({
      word: 'Running',
      lane: 'running',
    });
    expect(facts.get(items[0]!.id)?.unconfirmedDelivery).toHaveLength(1);
  });
  for (const surface of ['home', 'dock'] as const) {
    it(`${surface}: after a mixed Check, an older chat's message Station never received puts the row under Needs you`, () => {
      // What the outbox leaves after Check answered "not received" for the
      // older chat's message (it becomes not sent) and "started" for the
      // reopened chat's (removed): the reopened chat wins the merged row, but
      // the conversation still owes the person a resend.
      const { items, facts } = rows(
        {
          [CONVERSATION]: unconfirmedChat({
            outboundQueuedTurns: [
              {
                clientTurnId: 'turn-unconfirmed',
                content: 'Say hello in one short line.',
                createdAt: NOW - 110_000,
                status: 'failed',
                lastError: 'Station did not receive it.',
              },
            ],
          }),
          'station:1795332999999': {
            ...createDefaultChatState(),
            agentSlug: 'station',
            title: 'Say hello in one short line.',
            conversationId: CONVERSATION,
            createdAt: NOW - 10_000,
            status: 'idle',
          },
        },
        [completed],
        surface,
      );
      expect(items).toHaveLength(1);
      expect(workStatus(items[0]!, NOW, facts.get(items[0]!.id))).toMatchObject(
        { word: 'Queued to send', lane: 'needsYou' },
      );
      expect(facts.get(items[0]!.id)?.unconfirmedDelivery).toBeUndefined();
    });
  }

  /**
   * The shape a reopen writes: `useOpenConversation` mints a new chat key
   * (`<agent>:<epoch ms>`) for an existing conversation and stores the
   * conversation id on it, so the key and the conversation id differ.
   */
  const OLDER = 'station:1795332900000';
  const NEWER = 'station:1795332999999';
  function reopened(
    createdAt: number,
    over: Partial<ChatUIState> = {},
  ): ChatUIState {
    return {
      ...unconfirmedChat({
        conversationId: CONVERSATION,
        createdAt,
        status: 'idle',
        outboundQueuedTurns: [],
        messages: [
          {
            id: `m-${createdAt}`,
            role: 'user',
            content: 'Say hello in one short line.',
            timestamp: createdAt,
          },
        ] as ChatUIState['messages'],
      }),
      ...over,
    };
  }
  const held = {
    'not sent': {
      status: 'queued' as const,
      outboundQueuedTurns: [
        {
          clientTurnId: 'turn-older',
          content: 'An older message.',
          createdAt: NOW - 100_000,
          status: 'failed' as const,
        },
      ],
    },
    unconfirmed: {
      status: 'queued' as const,
      outboundQueuedTurns: [
        {
          clientTurnId: 'turn-older',
          content: 'An older message.',
          createdAt: NOW - 100_000,
          status: 'may-have-started' as const,
        },
      ],
    },
  };
  for (const surface of ['home', 'dock'] as const) {
    for (const [kind, over] of Object.entries(held)) {
      it(`${surface}: a row whose ${kind} message is in an older chat opens that chat`, () => {
        const { items, facts } = rows(
          {
            [OLDER]: reopened(NOW - 100_000, over),
            [NEWER]: reopened(NOW - 5_000),
          },
          [completed],
          surface,
        );
        expect(items).toHaveLength(1);
        const status = workStatus(items[0]!, NOW, facts.get(items[0]!.id));
        if (kind === 'not sent') expect(status.word).toBe('Queued to send');
        else
          expect(facts.get(items[0]!.id)?.unconfirmedDelivery).toHaveLength(1);
        expect(resolveWorkItemOpenAction(items[0]!)).toEqual({
          kind: 'focus',
          chatSessionId: OLDER,
        });
      });
    }
  }

  it('the flag reads every chat of the conversation, whatever their keys', () => {
    const { items, facts } = rows(
      {
        [OLDER]: reopened(NOW - 100_000, held.unconfirmed),
        [NEWER]: reopened(NOW - 5_000, {
          status: 'queued',
          outboundQueuedTurns: [
            {
              clientTurnId: 'turn-newer',
              content: 'A newer message.',
              createdAt: NOW - 5_000,
              status: 'may-have-started',
            },
          ],
        }),
      },
      [completed],
      'dock',
    );
    expect(items).toHaveLength(1);
    expect(
      facts
        .get(items[0]!.id)
        ?.unconfirmedDelivery?.map((turn) => turn.clientTurnId),
    ).toEqual(['turn-older', 'turn-newer']);
    // The newest chat holding one is the one the row opens.
    expect(items[0]!.chatSessionId).toBe(NEWER);
  });
});
