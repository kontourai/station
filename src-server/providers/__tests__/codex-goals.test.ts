import { afterEach, describe, expect, test, vi } from 'vitest';
import { CodexAdapter } from '../adapters/codex-adapter.js';
import { CodexGoals } from '../adapters/codex-goals.js';
import {
  emit,
  startedAdapter,
  THREAD,
  waitFor,
} from './codex-adapter-wire-harness.js';

const nativeGoal = {
  threadId: 'codex-thread',
  objective: 'Complete the migration',
  status: 'paused',
  tokenBudget: 40000,
  tokensUsed: 120,
  timeUsedSeconds: 7,
  createdAt: 1,
  updatedAt: 2,
};

async function request(
  process: Awaited<ReturnType<typeof startedAdapter>>['process'],
  method: string,
) {
  return waitFor(
    () =>
      process.stdin.lines
        .map((line) => JSON.parse(line))
        .find((line) => line.method === method),
    method,
  );
}

describe('Codex Goal controls through the owned app-server pipe', () => {
  afterEach(() => vi.useRealTimers());

  test('an inactive read never starts or resumes an engine', async () => {
    const spawn = vi.fn();
    const adapter = new CodexAdapter({ processFactory: spawn });
    expect(await adapter.goals.read('missing')).toEqual({
      state: 'unavailable',
      reason: 'session-not-live',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  test('reads the exact native thread and preserves provider accounting', async () => {
    const { adapter, process } = await startedAdapter();
    try {
      const result = adapter.goals.read(THREAD);
      const rpc = await request(process, 'thread/goal/get');
      expect(rpc.params).toEqual({ threadId: 'codex-thread' });
      await emit(process, { id: rpc.id, result: { goal: nativeGoal } });
      expect(await result).toMatchObject({
        state: 'available',
        capability: { implementation: 'engine', saveState: 'paused' },
        goal: {
          objective: nativeGoal.objective,
          tokenBudget: 40000,
          tokensUsed: 120,
          timeUsedSeconds: 7,
        },
      });
    } finally {
      await adapter.stopAll();
    }
  });

  test('does not advertise a method an older engine refuses', async () => {
    const { adapter, process } = await startedAdapter();
    try {
      const result = adapter.goals.read(THREAD);
      const rpc = await request(process, 'thread/goal/get');
      await emit(process, {
        id: rpc.id,
        error: { code: -32601, message: 'Method not found' },
      });
      expect(await result).toEqual({ state: 'unsupported' });
    } finally {
      await adapter.stopAll();
    }
  });

  test('refuses a response naming another native thread', async () => {
    const { adapter, process } = await startedAdapter();
    try {
      const result = adapter.goals.read(THREAD);
      const rpc = await request(process, 'thread/goal/get');
      await emit(process, {
        id: rpc.id,
        result: { goal: { ...nativeGoal, threadId: 'other' } },
      });
      expect(await result).toEqual({
        state: 'unavailable',
        reason: 'provider-unavailable',
      });
    } finally {
      await adapter.stopAll();
    }
  });

  test('saves a paused goal without manufacturing a turn and preserves pause accounting', async () => {
    const { adapter, process } = await startedAdapter();
    try {
      const starts = process.stdin.lines.filter(
        (line) => JSON.parse(line).method === 'turn/start',
      ).length;
      const result = adapter.goals.control(THREAD, {
        operation: 'set',
        objective: nativeGoal.objective,
        tokenBudget: 40000,
      });
      const rpc = await request(process, 'thread/goal/set');
      expect(rpc.params).toEqual({
        threadId: 'codex-thread',
        origin: 'user',
        objective: nativeGoal.objective,
        tokenBudget: 40000,
        status: 'paused',
      });
      await emit(process, { id: rpc.id, result: { goal: nativeGoal } });
      expect(await result).toMatchObject({
        state: 'applied',
        goal: { tokensUsed: 120 },
      });
      const pause = adapter.goals.control(THREAD, { operation: 'pause' });
      const second = process.stdin.lines
        .map((line) => JSON.parse(line))
        .filter((line) => line.method === 'thread/goal/set')
        .at(-1);
      expect(second.params).toEqual({
        threadId: 'codex-thread',
        origin: 'user',
        status: 'paused',
      });
      await emit(process, { id: second.id, result: { goal: nativeGoal } });
      expect(await pause).toMatchObject({
        state: 'applied',
        goal: { tokensUsed: 120 },
      });
      expect(
        process.stdin.lines.filter(
          (line) => JSON.parse(line).method === 'turn/start',
        ),
      ).toHaveLength(starts);
      const before = process.stdin.lines.length;
      expect(
        await adapter.goals.control(THREAD, { operation: 'resume' }),
      ).toEqual({ state: 'unsupported' });
      expect(process.stdin.lines).toHaveLength(before);
    } finally {
      await adapter.stopAll();
    }
  });

  test('uses the native clear response instead of requiring a goal payload', async () => {
    const { adapter, process } = await startedAdapter();
    try {
      const result = adapter.goals.control(THREAD, { operation: 'clear' });
      const rpc = await request(process, 'thread/goal/clear');
      await emit(process, { id: rpc.id, result: { cleared: true } });
      expect(await result).toEqual({ state: 'applied', goal: null });
    } finally {
      await adapter.stopAll();
    }
  });

  test('a lost acknowledgement stays indeterminate and blocks another mutation until settlement', async () => {
    const { adapter, process } = await startedAdapter();
    try {
      const goals = new CodexGoals({
        getSession: () => undefined,
        sendRequest: vi.fn(),
      });
      expect(await goals.control(THREAD, { operation: 'pause' })).toEqual({
        state: 'refused',
        reason: 'session-not-live',
      });
      vi.useFakeTimers();
      const result = adapter.goals.control(THREAD, { operation: 'pause' });
      const rpc = process.stdin.lines
        .map((line) => JSON.parse(line))
        .find((line) => line.method === 'thread/goal/set');
      await vi.advanceTimersByTimeAsync(10000);
      expect(await result).toEqual({ state: 'indeterminate' });
      const before = process.stdin.lines.length;
      expect(
        await adapter.goals.control(THREAD, { operation: 'pause' }),
      ).toEqual({ state: 'refused', reason: 'busy' });
      expect(process.stdin.lines).toHaveLength(before);
      vi.useRealTimers();
      await emit(process, { id: rpc.id, result: { goal: nativeGoal } });
      const next = adapter.goals.control(THREAD, { operation: 'clear' });
      const clear = await request(process, 'thread/goal/clear');
      await emit(process, { id: clear.id, result: { cleared: true } });
      expect(await next).toEqual({ state: 'applied', goal: null });
    } finally {
      vi.useRealTimers();
      await adapter.stopAll();
    }
  });
});
