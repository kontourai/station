/**
 * #2880: a Codex decision is RECORDED when Station answers
 * (`request.resolved`, `acknowledgement: 'engine'`) and DELIVERED only when
 * Codex's own `serverRequest/resolved` names the reply's wire id. A missing
 * acknowledgement is reported after a bounded window; a late one supersedes
 * that report; a reply outside Codex's decision vocabulary is never written
 * and never reads as delivered.
 *
 * Every case drives the real `CodexAdapter` through its child's stdout/stdin
 * (see `codex-adapter-wire-harness.ts`). Timers are faked only after the
 * session is up, so the acknowledgement window is advanced, not waited out.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { delegatedLastDecision } from '../../tools/station-control-delegation.js';
import {
  CODEX_APPROVAL_ACK_WINDOW_MS,
  CODEX_DECISION_REPLY_REFUSED_CODE,
  CODEX_DECISION_UNACKNOWLEDGED_CODE,
} from '../adapters/codex-approval-delivery.js';
import {
  commandApproval,
  emit,
  type FakeCodexProcess,
  openedRequestId,
  repliesTo,
  startedAdapter,
  THREAD,
  waitFor,
} from './codex-adapter-wire-harness.js';

afterEach(() => {
  vi.useRealTimers();
});

function of(events: any[], method: string): any[] {
  return events.filter((event) => event.method === method);
}

/** A stdout line under fake timers: written, then the reader drained. */
async function send(process: FakeCodexProcess, message: unknown) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
  await vi.advanceTimersByTimeAsync(0);
}

function acknowledgement(requestId: string | number) {
  return {
    method: 'serverRequest/resolved',
    params: { threadId: 'codex-thread', requestId },
  };
}

/** Up to one answered approval with id `wireId`, timers faked from there. */
async function answered(
  wireId: string | number,
  decision: 'accept' | 'decline' = 'accept',
) {
  const harness = await startedAdapter();
  await emit(harness.process, commandApproval(wireId));
  const requestId = await openedRequestId(harness.events);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  await harness.adapter.respondToRequest(THREAD, requestId, decision);
  await vi.advanceTimersByTimeAsync(0);
  return { ...harness, requestId };
}

