import { useEffect, useRef } from 'react';
import {
  decideStreamingHaptic,
  triggerHaptic,
} from '../platform/native/haptics';

/**
 * Light selection pulses while an assistant turn's streaming text grows.
 * Hydrate-safe: the first observation after a conversation change is silent.
 */
export function useStreamingHaptics(
  conversationId: string | null | undefined,
  streamingTextLength: number,
): void {
  const stateRef = useRef({
    previousConversationId: null as string | null,
    previousTextLength: 0,
    lastHapticAtMs: 0,
    hydrated: false,
  });

  useEffect(() => {
    if (!conversationId) return;
    const decision = decideStreamingHaptic({
      conversationId,
      streamingTextLength,
      previousConversationId: stateRef.current.previousConversationId,
      previousTextLength: stateRef.current.previousTextLength,
      lastHapticAtMs: stateRef.current.lastHapticAtMs,
      hydrated: stateRef.current.hydrated,
      nowMs: Date.now(),
    });
    stateRef.current = {
      previousConversationId: decision.previousConversationId,
      previousTextLength: decision.previousTextLength,
      lastHapticAtMs: decision.lastHapticAtMs,
      hydrated: decision.hydrated,
    };
    if (decision.fire) triggerHaptic('selection');
  }, [conversationId, streamingTextLength]);
}
