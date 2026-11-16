import { ATTACHED_SOURCE_ACTIVE_WINDOW_MS } from '@kontourai/station-contracts/orchestration';
import type { ProviderSession } from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test } from 'vitest';
import {
  ATTACHED_SOURCE_CLOCK_SKEW_MS,
  deriveAttachedSourceActivity,
} from '../attached-source-activity.js';
import { buildOrchestrationSessionSummary } from '../orchestration-session-state.js';

const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const at = (msBeforeNow: number) => new Date(NOW - msBeforeNow).toISOString();
let n = 0;
const ev = (
  method: string,
  createdAt: string,
  extra: Record<string, unknown> = {},
): CanonicalRuntimeEvent =>
  ({
    eventId: `e${n++}`,
    provider: 'claude',
    threadId: 'external:claude:t',
    createdAt,
    method,
    ...extra,
  }) as unknown as CanonicalRuntimeEvent;

const started = (createdAt: string, turnId = 'turn-1') =>
  ev('turn.started', createdAt, { turnId, prompt: 'go' });
const completed = (createdAt: string, turnId = 'turn-1') =>
  ev('turn.completed', createdAt, { turnId, finishReason: 'stop' });

describe('deriveAttachedSourceActivity', () => {
  // Pinned literal beside the constant the boundaries below derive from.
  test('the active window is five minutes', () => {
    expect(ATTACHED_SOURCE_ACTIVE_WINDOW_MS).toBe(300_000);
  });

  test('an open turn written within the window is active', () => {
    expect(
      deriveAttachedSourceActivity(
        [
          started(at(90_000)),
          ev('content.text-delta', at(10_000), { turnId: 'turn-1' }),
        ],
        NOW,
      ),
    ).toEqual({ state: 'active', lastWriteAt: at(10_000) });
  });

  test('the window edge is still active and one millisecond past it is quiet', () => {
    const edge = [started(at(ATTACHED_SOURCE_ACTIVE_WINDOW_MS))];
    expect(deriveAttachedSourceActivity(edge, NOW).state).toBe('active');
    const past = [started(at(ATTACHED_SOURCE_ACTIVE_WINDOW_MS + 1))];
    expect(deriveAttachedSourceActivity(past, NOW).state).toBe('quiet');
  });

  test('a turn that completed is idle however recently it was written', () => {
    expect(
      deriveAttachedSourceActivity(
        [started(at(20_000)), completed(at(1_000))],
        NOW,
      ),
    ).toEqual({ state: 'idle', lastWriteAt: at(1_000) });
  });

  test('an aborted turn is idle', () => {
    expect(
      deriveAttachedSourceActivity(
        [
          started(at(20_000)),
          ev('turn.aborted', at(1_000), { turnId: 'turn-1', reason: 'x' }),
        ],
        NOW,
      ).state,
    ).toBe('idle');
  });

  test('a later turn opened after a completed one is active again', () => {
    expect(
      deriveAttachedSourceActivity(
        [
          started(at(60_000)),
          completed(at(50_000)),
          started(at(5_000), 'turn-2'),
        ],
        NOW,
      ).state,
    ).toBe('active');
  });

  // Review item 1: a source can be written without producing an event (an
  // OpenCode step still streaming, a Claude subagent's own transcript).
  test("the source's own newer write keeps an open turn active", () => {
    expect(
      deriveAttachedSourceActivity([started(at(20 * 60_000))], NOW, at(30_000)),
    ).toEqual({ state: 'active', lastWriteAt: at(30_000) });
  });

  test("an older source write does not hide a newer event's time", () => {
    expect(
      deriveAttachedSourceActivity([started(at(10_000))], NOW, at(20 * 60_000)),
    ).toEqual({ state: 'active', lastWriteAt: at(10_000) });
  });

  test("the source's write time does not open a turn that ended", () => {
    expect(
      deriveAttachedSourceActivity(
        [started(at(60_000)), completed(at(50_000))],
        NOW,
        at(1_000),
      ).state,
    ).toBe('idle');
  });

  // Review item 5: a record dated an hour ahead used to read active until
  // five minutes past its own time. A write later than the read (beyond the
  // skew allowance) is not evidence of recent activity.
  test('a write dated past the skew allowance is not counted', () => {
    const future = new Date(NOW + 60 * 60_000).toISOString();
    expect(deriveAttachedSourceActivity([started(future)], NOW)).toEqual({
      state: 'quiet',
    });
    expect(
      deriveAttachedSourceActivity([started(at(20 * 60_000))], NOW, future),
    ).toEqual({ state: 'quiet', lastWriteAt: at(20 * 60_000) });
  });

  test('a write within the skew allowance counts as now', () => {
    const skewed = new Date(NOW + ATTACHED_SOURCE_CLOCK_SKEW_MS).toISOString();
    expect(deriveAttachedSourceActivity([started(skewed)], NOW)).toEqual({
      state: 'active',
      lastWriteAt: skewed,
    });
    const past = new Date(
      NOW + ATTACHED_SOURCE_CLOCK_SKEW_MS + 1,
    ).toISOString();
    expect(deriveAttachedSourceActivity([started(past)], NOW).state).toBe(
      'quiet',
    );
  });

  test('the clock-skew allowance is one minute', () => {
    expect(ATTACHED_SOURCE_CLOCK_SKEW_MS).toBe(60_000);
  });

  test('no events is idle with no write time', () => {
    expect(deriveAttachedSourceActivity([], NOW)).toEqual({ state: 'idle' });
  });
});

describe('attachedSourceActivity on the session summary', () => {
  const summarize = (controlMode: ProviderSession['controlMode']) =>
    buildOrchestrationSessionSummary({
      persisted: {
        provider: 'claude',
        threadId: 'external:claude:t',
        status: 'ready',
        controlMode,
        createdAt: at(120_000),
        updatedAt: at(120_000),
      } as ProviderSession,
      answerability: {
        threadAttachment: 'detached',
        providerRegistered: true,
        observedBy: 'test',
        observedAt: at(0),
      },
      events: [started(at(30_000))],
      now: NOW,
    });

  test('a read-only attached session carries it', () => {
    expect(
      summarize('read-only-attached').attachedSourceActivity,
    ).toMatchObject({ state: 'active' });
  });

  test('a session Station owns does not', () => {
    expect(summarize('station-owned')).not.toHaveProperty(
      'attachedSourceActivity',
    );
  });
});
