import { describe, expect, it } from 'vitest';
import { conversationAwaitsFirstTurn } from '../conversationFirstTurn';

const refused = {
  terminalAttribution: {
    kind: 'send_refused' as const,
    detail: 'Station refused the send before it started.',
  },
};

describe('conversationAwaitsFirstTurn', () => {
  it('a Draft or a first-send failure with nothing in flight has never run a turn', () => {
    expect(conversationAwaitsFirstTurn({ draft: true }, false)).toBe(true);
    expect(conversationAwaitsFirstTurn(refused, false)).toBe(true);
  });
  it('no summary, or a session that ran, is not a first turn', () => {
    expect(conversationAwaitsFirstTurn(null, false)).toBe(false);
    expect(conversationAwaitsFirstTurn({ draft: false }, false)).toBe(false);
  });
  it('a send in flight or an open turn outranks a stale summary', () => {
    expect(conversationAwaitsFirstTurn({ draft: true }, true)).toBe(false);
    expect(conversationAwaitsFirstTurn(refused, true)).toBe(false);
  });
});
