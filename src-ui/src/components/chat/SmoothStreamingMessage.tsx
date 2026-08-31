import { useCallback, useEffect, useRef, useState } from 'react';
import { useStreamingContent } from '../../hooks/useStreamingContent';
import {
  type StreamingMessageProps,
  StreamingMessageView,
} from './StreamingMessage';

/**
 * station#585 smooth-reveal design inputs. Keep the tuning in one place so
 * dogfooding can change a coherent policy rather than hunting magic numbers.
 */
export const SMOOTH_REVEAL_CONSTANTS = {
  backlogWindowSeconds: 0.4,
  slewTauSeconds: 0.15,
  minCharsPerSecond: 50,
  maxCharsPerSecond: 600,
  maxDrainMilliseconds: 2_500,
} as const;

export interface SmoothRevealFrameSource {
  now(): number;
  request(callback: (now: number) => void): unknown;
  cancel(handle: unknown): void;
}

export interface SmoothRevealSnapshot {
  visibleLength: number;
  rateCharsPerSecond: number;
  needsFrame: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Pure cursor policy; the React adapter below only schedules and publishes it. */
export class SmoothRevealCursor {
  private availableLength = 0;
  private cursor = 0;
  private rate = SMOOTH_REVEAL_CONSTANTS.minCharsPerSecond;
  private lastFrameAt: number | null = null;
  private drainStartedAt: number | null = null;

  updateAvailable(length: number, now: number): SmoothRevealSnapshot {
    const nextLength = Math.max(0, length);
    if (nextLength < this.cursor) {
      this.cursor = nextLength;
      this.rate = SMOOTH_REVEAL_CONSTANTS.minCharsPerSecond;
      this.drainStartedAt = null;
    }
    this.availableLength = nextLength;
    if (this.cursor < this.availableLength && this.drainStartedAt === null) {
      this.drainStartedAt = now;
      this.lastFrameAt = now;
    }
    if (this.cursor >= this.availableLength) this.drainStartedAt = null;
    return this.snapshot();
  }

  advance(now: number): SmoothRevealSnapshot {
    if (this.cursor >= this.availableLength) {
      this.lastFrameAt = now;
      this.drainStartedAt = null;
      return this.snapshot();
    }

    const startedAt = this.drainStartedAt ?? now;
    if (now - startedAt >= SMOOTH_REVEAL_CONSTANTS.maxDrainMilliseconds) {
      this.cursor = this.availableLength;
    } else {
      const previousAt = this.lastFrameAt ?? now;
      const elapsedSeconds = Math.max(0, now - previousAt) / 1_000;
      const backlog = this.availableLength - this.cursor;
      const targetRate = clamp(
        backlog / SMOOTH_REVEAL_CONSTANTS.backlogWindowSeconds,
        SMOOTH_REVEAL_CONSTANTS.minCharsPerSecond,
        SMOOTH_REVEAL_CONSTANTS.maxCharsPerSecond,
      );
      const slew =
        1 - Math.exp(-elapsedSeconds / SMOOTH_REVEAL_CONSTANTS.slewTauSeconds);
      this.rate += (targetRate - this.rate) * slew;
      this.cursor = Math.min(
        this.availableLength,
        this.cursor + this.rate * elapsedSeconds,
      );
    }

    this.lastFrameAt = now;
    if (this.cursor >= this.availableLength) this.drainStartedAt = null;
    return this.snapshot();
  }

  private snapshot(): SmoothRevealSnapshot {
    return {
      visibleLength: Math.floor(this.cursor),
      rateCharsPerSecond: this.rate,
      needsFrame: this.cursor < this.availableLength,
    };
  }
}

const browserFrames: SmoothRevealFrameSource = {
  now: () => performance.now(),
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle as number),
};

export function useSmoothRevealText(
  text: string,
  frames: SmoothRevealFrameSource = browserFrames,
): { text: string; revision: number } {
  const cursorRef = useRef<SmoothRevealCursor | null>(null);
  if (!cursorRef.current) cursorRef.current = new SmoothRevealCursor();
  const frameHandleRef = useRef<unknown>(null);
  const textRef = useRef(text);
  textRef.current = text;
  const [visible, setVisible] = useState({ length: 0, revision: 0 });

  const runFrame = useCallback(
    (now: number) => {
      frameHandleRef.current = null;
      const snapshot = cursorRef.current!.advance(now);
      setVisible((current) =>
        current.length === snapshot.visibleLength
          ? current
          : {
              length: snapshot.visibleLength,
              revision: current.revision + 1,
            },
      );
      if (snapshot.needsFrame) {
        frameHandleRef.current = frames.request(runFrame);
      }
    },
    [frames],
  );

  useEffect(() => {
    const snapshot = cursorRef.current!.updateAvailable(
      text.length,
      frames.now(),
    );
    setVisible((current) =>
      current.length <= text.length
        ? current
        : { length: snapshot.visibleLength, revision: current.revision + 1 },
    );
    if (snapshot.needsFrame && frameHandleRef.current === null) {
      frameHandleRef.current = frames.request(runFrame);
    }
  }, [frames, runFrame, text.length]);

  useEffect(
    () => () => {
      if (frameHandleRef.current !== null) {
        frames.cancel(frameHandleRef.current);
        frameHandleRef.current = null;
      }
    },
    [frames],
  );

  return {
    text: textRef.current.slice(0, visible.length),
    revision: visible.revision,
  };
}

export function SmoothStreamingMessage(props: StreamingMessageProps) {
  const state = useStreamingContent(props.sessionId);
  const revealed = useSmoothRevealText(state.streamingText);
  return (
    <StreamingMessageView
      {...props}
      {...state}
      streamingText={revealed.text}
      contentRevision={state.contentRevision + revealed.revision}
    />
  );
}