describe('#2880: Codex decision delivery', () => {
  test('the acknowledgement window is pinned at 30 s', () => {
    // Literal next to the constant: a change to the window is a decision,
    // not a refactor (rationale on the constant).
    expect(CODEX_APPROVAL_ACK_WINDOW_MS).toBe(30_000);
  });

  test('the decision is recorded at once, as engine-acknowledgeable, before any delivery', async () => {
    const { adapter, events, requestId } = await answered(0);
    expect(of(events, 'request.resolved')).toEqual([
      expect.objectContaining({
        requestId,
        status: 'approved',
        acknowledgement: 'engine',
      }),
    ]);
    expect(of(events, 'request.delivery')).toEqual([]);
    expect(delegatedLastDecision(events)).toEqual({
      requestId,
      status: 'approved',
      delivery: 'awaiting-acknowledgement',
    });
    expect(adapter.metadata.approvalAcknowledgement).toBe('engine');
    await adapter.stopAll();
  });

  test.each([
    ['numeric', 0],
    ['string', 'approval-1'],
  ])(
    "Codex's acknowledgement of a %s id marks the decision acknowledged",
    async (_name, wireId) => {
      const { adapter, process, events, requestId } = await answered(wireId);
      await vi.advanceTimersByTimeAsync(40);
      await send(process, acknowledgement(wireId));

      expect(of(events, 'request.delivery')).toEqual([
        expect.objectContaining({
          requestId,
          outcome: 'acknowledged',
          waitedMs: 40,
        }),
      ]);
      expect(delegatedLastDecision(events)).toMatchObject({
        delivery: 'acknowledged',
        waitedMs: 40,
      });
      // Acknowledged in time: the window never reports it.
      await vi.advanceTimersByTimeAsync(CODEX_APPROVAL_ACK_WINDOW_MS * 2);
      expect(of(events, 'runtime.warning')).toEqual([]);
      await adapter.stopAll();
    },
  );

  test('an acknowledgement naming the same digits with another type is not ours', async () => {
    const { adapter, process, events, requestId } = await answered(0);
    await send(process, acknowledgement('0'));
    expect(of(events, 'request.delivery')).toEqual([]);
    await vi.advanceTimersByTimeAsync(CODEX_APPROVAL_ACK_WINDOW_MS);
    expect(of(events, 'request.delivery')).toEqual([
      expect.objectContaining({ requestId, outcome: 'unacknowledged' }),
    ]);
    await adapter.stopAll();
  });

  test('no acknowledgement: nothing before the window, then an attributable not-yet warning', async () => {
    const { adapter, events, requestId } = await answered(0);
    await vi.advanceTimersByTimeAsync(CODEX_APPROVAL_ACK_WINDOW_MS - 1);
    expect(of(events, 'request.delivery')).toEqual([]);
    expect(of(events, 'runtime.warning')).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(of(events, 'request.delivery')).toEqual([
      expect.objectContaining({
        requestId,
        outcome: 'unacknowledged',
        reason: 'no-acknowledgement',
        waitedMs: CODEX_APPROVAL_ACK_WINDOW_MS,
      }),
    ]);
    const [warning] = of(events, 'runtime.warning');
    expect(warning).toMatchObject({
      code: CODEX_DECISION_UNACKNOWLEDGED_CODE,
      details: { requestId },
    });
    expect(warning.message).toContain('not yet acknowledged');
    expect(warning.message).toContain('has not re-sent');
    expect(delegatedLastDecision(events)).toMatchObject({
      delivery: 'unacknowledged',
      reason: 'no-acknowledgement',
    });
    await adapter.stopAll();
  });

  test('nothing is ever re-sent while waiting', async () => {
    const { adapter, process, requestId } = await answered(0);
    expect(requestId).toBeTruthy();
    await vi.advanceTimersByTimeAsync(CODEX_APPROVAL_ACK_WINDOW_MS * 3);
    expect(repliesTo(process, 0)).toHaveLength(1);
    await adapter.stopAll();
  });

  test('a late acknowledgement supersedes the warning and clears the status', async () => {
    const { adapter, process, events, requestId } = await answered(0);
    await vi.advanceTimersByTimeAsync(CODEX_APPROVAL_ACK_WINDOW_MS);
    expect(delegatedLastDecision(events)?.delivery).toBe('unacknowledged');

    await vi.advanceTimersByTimeAsync(5_000);
    await send(process, acknowledgement(0));
    expect(of(events, 'request.delivery').map((e) => e.outcome)).toEqual([
      'unacknowledged',
      'acknowledged',
    ]);
    expect(delegatedLastDecision(events)).toMatchObject({
      requestId,
      delivery: 'acknowledged',
      waitedMs: CODEX_APPROVAL_ACK_WINDOW_MS + 5_000,
    });
    await adapter.stopAll();
  });

  /** Delivery reports for `requestId`, in order, and where `session.exited` fell. */
  function deliveryBeforeExit(events: any[], requestId: string) {
    const methods = events
      .filter(
        (event) =>
          event.method === 'session.exited' ||
          (event.method === 'request.delivery' &&
            event.requestId === requestId),
      )
      .map((event) =>
        event.method === 'session.exited'
          ? 'session.exited'
          : `${event.outcome}:${event.reason ?? ''}`,
      );
    return methods;
  }

  test('stopping the session settles a waiting reply as unacknowledged before session.exited', async () => {
    const { adapter, events, requestId } = await answered(0);
    await vi.advanceTimersByTimeAsync(1_200);
    await adapter.stopSession(THREAD);
    await vi.advanceTimersByTimeAsync(0);

    expect(deliveryBeforeExit(events, requestId)).toEqual([
      'unacknowledged:no-acknowledgement',
      'session.exited',
    ]);
    expect(of(events, 'request.delivery')[0].waitedMs).toBe(1_200);
    expect(delegatedLastDecision(events)).toMatchObject({
      requestId,
      delivery: 'unacknowledged',
      reason: 'no-acknowledgement',
    });
    // The window's timer went with the session: no second report, no
    // "not yet" warning for a session that has already ended.
    await vi.advanceTimersByTimeAsync(CODEX_APPROVAL_ACK_WINDOW_MS * 2);
    expect(of(events, 'request.delivery')).toHaveLength(1);
    expect(
      of(events, 'runtime.warning').filter(
        (event) => event.code === CODEX_DECISION_UNACKNOWLEDGED_CODE,
      ),
    ).toEqual([]);
  });

  test('an unexpected exit settles a waiting reply at once, and an acknowledgement still in the pipe supersedes it', async () => {
    const { adapter, process, events, requestId } = await answered(0);
    process.emit('exit', 1);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(deliveryBeforeExit(events, requestId)).toEqual([
      'unacknowledged:no-acknowledgement',
      'session.exited',
    ]);
    await vi.advanceTimersByTimeAsync(CODEX_APPROVAL_ACK_WINDOW_MS * 2);
    expect(of(events, 'request.delivery')).toHaveLength(1);
    expect(
      of(events, 'runtime.warning').filter(
        (event) => event.code === CODEX_DECISION_UNACKNOWLEDGED_CODE,
      ),
    ).toEqual([]);

    // Codex acknowledged before dying; the line is read after the exit.
    await send(process, acknowledgement(0));
    expect(delegatedLastDecision(events)).toMatchObject({
      requestId,
      delivery: 'acknowledged',
    });
    await adapter.stopAll();
  });

  test('a process error settles a waiting reply before session.exited', async () => {
    const { adapter, process, events, requestId } = await answered(0);
    process.emit('error', new Error('spawn gone'));
    await vi.advanceTimersByTimeAsync(0);

    expect(deliveryBeforeExit(events, requestId)).toEqual([
      'unacknowledged:no-acknowledgement',
      'session.exited',
    ]);
    await vi.advanceTimersByTimeAsync(CODEX_APPROVAL_ACK_WINDOW_MS * 2);
    expect(of(events, 'request.delivery')).toHaveLength(1);
    await adapter.stopAll();
  });

  test('a stdin write failure (EPIPE) settles a waiting reply before session.exited', async () => {
    const { adapter, process, events, requestId } = await answered(0);
    process.stdin.emit('error', new Error('write EPIPE'));
    await vi.advanceTimersByTimeAsync(0);

    expect(deliveryBeforeExit(events, requestId)).toEqual([
      'unacknowledged:no-acknowledgement',
      'session.exited',
    ]);
    await vi.advanceTimersByTimeAsync(CODEX_APPROVAL_ACK_WINDOW_MS * 2);
    expect(of(events, 'request.delivery')).toHaveLength(1);
    await adapter.stopAll();
  });

  test('exceeding the stdout ingress limit settles a waiting reply at once', async () => {
    const { adapter, process, events, requestId } = await answered(0);
    // The adoption/recovery bound, armed as `startSession` arms it.
    const transport = (adapter as any).transport;
    transport.setStdoutIngressLimit(transport.getSession(THREAD), 8);
    process.stdout.write(`${'x'.repeat(64)}\n`);
    await vi.advanceTimersByTimeAsync(0);

    expect(of(events, 'request.delivery')).toEqual([
      expect.objectContaining({
        requestId,
        outcome: 'unacknowledged',
        reason: 'no-acknowledgement',
      }),
    ]);
    await vi.advanceTimersByTimeAsync(CODEX_APPROVAL_ACK_WINDOW_MS * 2);
    expect(of(events, 'request.delivery')).toHaveLength(1);
    expect(
      of(events, 'runtime.warning').filter(
        (event) => event.code === CODEX_DECISION_UNACKNOWLEDGED_CODE,
      ),
    ).toEqual([]);
    await adapter.stopAll();
  });

  test('a reply outside the vocabulary is refused, never written, and never reads as delivered', async () => {
    const harness = await startedAdapter();
    // Codex asks for a permission grant whose `permissions` is not an object;
    // echoing it would put a reply on the wire Codex cannot parse (and Codex
    // acknowledges even those).
    await emit(harness.process, {
      id: 5,
      method: 'item/permissions/requestApproval',
      params: {
        threadId: 'codex-thread',
        turnId: 'turn-1',
        itemId: 'perm-1',
        permissions: 'everything',
      },
    });
    const requestId = await openedRequestId(harness.events);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await harness.adapter.respondToRequest(THREAD, requestId, 'accept');
    await vi.advanceTimersByTimeAsync(0);

    expect(repliesTo(harness.process, 5)).toEqual([]);
    expect(of(harness.events, 'request.resolved')).toEqual([
      expect.objectContaining({ requestId, acknowledgement: 'engine' }),
    ]);
    expect(of(harness.events, 'request.delivery')).toEqual([
      expect.objectContaining({
        requestId,
        outcome: 'unacknowledged',
        reason: 'invalid-reply',
      }),
    ]);
    expect(of(harness.events, 'runtime.warning')).toEqual([
      expect.objectContaining({
        code: CODEX_DECISION_REPLY_REFUSED_CODE,
        details: { requestId },
      }),
    ]);
    // Even if Codex later closes the request, the refused decision was never
    // sent, so it never becomes "acknowledged".
    await send(harness.process, acknowledgement(5));
    expect(
      of(harness.events, 'request.delivery').map((event) => event.outcome),
    ).toEqual(['unacknowledged']);
    expect(delegatedLastDecision(harness.events)).toMatchObject({
      delivery: 'unacknowledged',
      reason: 'invalid-reply',
    });
    await harness.adapter.stopAll();
  });

  /** Approval `wireId` open, fake timers on, then Codex closes it itself. */
  async function closedByCodex(wireId: number) {
    const harness = await startedAdapter();
    await emit(harness.process, commandApproval(wireId));
    const requestId = await openedRequestId(harness.events);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await send(harness.process, acknowledgement(wireId));
    return { ...harness, requestId };
  }

  test('a request Codex closes before any reply settles as closed by the engine, not as a decision', async () => {
    const { adapter, events, requestId } = await closedByCodex(9);
    expect(of(events, 'request.resolved')).toEqual([
      expect.objectContaining({
        requestId,
        status: 'cancelled',
        response: { reason: 'closed-by-engine' },
      }),
    ]);
    expect(of(events, 'request.resolved')[0]).not.toHaveProperty(
      'acknowledgement',
    );
    expect(of(events, 'request.delivery')).toEqual([]);
    expect(delegatedLastDecision(events)).toEqual({
      requestId,
      status: 'cancelled',
      delivery: 'not-reported',
    });
    await adapter.stopAll();
  });

  test('a user decision after Codex closed the request is refused and never reads acknowledged', async () => {
    const { adapter, process, events, requestId } = await closedByCodex(9);
    const answer = await adapter
      .respondToRequest(THREAD, requestId, 'accept')
      .then(
        () => 'accepted',
        (error: Error) => error.message,
      );
    await vi.advanceTimersByTimeAsync(CODEX_APPROVAL_ACK_WINDOW_MS * 2);
    // The claim under test first: nothing reads as acknowledged.
    expect(
      of(events, 'request.delivery').filter(
        (event) => event.outcome === 'acknowledged',
      ),
    ).toEqual([]);
    expect(delegatedLastDecision(events)?.delivery).not.toBe('acknowledged');
    // How: the decision is refused and never written.
    expect(answer).toMatch(/Unknown Codex approval request/);
    expect(repliesTo(process, 9)).toEqual([]);
    expect(of(events, 'request.delivery')).toEqual([]);
    expect(of(events, 'request.resolved').map((event) => event.status)).toEqual(
      ['cancelled'],
    );
    await adapter.stopAll();
  });

  test('Codex closing a request before the #2316 cancel reply: no reply, no delivery, no warning', async () => {
    const { adapter, process, events, requestId } = await closedByCodex(9);
    const interrupt = adapter.interruptTurn(THREAD, 'turn-1');
    await vi.advanceTimersByTimeAsync(0);
    const interruptRpc = process.stdin.lines
      .map((line) => JSON.parse(line))
      .find((line) => line.method === 'turn/interrupt');
    expect(interruptRpc).toBeDefined();
    await send(process, { id: interruptRpc.id, result: {} });
    await interrupt;

    expect(repliesTo(process, 9)).toEqual([]);
    expect(of(events, 'request.resolved')).toEqual([
      expect.objectContaining({ requestId, status: 'cancelled' }),
    ]);
    await vi.advanceTimersByTimeAsync(CODEX_APPROVAL_ACK_WINDOW_MS * 2);
    expect(of(events, 'request.delivery')).toEqual([]);
    expect(
      of(events, 'runtime.warning').filter(
        (event) => event.code === CODEX_DECISION_UNACKNOWLEDGED_CODE,
      ),
    ).toEqual([]);
    await adapter.stopAll();
  });

  /**
   * M1: the interrupt is in flight when the process dies; the teardown
   * rejects it, and its #2316 cancel reply is written AFTER the door
   * settled the watches. It settles at once, with no window and no warning.
   */
  test.each([
    ['exit', (process: FakeCodexProcess) => process.emit('exit', 1)],
    [
      'process error',
      (process: FakeCodexProcess) =>
        process.emit('error', new Error('spawn gone')),
    ],
  ])(
    'a cancel reply written after the %s door settles unacknowledged at once',
    async (_door, die) => {
      const harness = await startedAdapter();
      await emit(harness.process, commandApproval(9));
      const requestId = await openedRequestId(harness.events);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const interrupt = harness.adapter
        .interruptTurn(THREAD, 'turn-1')
        .catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      die(harness.process);
      await interrupt;
      await vi.advanceTimersByTimeAsync(2_000);

      expect(repliesTo(harness.process, 9)).toEqual([
        expect.objectContaining({ result: { decision: 'cancel' } }),
      ]);
      expect(of(harness.events, 'request.delivery')).toEqual([
        expect.objectContaining({
          requestId,
          outcome: 'unacknowledged',
          reason: 'no-acknowledgement',
          waitedMs: 0,
        }),
      ]);
      await vi.advanceTimersByTimeAsync(CODEX_APPROVAL_ACK_WINDOW_MS * 2);
      expect(of(harness.events, 'request.delivery')).toHaveLength(1);
      expect(
        of(harness.events, 'runtime.warning').filter(
          (event) => event.code === CODEX_DECISION_UNACKNOWLEDGED_CODE,
        ),
      ).toEqual([]);
      await harness.adapter.stopAll();
    },
  );

  test('an interrupt-cancelled approval (#2316) is watched like any other reply', async () => {
    const harness = await startedAdapter();
    await emit(harness.process, commandApproval(9));
    const requestId = await openedRequestId(harness.events);
    const interrupt = harness.adapter.interruptTurn(THREAD, 'turn-1');
    const interruptRpc = await waitFor(
      () =>
        harness.process.stdin.lines
          .map((line) => JSON.parse(line))
          .find((line) => line.method === 'turn/interrupt'),
      'turn/interrupt',
    );
    await emit(harness.process, { id: interruptRpc.id, result: {} });
    await interrupt;
    expect(repliesTo(harness.process, 9)).toEqual([
      expect.objectContaining({ result: { decision: 'cancel' } }),
    ]);
    await emit(harness.process, acknowledgement(9));
    expect(of(harness.events, 'request.delivery')).toEqual([
      expect.objectContaining({ requestId, outcome: 'acknowledged' }),
    ]);
    await harness.adapter.stopAll();
  });
});
