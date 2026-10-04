import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test } from 'vitest';
import {
  evaluateSessionWait,
  SESSION_WAIT_MAX_PER_CALLER,
  SESSION_WAIT_MAX_TIMEOUT_MS,
  SESSION_WAIT_MAX_TOTAL,
  SessionTurnWaiter,
  type SessionTurnWaitPorts,
  type SessionWaitFoldEvent,
} from '../session-turn-wait.js';

const event = (
  method: string,
  turnId: string,
  sequence: number,
): SessionWaitFoldEvent => ({
  sequence,
  event: { method, turnId, threadId: 't1' } as unknown as CanonicalRuntimeEvent,
});

/** A Session whose log the test appends to, waking subscribers like the bus does. */
function fakeSession() {
  const log: SessionWaitFoldEvent[] = [];
  const listeners = new Set<() => void>();
  const state = { coordinatorBusy: false };
  const ports: SessionTurnWaitPorts = {
    foldEvents: () => [...log],
    headSequence: () => log.at(-1)?.sequence ?? 0,
    coordinatorBusy: () => state.coordinatorBusy,
    subscribe: (_thread, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    ports,
    state,
    listeners,
    append(method: string, turnId: string) {
      log.push(event(method, turnId, (log.at(-1)?.sequence ?? 0) + 1));
      for (const listener of [...listeners]) listener();
    },
  };
}

describe('evaluateSessionWait', () => {
  test('idle is satisfied exactly when no turn is open and the coordinator holds none', () => {
    const session = fakeSession();
    expect(evaluateSessionWait(session.ports, 't1', 'idle', 0).satisfied).toBe(
      true,
    );
    session.append('turn.started', 'a');
    expect(evaluateSessionWait(session.ports, 't1', 'idle', 0)).toMatchObject({
      satisfied: false,
      view: { state: 'running', openTurnId: 'a' },
    });
    session.append('turn.completed', 'a');
    expect(evaluateSessionWait(session.ports, 't1', 'idle', 0).satisfied).toBe(
      true,
    );
    // A turn the adapter accepted before its turn.started was logged.
    session.state.coordinatorBusy = true;
    expect(evaluateSessionWait(session.ports, 't1', 'idle', 0).satisfied).toBe(
      false,
    );
  });

  test('turn-settled sees a turn that finished after the cursor, with its outcome', () => {
    const session = fakeSession();
    session.append('turn.started', 'old');
    session.append('turn.completed', 'old');
    const cursor = 2;
    session.append('turn.started', 'new');
    expect(
      evaluateSessionWait(session.ports, 't1', 'turn-settled', cursor)
        .satisfied,
    ).toBe(false);
    session.append('turn.aborted', 'new');
    expect(
      evaluateSessionWait(session.ports, 't1', 'turn-settled', cursor),
    ).toMatchObject({
      satisfied: true,
      view: {
        state: 'idle',
        settledTurn: { turnId: 'new', outcome: 'aborted', sequence: 4 },
        eventCursor: 4,
      },
    });
    // The earlier turn's settle is before the cursor and does not count.
    expect(
      evaluateSessionWait(session.ports, 't1', 'turn-settled', 4).satisfied,
    ).toBe(false);
  });
});

describe('SessionTurnWaiter', () => {
  test('the defaults are the documented literals', () => {
    expect(SESSION_WAIT_MAX_PER_CALLER).toBe(4);
    expect(SESSION_WAIT_MAX_TOTAL).toBe(256);
    expect(SESSION_WAIT_MAX_TIMEOUT_MS).toBe(50_000);
    // And a waiter built without limits uses them.
    const session = fakeSession();
    const waiter = new SessionTurnWaiter(session.ports) as unknown as {
      limits: { perCaller: number; total: number };
    };
    expect(waiter.limits).toEqual({ perCaller: 4, total: 256 });
  });

  test('turn-settled with no cursor and nothing running is already settled', async () => {
    const session = fakeSession();
    const waiter = new SessionTurnWaiter(session.ports);
    expect(
      await waiter.wait({
        callerSessionId: 'c',
        threadId: 't1',
        until: 'turn-settled',
        timeoutMs: 1000,
      }),
    ).toMatchObject({ kind: 'settled', alreadyIdle: true, state: 'idle' });
    expect(waiter.active).toBe(0);
  });

  test('without a cursor it waits for the turn running now, and wakes on its terminal event', async () => {
    const session = fakeSession();
    session.append('turn.started', 'a');
    const waiter = new SessionTurnWaiter(session.ports);
    const pending = waiter.wait({
      callerSessionId: 'c',
      threadId: 't1',
      until: 'turn-settled',
      timeoutMs: 5000,
    });
    expect(waiter.active).toBe(1);
    session.append('turn.completed', 'a');
    expect(await pending).toMatchObject({
      kind: 'settled',
      settledTurn: { turnId: 'a', outcome: 'completed' },
    });
    expect(waiter.active).toBe(0);
    expect(session.listeners.size).toBe(0);
  });

  test('a timeout reports the Session still running and leaves it so', async () => {
    const session = fakeSession();
    session.append('turn.started', 'a');
    const waiter = new SessionTurnWaiter(session.ports);
    const result = await waiter.wait({
      callerSessionId: 'c',
      threadId: 't1',
      until: 'idle',
      timeoutMs: 20,
    });
    expect(result).toMatchObject({
      kind: 'timeout',
      state: 'running',
      openTurnId: 'a',
    });
    // The waiter holds no port that could act on the Session, and the log is
    // untouched: nothing was appended by the wait.
    expect(session.ports.foldEvents('t1')).toHaveLength(1);
    expect(waiter.active).toBe(0);
    expect(session.listeners.size).toBe(0);
  });

  test('an aborted request frees its slot and its subscription, and never resolves as settled', async () => {
    const session = fakeSession();
    session.append('turn.started', 'a');
    const waiter = new SessionTurnWaiter(session.ports);
    const controller = new AbortController();
    const pending = waiter.wait({
      callerSessionId: 'c',
      threadId: 't1',
      until: 'idle',
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    expect(waiter.active).toBe(1);
    controller.abort();
    expect(await pending).toEqual({ kind: 'aborted' });
    expect(waiter.active).toBe(0);
    expect(session.listeners.size).toBe(0);
    expect(
      await waiter.wait({
        callerSessionId: 'c',
        threadId: 't1',
        until: 'idle',
        timeoutMs: 5,
        signal: AbortSignal.abort(),
      }),
    ).toEqual({ kind: 'aborted' });
  });

  test('at most 4 waits per calling session and 256 in all, refused rather than queued', async () => {
    const session = fakeSession();
    session.append('turn.started', 'a');
    const waiter = new SessionTurnWaiter(session.ports);
    const hold = (caller: string) =>
      waiter.wait({
        callerSessionId: caller,
        threadId: 't1',
        until: 'idle',
        timeoutMs: 60_000,
      });
    expect(SESSION_WAIT_MAX_PER_CALLER).toBe(4);
    const held = Array.from({ length: 4 }, () => hold('c1'));
    expect(await hold('c1')).toEqual({ kind: 'capacity', scope: 'caller' });
    // Another caller is unaffected.
    const other = hold('c2');
    expect(waiter.active).toBe(5);
    session.append('turn.completed', 'a');
    await Promise.all([...held, other]);
    expect(waiter.active).toBe(0);
    // The station-wide cap.
    session.append('turn.started', 'b');
    const small = new SessionTurnWaiter(session.ports, {
      perCaller: 10,
      total: 3,
    });
    const three = ['a', 'b', 'c'].map((caller) =>
      small.wait({
        callerSessionId: caller,
        threadId: 't1',
        until: 'idle',
        timeoutMs: 60_000,
      }),
    );
    expect(
      await small.wait({
        callerSessionId: 'd',
        threadId: 't1',
        until: 'idle',
        timeoutMs: 5,
      }),
    ).toEqual({ kind: 'capacity', scope: 'station' });
    session.append('turn.completed', 'b');
    await Promise.all(three);
  });
});
