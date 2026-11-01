// @vitest-environment node
/**
 * Lifecycle journals of an instance run under the process supervisor (#4135):
 * the record names the supervisor, each generation's events name it too, and
 * only the newest generation's exit is the instance's.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyLifecycleExit,
  type LifecycleEvent,
  parseLifecycleEvent,
} from '../lifecycle-events.js';

const SUPERVISOR = 4100;
const instance = {
  instanceId: 'dogfood',
  sha: 'a'.repeat(40),
  bootId: '11111111-2222-3333-4444-555555555555',
  pid: SUPERVISOR,
};
let clock = Date.parse('2026-10-31T10:00:00Z');
const at = () => {
  clock += 1_000;
  return new Date(clock).toISOString();
};

function cli(event: Partial<LifecycleEvent>): LifecycleEvent {
  return parseLifecycleEvent({
    ...instance,
    version: 1,
    timestamp: at(),
    ...event,
  });
}

function generation(
  generationNumber: number,
  pid: number,
  event: Partial<LifecycleEvent>,
  sha = instance.sha,
): LifecycleEvent {
  return parseLifecycleEvent({
    ...instance,
    sha,
    pid,
    supervisor: { pid: SUPERVISOR, generation: generationNumber },
    version: 1,
    timestamp: at(),
    sender: 'unknown',
    ...event,
  });
}

const handoff = [
  cli({ type: 'started' }),
  generation(1, 5001, {
    type: 'shutdown_observed',
    reason: 'supervisor_drain',
  }),
  generation(1, 5001, { type: 'process_exit', exitCode: 0, signal: null }),
];

describe('supervised lifecycle journals', () => {
  it('reads a generation that drained for a handoff as no exit of the instance', () => {
    // Generation 2 (another build) serves on, then loses its supervisor.
    const events = [
      ...handoff,
      generation(
        2,
        5002,
        { type: 'shutdown_observed', reason: 'supervisor_disconnect' },
        'b'.repeat(40),
      ),
      generation(
        2,
        5002,
        { type: 'process_exit', exitCode: 1, signal: null },
        'b'.repeat(40),
      ),
    ];
    expect(classifyLifecycleExit(events, instance).classification).toBe(
      'supervisor_disconnect',
    );
  });

  it('never reads an earlier generation’s clean drain as the instance’s exit', () => {
    // Generation 2 recorded its start and nothing else before everything
    // died: the handoff's drain must not make that look like a clean stop.
    const silent = [...handoff, generation(2, 5002, { type: 'started' })];
    expect(classifyLifecycleExit(silent, instance).classification).toBe(
      'crash_unobserved',
    );
    const crashed = [
      ...handoff,
      generation(2, 5002, { type: 'process_exit', exitCode: 1, signal: null }),
    ];
    expect(classifyLifecycleExit(crashed, instance).classification).toBe(
      'crash',
    );
  });

  it('matches an operator stop recorded against the supervisor pid', () => {
    const intentAt = at();
    const events = [
      ...handoff,
      cli({
        type: 'stop_intent',
        intent: 'operator_stop',
        operationId: 'op-1',
        timestamp: intentAt,
        expiresAt: new Date(Date.parse(intentAt) + 60_000).toISOString(),
      }),
      generation(2, 5002, {
        type: 'shutdown_observed',
        reason: 'supervisor_drain',
      }),
      generation(2, 5002, { type: 'process_exit', exitCode: 0, signal: null }),
      cli({ type: 'stop_result', operationId: 'op-1', result: 'completed' }),
    ];
    expect(classifyLifecycleExit(events, instance).classification).toBe(
      'operator_stop',
    );
  });

  it('keeps reading a direct start’s journal, which has no supervisor', () => {
    const direct = { ...instance, pid: 6000 };
    const events = [
      parseLifecycleEvent({
        ...direct,
        version: 1,
        timestamp: at(),
        type: 'process_exit',
        exitCode: 1,
        signal: null,
      }),
    ];
    expect(classifyLifecycleExit(events, direct).classification).toBe('crash');
    // A generation's event never matches by its own pid.
    expect(
      classifyLifecycleExit(
        [generation(1, 6000, { type: 'process_exit', exitCode: 1 })],
        direct,
      ).classification,
    ).toBe('crash_unobserved');
  });

  it('refuses a malformed supervisor identity', () => {
    expect(() =>
      parseLifecycleEvent({
        ...instance,
        version: 1,
        timestamp: at(),
        type: 'started',
        supervisor: { pid: 'x', generation: 1 },
      }),
    ).toThrow('invalid lifecycle supervisor identity');
  });
});
