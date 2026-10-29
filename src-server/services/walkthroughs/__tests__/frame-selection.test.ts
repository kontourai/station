import { describe, expect, test } from 'vitest';
import { selectWalkthroughFrames } from '../frame-selection.js';

const token = (text: string, tMs: number, endMs = tMs + 100) => ({
  text,
  tMs,
  endMs,
});
describe('frame selection', () => {
  test('reconstructs subwords and matches whole words with original timing', () => {
    const selection = selectWalkthroughFrames({
      durationMs: 14000,
      tokens: [
        token('This', 1760),
        token(' other ', 2000),
        token(' L', 9520),
        token('ook', 9680),
        token(' here', 10240),
        token(' That', 12720),
        token('cher', 12800),
      ],
      speech: [],
      sceneTimes: [],
    });
    expect(
      selection.frames
        .filter((f) => f.reasons.includes('deictic'))
        .map((f) => f.tMs),
    ).toEqual([1760, 9520, 10240]);
  });
  test('merges nearby signals at the deictic time and preserves every reason', () => {
    const result = selectWalkthroughFrames({
      durationMs: 5000,
      tokens: [token(' look', 400, 1200)],
      speech: [],
      sceneTimes: [100],
    });
    expect(result.frames[0]).toEqual({
      tMs: 400,
      reasons: ['interval', 'scene-change', 'deictic'],
    });
    expect(result.frames.find((f) => f.reasons.includes('pause'))?.tMs).toBe(
      1400,
    );
    expect(result.frameSelection).toEqual({ candidates: 4, kept: 2 });
  });
  test('finds a token-level pause inside a segment and silent interval candidates', () => {
    const result = selectWalkthroughFrames({
      durationMs: 30000,
      tokens: [token('one', 6000, 6080), token(' two', 7920)],
      speech: [{ tMs: 0, endMs: 9000 }],
      sceneTimes: [15000],
    });
    expect(result.frames).toContainEqual({ tMs: 6280, reasons: ['pause'] });
    expect(
      result.frames
        .filter((f) => f.reasons.includes('interval'))
        .map((f) => f.tMs),
    ).toEqual([0, 10000, 20000]);
  });
  test('ranks deictic and scene candidates above the interval floor, caps and orders', () => {
    const result = selectWalkthroughFrames({
      durationMs: 1800000,
      tokens: [token(' here', 1799000)],
      speech: [],
      sceneTimes: [1797000],
    });
    expect(result.frames).toHaveLength(120);
    expect(result.frameSelection.candidates).toBeGreaterThan(120);
    expect(result.frames.slice(-2).map((f) => f.tMs)).toEqual([
      1797000, 1799000,
    ]);
    expect(
      result.frames.every(
        (f, i) => i === 0 || f.tMs >= result.frames[i - 1]!.tMs,
      ),
    ).toBe(true);
  });
});

test('reserves full-duration coverage when early scene changes exhaust the frame budget', () => {
  const durationMs = 1_800_000;
  const { frames } = selectWalkthroughFrames({
    durationMs,
    tokens: [],
    speech: [],
    sceneTimes: Array.from({ length: 144 }, (_, i) => i * 5000),
  });
  const times = [0, ...frames.map((f) => f.tMs), durationMs];
  expect(frames).toHaveLength(120);
  expect(
    Math.max(...times.slice(1).map((t, i) => t - times[i]!)),
  ).toBeLessThanOrEqual(31_000);
});
