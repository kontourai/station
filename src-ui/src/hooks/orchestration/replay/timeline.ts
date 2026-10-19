import { isProviderTriggeredTurn } from '@kontourai/station-contracts/runtime-events';
import type { SessionTapePlayer } from './player';

export interface ConversationTimelineLandmark {
  turnId: string;
  label: string;
  startFrame: number;
  endFrame: number;
  forkable: boolean;
}

/**
 * One line of a turn's text, whitespace collapsed and cut to `max`
 * characters. Shared by History replay's landmarks and the live
 * transcript's turn rail, so both name a turn the same way.
 */
export function compactTurnText(
  text: string | undefined,
  max = 72,
): string | undefined {
  if (!text) return undefined;
  // One scan that stops as soon as the result is known to need cutting, so a
  // long paste costs work bounded by `max` (plus any one whitespace run), not
  // by its length. Same output as collapsing every whitespace run to one
  // space, trimming, then cutting.
  let compact = '';
  let pendingSpace = false;
  for (let index = 0; index < text.length && compact.length <= max; ) {
    const point = text.codePointAt(index)!;
    const character = String.fromCodePoint(point);
    index += character.length;
    if (/\s/.test(character)) {
      pendingSpace = compact.length > 0;
      continue;
    }
    if (pendingSpace) compact += ' ';
    pendingSpace = false;
    compact += character;
  }
  if (!compact) return undefined;
  return compact.length > max ? `${compact.slice(0, max - 3)}…` : compact;
}

function turnLabel(prompt: string | undefined, index: number): string {
  return compactTurnText(prompt) ?? `Turn ${index + 1}`;
}

/** Full user-turn index over the already bounded, validated replay tape. */
const landmarkCache = new WeakMap<
  readonly unknown[],
  readonly ConversationTimelineLandmark[]
>();

export function conversationTimelineLandmarks(
  player: Pick<SessionTapePlayer, 'frames'>,
): readonly ConversationTimelineLandmark[] {
  const cached = landmarkCache.get(player.frames);
  if (cached) return cached;
  // #2324: a turn the engine opened on its own is not a user turn; its
  // frames stay inside the landmark of the exchange it followed.
  const starts = player.frames.flatMap((frame, frameIndex) =>
    frame.kind === 'runtime' &&
    frame.event.method === 'turn.started' &&
    frame.event.inputKind !== 'steer' &&
    !isProviderTriggeredTurn(frame.event)
      ? [{ frameIndex, event: frame.event }]
      : [],
  );
  const completedTurnIds = new Set(
    player.frames.flatMap((frame) =>
      frame.kind === 'runtime' && frame.event.method === 'turn.completed'
        ? [frame.event.turnId]
        : [],
    ),
  );
  const landmarks = starts.map(({ frameIndex, event }, index) => {
    const endFrame =
      (starts[index + 1]?.frameIndex ?? player.frames.length) - 1;
    return {
      turnId: event.turnId,
      label: turnLabel(event.prompt, index),
      startFrame: frameIndex,
      endFrame,
      forkable: completedTurnIds.has(event.turnId),
    };
  });
  landmarkCache.set(player.frames, landmarks);
  return landmarks;
}

export function activeTimelineLandmarkIndex(
  landmarks: readonly ConversationTimelineLandmark[],
  cursor: number,
): number {
  for (let index = landmarks.length - 1; index >= 0; index -= 1) {
    if (cursor >= landmarks[index]!.startFrame) return index;
  }
  return -1;
}
