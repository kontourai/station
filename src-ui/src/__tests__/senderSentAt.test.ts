import { describe, expect, test } from 'vitest';
import type { ChatMessage } from '../types';
import { senderSentAt } from '../utils/senderSentAt';

/**
 * #2304 rule 2: a send time is claimed only for the sender's own pending
 * turn. Every other case must yield undefined, so the working row states the
 * server's duration or none — never a send time that is not this turn's.
 */
describe('senderSentAt', () => {
  const sent: ChatMessage = {
    role: 'user',
    content: 'go',
    clientId: 'composer-row',
    timestamp: 1_000,
  };

  test('the composer row of a send still in flight', () => {
    expect(senderSentAt({ messages: [sent], status: 'sending' })).toBe(1_000);
  });

  test('the composer row once turn.started stamped it with the open turn', () => {
    expect(
      senderSentAt({
        messages: [{ ...sent, turnId: 'turn-1' }],
        status: 'sending',
        openTurnId: 'turn-1',
      }),
    ).toBe(1_000);
  });

  test('not a send in flight', () => {
    expect(senderSentAt({ messages: [sent], status: 'idle' })).toBeUndefined();
  });

  test('a composer row for a different turn than the open one', () => {
    expect(
      senderSentAt({
        messages: [{ ...sent, turnId: 'turn-1' }],
        status: 'sending',
        openTurnId: 'turn-2',
      }),
    ).toBeUndefined();
  });

  test("another client's prompt restored from turn.started", () => {
    expect(
      senderSentAt({
        messages: [{ ...sent, clientId: 'event-input:e1' }],
        status: 'sending',
      }),
    ).toBeUndefined();
  });

  test('after a reconnect catch-up, when the turn may have changed in the gap', () => {
    expect(
      senderSentAt({
        messages: [sent],
        status: 'sending',
        openTurnShellSuperseded: true,
      }),
    ).toBeUndefined();
  });

  test('the newest user row decides, not an older composer row', () => {
    expect(
      senderSentAt({
        messages: [
          sent,
          { role: 'user', content: 'other', clientId: 'event-input:e2' },
        ],
        status: 'sending',
      }),
    ).toBeUndefined();
  });
});
