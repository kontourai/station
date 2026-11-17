import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { TURN_ENGINE_ENDED_MESSAGE } from '@kontourai/station-shared/runtime-event-projection';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  SendTurnRefusedError,
} from '../../../providers/adapter-shape.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

/**
 * A turn start that may have reached the engine holds the Session's
 * turn-start claim, so no second turn runs beside it. These pin, through the
 * real service, coordinator and SQLite boundary authority, when that claim
 * settles without a restart: only once the Session's adapter has observed its
 * engine process gone. An engine that may still be running keeps it held.
 */
const makeTempDir = trackTempDirs();
const THREAD = 'held-start-chat';

/**
 * Shaped like the Claude adapter around an engine exit: the session record
 * stays after the process dies (its stream failed), the failure is published
 * as a `runtime.error` with no turn, and `engineEnded` answers from the
 * process's own observed exit.
 */
class EngineFake extends GateTestAdapter {
  readonly sends: ProviderSendTurnInput[] = [];
  private readonly alive = new Map<string, boolean>();
  private exits = 0;
  /** Replaces the next sends' behaviour; default: the engine starts the turn. */
  onSend?: (input: ProviderSendTurnInput) => Promise<ProviderTurnStartResult>;

  override async startSession(
    input: ProviderSessionStartInput,
  ): Promise<ProviderSession> {
    this.alive.set(input.threadId, true);
    return super.startSession(input);
  }
  override async hasSession(threadId: string): Promise<boolean> {
    return this.alive.has(threadId);
  }
  engineEnded(threadId: string): boolean {
    return this.alive.get(threadId) !== true;
  }
  /** The process a long-lived conversation keeps: back after a relaunch. */
  relaunch(threadId: string): void {
    this.alive.set(threadId, true);
  }
  override async sendTurn(
    input: ProviderSendTurnInput,
  ): Promise<ProviderTurnStartResult> {
    this.sends.push(input);
    if (this.onSend) return this.onSend(input);
    if (this.alive.get(input.threadId) !== true)
      throw new SendTurnRefusedError('The engine has stopped.', 'session_gone');
    return { threadId: input.threadId, turnId: `turn-${this.sends.length}` };
  }
  /** SIGTERM of the engine process, reported the way the Claude adapter does. */
  exitEngine(threadId: string): string {
    this.alive.set(threadId, false);
    const eventId = `engine-exit-${++this.exits}`;
    this.events.push({
      eventId,
      provider: 'claude',
      threadId,
      createdAt: new Date().toISOString(),
      method: 'runtime.error',
      severity: 'error',
      message:
        'Claude model "claude-sonnet" failed: Claude Code process exited with code 143',
    } as CanonicalRuntimeEvent);
    return eventId;
  }
  turnStarted(threadId: string, turnId: string, invocationId?: string): string {
    const eventId = `started-${turnId}`;
    this.events.push({
      eventId,
      provider: 'claude',
      threadId,
      turnId,
      ...(invocationId ? { invocationId } : {}),
      createdAt: new Date().toISOString(),
      method: 'turn.started',
      prompt: 'first',
    } as CanonicalRuntimeEvent);
    return eventId;
  }
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function boot() {
  const store = new EventStore(
    join(makeTempDir('station-held-turn-start-'), 'orchestration.sqlite'),
  );
  const adapter = new EngineFake();
  const logger = { debug: vi.fn(), warn: vi.fn() };
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus: new EventBus(),
    eventStore: store,
    logger,
  });
  open.push(async () => {
    await service.shutdown();
    adapter.events.close();
    store.close();
  });
  await service.dispatch({
    type: 'startSession',
    input: { threadId: THREAD, provider: 'claude' },
  });
  let keys = 0;
  const send = (input: string) =>
    service.dispatch({
      type: 'sendTurn',
      input: { threadId: THREAD, input, clientTurnId: `key-${++keys}` },
    }) as Promise<ProviderTurnStartResult>;
  const outcome = (input: string) =>
    send(input).then(
      (result) => ({ kind: 'started' as const, turnId: result.turnId }),
      (error: unknown) => ({
        kind: 'failed' as const,
        code: (error as { code?: string }).code,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  const persisted = (eventId: string) =>
    vi.waitFor(() =>
      expect(store.listEvents(THREAD).some((e) => e.id === eventId)).toBe(true),
    );
  const banner = () =>
    store
      .listEvents(THREAD)
      .find((event) => event.id.startsWith('turn-interrupted:'));
  const warned = (text: string) =>
    logger.warn.mock.calls.filter(([message]) =>
      String(message).startsWith(text),
    );
  return { adapter, service, store, send, outcome, persisted, banner, warned };
}

const MAY_HAVE_STARTED = 'foreground_message_indeterminate';
const HELD = 'turn_start_held';
const BUSY = /turn start in progress/;

describe('a turn start held over an engine exit', () => {
  test('the engine exited just before the request: the held start settles and the next start runs, with no restart', async () => {
    const h = await boot();
    await h.persisted(h.adapter.exitEngine(THREAD));
    // An adapter that cannot tell its failure was pre-effect: a plain error.
    h.adapter.onSend = async () => {
      throw new Error('Claude Code process exited with code 143');
    };
    expect(await h.outcome('lost')).toMatchObject({
      kind: 'failed',
      code: MAY_HAVE_STARTED,
    });
    expect(h.warned('Turn start claim held')).toHaveLength(1);
    expect(h.warned('Turn start claim held')[0]?.[1]).toMatchObject({
      threadId: THREAD,
      reason: 'Claude Code process exited with code 143',
    });

    h.adapter.onSend = undefined;
    // The next start is no longer refused as busy: the held start settled
    // and this one reached the (stopped) engine, which refused it cleanly.
    const next = await h.outcome('after the exit');
    expect(next.kind === 'failed' ? next.message : '').not.toMatch(BUSY);
    expect(h.adapter.sends).toHaveLength(2);
    expect(h.banner()?.payload).toMatchObject({
      method: 'session.state-changed',
      reason: TURN_ENGINE_ENDED_MESSAGE,
      interruptedTurnBoundary: { priorState: 'indeterminate' },
    });
    expect(h.warned('Held turn start settled')).toHaveLength(1);
    expect(h.warned('Held turn start settled')[0]?.[1]).toMatchObject({
      threadId: THREAD,
      reason: 'engine-ended',
    });
    // And once an engine is back, turns run as before.
    h.adapter.relaunch(THREAD);
    expect(await h.outcome('back')).toMatchObject({ kind: 'started' });
    expect(h.adapter.sends).toHaveLength(3);
  });

  test('the engine is still alive (the start timed out): the start stays held and every later start is refused', async () => {
    const h = await boot();
    h.adapter.onSend = async () => {
      throw new Error('Timed out waiting for the engine to accept the turn');
    };
    expect(await h.outcome('slow')).toMatchObject({
      kind: 'failed',
      code: MAY_HAVE_STARTED,
    });
    h.adapter.onSend = undefined;
    for (const attempt of ['again', 'and again', 'still']) {
      const refused = await h.outcome(attempt);
      expect(refused).toMatchObject({ kind: 'failed', code: HELD });
      expect(refused.kind === 'failed' ? refused.message : '').toMatch(BUSY);
      expect(refused.kind === 'failed' ? refused.message : '').toMatch(
        /If the engine has stopped, the next message records that turn as interrupted/,
      );
    }
    // Refused before the adapter: the held turn is never joined by another.
    expect(h.adapter.sends).toHaveLength(1);
    expect(h.banner()).toBeUndefined();
    expect(h.warned('Held turn start settled')).toHaveLength(0);
  });

  test('a turn that really started, confirmed too late, is never run beside a second one', async () => {
    const h = await boot();
    // The engine starts the turn, then the confirmation is lost.
    h.adapter.onSend = async (input) => {
      await h.persisted(
        h.adapter.turnStarted(THREAD, 'turn-late', input.invocationId),
      );
      throw new Error('socket hang up');
    };
    expect(await h.outcome('real work')).toMatchObject({
      kind: 'failed',
      code: MAY_HAVE_STARTED,
    });
    h.adapter.onSend = undefined;
    const second = await h.outcome('second');
    expect(second.kind === 'failed' ? second.message : '').toMatch(BUSY);
    expect(h.adapter.sends.map((sent) => sent.input)).toEqual(['real work']);
  });

  test('the engine exited between the request and its confirmation: its exit retires the claim', async () => {
    const h = await boot();
    h.adapter.onSend = async () => {
      await h.persisted(h.adapter.exitEngine(THREAD));
      throw new Error('Claude Code process exited with code 143');
    };
    expect(await h.outcome('lost')).toMatchObject({
      kind: 'failed',
      code: MAY_HAVE_STARTED,
    });
    h.adapter.onSend = undefined;
    h.adapter.relaunch(THREAD);
    expect(await h.outcome('next')).toMatchObject({ kind: 'started' });
    // Retired by the engine's own exit, not settled as held.
    expect(h.banner()).toBeUndefined();
  });

  test('a turn naming an earlier Session with no engine says to continue the conversation by its id', async () => {
    const h = await boot();
    const earlier = `${THREAD}:session:earlier`;
    h.store.reserveNextConversationSession({
      conversationId: THREAD,
      predecessorSessionId: THREAD,
      proposedSessionId: earlier,
      createdAt: new Date().toISOString(),
    });
    const answer = await h.service
      .dispatch({
        type: 'sendTurn',
        input: { threadId: earlier, input: 'hello?', clientTurnId: 'stale' },
      })
      .then(
        () => 'started',
        (error: unknown) =>
          error instanceof Error ? error.message : String(error),
      );
    expect(answer).toBe(
      `No provider session found for thread: ${earlier}. This is an earlier Session of conversation ${THREAD}. Continue the conversation by that id; Station sends the message to its current Session, starting a new one if needed.`,
    );
    expect(h.adapter.sends).toHaveLength(0);
  });

  test('the engine exited just after the turn was confirmed: nothing is held', async () => {
    const h = await boot();
    expect(await h.outcome('ran')).toMatchObject({ kind: 'started' });
    await h.persisted(h.adapter.exitEngine(THREAD));
    h.adapter.relaunch(THREAD);
    expect(await h.outcome('next')).toMatchObject({ kind: 'started' });
    expect(h.banner()).toBeUndefined();
  });
});
