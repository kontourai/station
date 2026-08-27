import { describe, expect, it } from 'vitest';
import {
  decideStreamingHaptic,
  STREAMING_HAPTIC_THROTTLE_MS,
} from '../haptics';

describe('decideStreamingHaptic', () => {
  it('skips the first hydrate observation after a conversation opens', () => {
    const decision = decideStreamingHaptic({
      conversationId: 'c1',
      streamingTextLength: 40,
      previousConversationId: null,
      previousTextLength: 0,
      lastHapticAtMs: 0,
      hydrated: false,
      nowMs: 1_000,
    });
    expect(decision.fire).toBe(false);
    expect(decision.hydrated).toBe(true);
    expect(decision.previousTextLength).toBe(40);
  });

  it('fires when streaming text grows after hydrate', () => {
    const decision = decideStreamingHaptic({
      conversationId: 'c1',
      streamingTextLength: 80,
      previousConversationId: 'c1',
      previousTextLength: 40,
      lastHapticAtMs: 0,
      hydrated: true,
      nowMs: 1_000,
    });
    expect(decision.fire).toBe(true);
    expect(decision.lastHapticAtMs).toBe(1_000);
    expect(decision.previousTextLength).toBe(80);
  });

  it('throttles pulses inside the window', () => {
    const decision = decideStreamingHaptic({
      conversationId: 'c1',
      streamingTextLength: 120,
      previousConversationId: 'c1',
      previousTextLength: 80,
      lastHapticAtMs: 1_000,
      hydrated: true,
      nowMs: 1_000 + STREAMING_HAPTIC_THROTTLE_MS - 1,
    });
    expect(decision.fire).toBe(false);
    expect(decision.lastHapticAtMs).toBe(1_000);
  });

  it('fires again once the throttle window elapses', () => {
    const decision = decideStreamingHaptic({
      conversationId: 'c1',
      streamingTextLength: 160,
      previousConversationId: 'c1',
      previousTextLength: 120,
      lastHapticAtMs: 1_000,
      hydrated: true,
      nowMs: 1_000 + STREAMING_HAPTIC_THROTTLE_MS,
    });
    expect(decision.fire).toBe(true);
    expect(decision.lastHapticAtMs).toBe(1_000 + STREAMING_HAPTIC_THROTTLE_MS);
  });

  it('resets hydrate on conversation change and stays silent', () => {
    const decision = decideStreamingHaptic({
      conversationId: 'c2',
      streamingTextLength: 200,
      previousConversationId: 'c1',
      previousTextLength: 160,
      lastHapticAtMs: 5_000,
      hydrated: true,
      nowMs: 6_000,
    });
    expect(decision.fire).toBe(false);
    expect(decision.previousConversationId).toBe('c2');
    expect(decision.lastHapticAtMs).toBe(0);
  });

  it('does not fire when text length is unchanged', () => {
    const decision = decideStreamingHaptic({
      conversationId: 'c1',
      streamingTextLength: 80,
      previousConversationId: 'c1',
      previousTextLength: 80,
      lastHapticAtMs: 1_000,
      hydrated: true,
      nowMs: 2_000,
    });
    expect(decision.fire).toBe(false);
  });
});
