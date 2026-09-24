/** @vitest-environment jsdom */

/**
 * station#2530 review 4: `isUnmatchedPendingRowStillPending` decides whether
 * a local echo/optimistic user row that could not be matched against the
 * bounded server window still deserves to render. Before this fix every
 * unmatched row survived unconditionally, resurrecting a stale event-input
 * echo row as a phantom duplicate once its own turn aged out of the window
 * on a long-lived connection. See useActiveChatTranscript.ts for the full
 * call site and its docblock.
 */
import { describe, expect, test } from 'vitest';
import type { ChatMessage } from '../../../types';
import { isUnmatchedPendingRowStillPending } from '../useActiveChatTranscript';

function userMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    role: 'user',
    content: 'hello',
    clientId: 'client-1',
    ...overrides,
  };
}

describe('isUnmatchedPendingRowStillPending', () => {
  test('a stale event-input echo row, whose own turn has aged out of the window, is NOT kept', () => {
    const message = userMessage({ turnId: 'turn-old' });
    expect(
      isUnmatchedPendingRowStillPending(
        message,
        /* currentPending */ undefined,
        /* windowOpenTurnId */ 'turn-current',
        /* sessionOpenTurnId */ undefined,
      ),
    ).toBe(false);
  });

  test('the current pending send is kept even when its turn is not the window-open turn', () => {
    const currentPending = userMessage({ turnId: undefined });
    expect(
      isUnmatchedPendingRowStillPending(
        currentPending,
        currentPending,
        'turn-current',
        undefined,
      ),
    ).toBe(true);
  });

  test('a row with no turnId at all (the reconnect-gap case) is kept', () => {
    const message = userMessage({ turnId: undefined });
    expect(
      isUnmatchedPendingRowStillPending(message, undefined, 'turn-current', undefined),
    ).toBe(true);
  });

  test('a row whose turn the window itself still shows open is kept', () => {
    const message = userMessage({ turnId: 'turn-current' });
    expect(
      isUnmatchedPendingRowStillPending(
        message,
        undefined,
        'turn-current',
        undefined,
      ),
    ).toBe(true);
  });

  test('a row whose turn matches the session-level open turn (no window record yet) is kept', () => {
    const message = userMessage({ turnId: 'turn-session-open' });
    expect(
      isUnmatchedPendingRowStillPending(
        message,
        undefined,
        undefined,
        'turn-session-open',
      ),
    ).toBe(true);
  });
});
