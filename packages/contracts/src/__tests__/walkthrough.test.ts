import { describe, expect, test } from 'vitest';
import {
  parseWalkthrough,
  WALKTHROUGH_CHANNELS,
  WALKTHROUGH_LIMITS,
  type Walkthrough,
} from '../walkthrough.js';

function manifest(): Walkthrough {
  return {
    schema: 'station.walkthrough/v1',
    id: 'w1',
    createdAt: '2026-10-24T00:00:00.000Z',
    source: {
      adapter: 'video-import',
      adapterVersion: '1',
      originalName: 'review.mp4',
      durationMs: 10000,
    },
    capture: { platform: 'unknown' },
    coverage: {
      transcript: 'present',
      frames: 'present',
      marks: 'present',
      elements: 'present',
      route: 'present',
      console: 'present',
      network: 'present',
    },
    events: [
      {
        kind: 'transcript',
        tMs: 100,
        endMs: 200,
        text: 'This',
        tokens: [{ tMs: 100, endMs: 200, text: 'This' }],
      },
      {
        kind: 'frame',
        tMs: 100,
        frameId: 'f1',
        file: 'f1.jpg',
        width: 100,
        height: 100,
        reasons: ['deictic'],
      },
      {
        kind: 'mark',
        tMs: 100,
        shape: 'tap',
        points: [[0.5, 0.5]],
        frameId: 'f1',
        element: { testId: 'button' },
      },
      { kind: 'route', tMs: 200, path: '/p' },
      { kind: 'console', tMs: 200, level: 'error', message: 'Error' },
      {
        kind: 'network',
        tMs: 200,
        method: 'GET',
        url: 'https://example.test',
        status: 200,
      },
    ],
  };
}
describe('Walkthrough boundary', () => {
  test('round trips all specified event kinds and an empty observed transcript', () => {
    const value = manifest();
    expect(parseWalkthrough(value)).toEqual(value);
    value.events = [];
    expect(parseWalkthrough(value).coverage.transcript).toBe('present');
  });
  test.each(WALKTHROUGH_CHANNELS)('refuses absent channel %s', (channel) => {
    const value = manifest();
    value.coverage[channel] = 'absent';
    expect(() => parseWalkthrough(value)).toThrow(`Absent channel: ${channel}`);
  });
  test.each([
    '/tmp/f.jpg',
    '../f.jpg',
    'a/../f.jpg',
    'a/f.jpg',
    'a\\f.jpg',
    'C:\\f.jpg',
    '..',
    '.',
    'f\0.jpg',
  ])('refuses path traversal in frame file %s', (file) => {
    const value = manifest();
    const frame = value.events[1];
    if (frame.kind !== 'frame') throw new Error('fixture');
    frame.file = file;
    expect(() => parseWalkthrough(value)).toThrow('plain file name');
  });
  test.each([
    '/tmp/review.mp4',
    '../review.mp4',
    'a\\review.mp4',
    'C:review.mp4',
  ])('refuses originalName path %s', (name) => {
    const value = manifest();
    value.source.originalName = name;
    expect(() => parseWalkthrough(value)).toThrow('plain file name');
  });
  test('refuses out of order events and dangling mark frame references', () => {
    const v = manifest();
    v.events.reverse();
    expect(() => parseWalkthrough(v)).toThrow('ordered');
    const w = manifest();
    const mark = w.events[2];
    if (mark.kind !== 'mark') throw new Error('fixture');
    mark.frameId = 'missing';
    expect(() => parseWalkthrough(w)).toThrow('Unknown mark frameId');
  });
  test.each([
    [
      'duration',
      (v: Walkthrough) => {
        v.source.durationMs = WALKTHROUGH_LIMITS.durationMs + 1;
      },
    ],
    [
      'events',
      (v: Walkthrough) => {
        v.events = Array.from(
          { length: WALKTHROUGH_LIMITS.events + 1 },
          () => ({ kind: 'route', tMs: 0, path: '/' }),
        );
      },
    ],
    [
      'frames',
      (v: Walkthrough) => {
        v.events = Array.from(
          { length: WALKTHROUGH_LIMITS.frames + 1 },
          (_, i) => ({
            kind: 'frame',
            tMs: 0,
            frameId: `f${i}`,
            file: `f${i}.jpg`,
            width: 1,
            height: 1,
            reasons: ['interval'],
          }),
        );
      },
    ],
    [
      'text',
      (v: Walkthrough) => {
        v.events = [
          {
            kind: 'transcript',
            tMs: 0,
            endMs: 1,
            text: 'a'.repeat(WALKTHROUGH_LIMITS.text + 1),
          },
        ];
      },
    ],
    [
      'total text',
      (v: Walkthrough) => {
        v.events = Array.from({ length: 17 }, () => ({
          kind: 'route',
          tMs: 0,
          path: 'a'.repeat(WALKTHROUGH_LIMITS.text),
        }));
      },
    ],
    [
      'token count',
      (v: Walkthrough) => {
        v.events = Array.from({ length: 2 }, () => ({
          kind: 'transcript',
          tMs: 0,
          endMs: 1,
          text: 'a',
          tokens: Array.from({ length: 20000 }, () => ({
            tMs: 0,
            endMs: 1,
            text: 'a',
          })),
        }));
      },
    ],
    [
      'token text',
      (v: Walkthrough) => {
        v.events = [
          {
            kind: 'transcript',
            tMs: 0,
            endMs: 1,
            text: 'a',
            tokens: [
              {
                tMs: 0,
                endMs: 1,
                text: 'a'.repeat(WALKTHROUGH_LIMITS.tokenText + 1),
              },
            ],
          },
        ];
      },
    ],
    [
      'token timing',
      (v: Walkthrough) => {
        v.events = [
          {
            kind: 'transcript',
            tMs: 0,
            endMs: 1,
            text: 'a',
            tokens: [{ tMs: 2, endMs: 3, text: 'a' }],
          },
        ];
      },
    ],
  ])('rejects %s bounds without truncation', (_name, mutate) => {
    const v = manifest();
    mutate(v);
    const before = JSON.stringify(v);
    expect(() => parseWalkthrough(v)).toThrow();
    expect(JSON.stringify(v)).toBe(before);
  });
  test('accepts exact limits and refuses false selection accounting', () => {
    const v = manifest();
    v.source.durationMs = WALKTHROUGH_LIMITS.durationMs;
    v.events = [
      {
        kind: 'transcript',
        tMs: 0,
        endMs: v.source.durationMs,
        text: 'a'.repeat(WALKTHROUGH_LIMITS.text),
      },
    ];
    expect(parseWalkthrough(v).events).toHaveLength(1);
    v.frameSelection = { candidates: 1, kept: 1 };
    expect(() => parseWalkthrough(v)).toThrow('frameSelection');
  });
  test('rejects duplicate files, malformed normalized points, and unknown fields', () => {
    const v = manifest();
    v.events.splice(2, 0, { ...v.events[1] });
    expect(() => parseWalkthrough(v)).toThrow('Duplicate frame');
    const w = manifest();
    const mark = w.events[2];
    if (mark.kind !== 'mark') throw new Error('fixture');
    mark.points = [[1.1, 0]];
    expect(() => parseWalkthrough(w)).toThrow('bounds');
    expect(() =>
      parseWalkthrough({ ...manifest(), secret: 'ignored' }),
    ).toThrow('Unknown field');
  });
});
