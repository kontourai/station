/**
 * Fire-and-forget haptic helpers for the React app (station#1954).
 *
 * Feature code calls these helpers; they consult the platform adapter's
 * `haptics` capability and never import Tauri or OS APIs directly.
 */

import type { HapticFeedbackKind } from './types';

export const STREAMING_HAPTIC_THROTTLE_MS = 320;

export interface StreamingHapticDecisionInput {
  /** Conversation/session id; a change resets hydrate + throttle state. */
  conversationId: string;
  /** Current streaming assistant text length (0 when not streaming). */
  streamingTextLength: number;
  previousConversationId: string | null;
  previousTextLength: number;
  lastHapticAtMs: number;
  hydrated: boolean;
  nowMs: number;
  throttleMs?: number;
}

export interface StreamingHapticDecision {
  fire: boolean;
  previousConversationId: string;
  previousTextLength: number;
  lastHapticAtMs: number;
  hydrated: boolean;
}

/**
 * Pure throttle + hydrate-skip for assistant stream growth. Port of the
 * t3code selection pattern: skip the first observation after a conversation
 * change (historical hydrate), then pulse at most once per throttle window
 * when text grows or a new stream starts.
 */
export function decideStreamingHaptic(
  input: StreamingHapticDecisionInput,
): StreamingHapticDecision {
  const throttleMs = input.throttleMs ?? STREAMING_HAPTIC_THROTTLE_MS;
  const conversationChanged =
    input.previousConversationId !== input.conversationId;

  if (conversationChanged || !input.hydrated) {
    return {
      fire: false,
      previousConversationId: input.conversationId,
      previousTextLength: input.streamingTextLength,
      lastHapticAtMs: conversationChanged ? 0 : input.lastHapticAtMs,
      hydrated: true,
    };
  }

  if (input.streamingTextLength <= 0) {
    return {
      fire: false,
      previousConversationId: input.conversationId,
      previousTextLength: 0,
      lastHapticAtMs: input.lastHapticAtMs,
      hydrated: true,
    };
  }

  const textGrew = input.streamingTextLength > input.previousTextLength;
  if (!textGrew) {
    return {
      fire: false,
      previousConversationId: input.conversationId,
      previousTextLength: input.previousTextLength,
      lastHapticAtMs: input.lastHapticAtMs,
      hydrated: true,
    };
  }

  const elapsed = input.nowMs - input.lastHapticAtMs;
  const fire = input.lastHapticAtMs === 0 || elapsed >= throttleMs;
  return {
    fire,
    previousConversationId: input.conversationId,
    previousTextLength: input.streamingTextLength,
    lastHapticAtMs: fire ? input.nowMs : input.lastHapticAtMs,
    hydrated: true,
  };
}

let hapticsUserEnabled = true;

/** Sync preference gate — set from the device-settings store (default on). */
export function setHapticsUserEnabled(enabled: boolean): void {
  hapticsUserEnabled = enabled;
}

export function isHapticsUserEnabled(): boolean {
  return hapticsUserEnabled;
}

/**
 * Request a haptic pulse. Errors and unsupported hosts are swallowed so
 * callers (copy, stream, pairing) never leak failure into product paths.
 */
export function triggerHaptic(kind: HapticFeedbackKind): void {
  if (!hapticsUserEnabled) return;
  void (async () => {
    try {
      // Dynamic import avoids a static cycle with `./index` (adapter factory).
      const { nativePlatformPromise } = await import('./index');
      const adapter = await nativePlatformPromise;
      if (adapter.capability('haptics').state !== 'enabled') return;
      await adapter.hapticFeedback(kind);
    } catch {
      // Host missing, permission denied, or older shell — never surface.
    }
  })();
}
