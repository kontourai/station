import { describe, expect, test } from 'vitest';
import { acceptedTurnReply } from '../../tests/live/helpers/accepted-turn-reply.mjs';

describe('real-engine reply proof', () => {
  test('rejects quota failures instead of treating their assistant text as success', () => {
    expect(() =>
      acceptedTurnReply(
        [
          {
            method: 'runtime.error',
            turnId: 'current',
            message: "You've hit your session limit",
          },
        ],
        'current',
        'ACK',
      ),
    ).toThrow('session limit');
  });
  test('a partial message or another turn completion cannot satisfy the accepted turn', () => {
    expect(
      acceptedTurnReply(
        [{ method: 'message.completed', turnId: 'current', outputText: 'ACK' }],
        'current',
        'ACK',
      ),
    ).toBe(false);
    expect(
      acceptedTurnReply(
        [
          {
            method: 'turn.completed',
            turnId: 'previous',
            finishReason: 'stop',
            outputText: 'ACK',
          },
        ],
        'current',
        'ACK',
      ),
    ).toBe(false);
  });
  test('requires the expected content and a proven finish', () => {
    for (const row of [
      { finishReason: 'other', outputText: 'ACK' },
      { finishReason: 'stop', outputText: 'quota exceeded' },
    ])
      expect(() =>
        acceptedTurnReply(
          [{ method: 'turn.completed', turnId: 'current', ...row }],
          'current',
          'ACK',
        ),
      ).toThrow();
    expect(
      acceptedTurnReply(
        [
          {
            method: 'runtime.error',
            turnId: 'previous',
            message: 'old failure',
          },
          {
            method: 'turn.completed',
            turnId: 'current',
            finishReason: 'stop',
            outputText: ' ACK\n',
          },
        ],
        'current',
        'ACK',
      ),
    ).toBe(true);
  });
});
