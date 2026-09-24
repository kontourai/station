import { isProviderTriggeredTurn } from '@kontourai/station-contracts/runtime-events';
import type { SessionTapePlayer } from './player';

export interface ConversationTimelineLandmark {
  turnId: string;
  label: string;
  startFrame: number;
  endFrame: number;
  forkable: boolean;
}

function turnLabel(prompt: string | undefined, index: number): string {
  const compact = prompt?.replace(/\s+/g, ' ').trim();
  if (!compact) return `Turn ${index + 1}`;
  return compact.length > 72 ? `${compact.slice(0, 69)}…` : compact;
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
