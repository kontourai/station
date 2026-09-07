import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';
import {
  CodexAdapterTransport,
  codexSpawnEnv,
  createCodexSessionRecord,
} from '../adapters/codex-adapter-transport.js';

class FakeWritable extends Writable {
  readonly lines: string[] = [];

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const text = chunk.toString();
    for (const line of text.split('\n')) {
      if (line.trim()) {
        this.lines.push(line);
      }
    }
    callback();
  }
}

class FakeCodexProcess extends EventEmitter {
  readonly stdin = new FakeWritable();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor() {
    super();
    this.stdout.setEncoding('utf8');
    this.stderr.setEncoding('utf8');
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = true;
    this.signalCode = signal;
    this.emit('exit', 0);
    return true;
  }
}

class DelayedExitCodexProcess extends FakeCodexProcess {
  readonly signals: NodeJS.Signals[] = [];

  override kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = true;
    this.signals.push(signal);
    return false;
  }

  confirmExit(signal: NodeJS.Signals): void {
    this.signalCode = signal;
    this.emit('exit', null);
  }
}

async function nextEvent(
  iterator: AsyncIterator<any>,
  label: string,
): Promise<any> {
  const result = await Promise.race([
    iterator.next(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Timed out waiting for ${label}`)),
        750,
      ),
    ),
  ]);
  return result.value;
}

/**
 * archive#3451 finding L3: an exhaustive arity assertion — drains every
 * currently-queued event rather than reading only the first N via
 * `nextEvent`. Mirrors `codex-adapter.test.ts`'s helper of the same name.
 * Resolves once 100ms passes with nothing new (the queue's `next()` resolves
 * immediately for a buffered item, so a real quiescence window only elapses
 * when nothing is left).
 */
async function drainEvents(iterator: AsyncIterator<any>): Promise<any[]> {
  const results: any[] = [];
  for (;;) {
    const result = await Promise.race([
      iterator.next(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), 100),
      ),
    ]);
    if (result.done) break;
    results.push(result.value);
  }
  return results;
}

describe('CodexAdapterTransport', () => {
  test('routes stdout notifications and parses malformed JSON as warnings', async () => {
    const transport = new CodexAdapterTransport(
      () => new Date('2026-04-11T00:00:00Z'),
    );
    const processHandle = new FakeCodexProcess();
    const record = createCodexSessionRecord({
      externalThreadId: 'thread-1',
      process: processHandle,
      provider: 'codex',
      threadId: 'thread-1',
      model: 'gpt-5-codex',
      nowIso: () => '2026-04-11T00:00:00Z',
    });

    transport.registerSession(record);
    transport.setCodexThreadId(record, 'codex-thread-1');
    transport.handleProcess(record);

    const iterator = transport.streamEvents()[Symbol.asyncIterator]();
    transport.handleStdoutLine(
      record,
      JSON.stringify({
        method: 'thread/status/changed',
        params: {
          threadId: 'codex-thread-1',
          status: { type: 'active', activeFlags: [] },
        },
      }),
    );
    transport.handleStdoutLine(record, '{not json');

    expect(await nextEvent(iterator, 'session.state-changed')).toMatchObject({
      method: 'session.state-changed',
      from: 'idle',
      to: 'running',
    });
    const warning = await nextEvent(iterator, 'runtime.warning');
    expect(warning).toMatchObject({
      method: 'runtime.warning',
      code: 'codex-json-parse',
      message: 'Failed to parse Codex JSON-RPC payload.',
    });
    expect(JSON.stringify(warning)).not.toContain('{not json');
  });

  test('does not persist raw Codex stderr content', async () => {
    const transport = new CodexAdapterTransport(
      () => new Date('2026-04-11T00:00:00Z'),
    );
    const processHandle = new FakeCodexProcess();
    const record = createCodexSessionRecord({
      externalThreadId: 'thread-stderr',
      process: processHandle,
      provider: 'codex',
      threadId: 'thread-stderr',
      model: 'gpt-5-codex',
      nowIso: () => '2026-04-11T00:00:00Z',
    });
    transport.registerSession(record);
    transport.handleProcess(record);
    const iterator = transport.streamEvents()[Symbol.asyncIterator]();

    processHandle.stderr.write('token=must-not-persist\n');

    const warning = await nextEvent(iterator, 'stderr warning');
    expect(warning).toMatchObject({
      method: 'runtime.warning',
      code: 'codex-stderr',
      message: 'Codex app-server emitted stderr output.',
    });
    expect(JSON.stringify(warning)).not.toContain('must-not-persist');
  });

  test('confirms process-tree cleanup before publishing a natural exit', async () => {
    let confirmCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      confirmCleanup = resolve;
    });
    const terminateProcess = vi.fn(() => cleanup);
    const transport = new CodexAdapterTransport(
      () => new Date('2026-04-11T00:00:00Z'),
      terminateProcess,
    );
    const processHandle = new FakeCodexProcess();
    const record = createCodexSessionRecord({
      externalThreadId: 'thread-natural-exit',
      process: processHandle,
      provider: 'codex',
      threadId: 'thread-natural-exit',
      model: 'gpt-5-codex',
      nowIso: () => '2026-04-11T00:00:00Z',
    });
    transport.registerSession(record);
    transport.handleProcess(record);
    const iterator = transport.streamEvents()[Symbol.asyncIterator]();

    processHandle.exitCode = 0;
    processHandle.emit('exit', 0);
    await vi.waitFor(() => expect(terminateProcess).toHaveBeenCalledOnce());
    expect(transport.hasSession('thread-natural-exit')).toBe(true);

    confirmCleanup();
    expect(await nextEvent(iterator, 'confirmed natural exit')).toMatchObject({
      method: 'session.exited',
      sessionId: 'thread-natural-exit',
      reason: 'completed',
    });
    expect(transport.hasSession('thread-natural-exit')).toBe(false);
  });

  test('retains a natural-exit session when process-tree cleanup fails', async () => {
    const terminateProcess = vi
      .fn()
      .mockRejectedValueOnce(new Error('cleanup not confirmed'))
      .mockResolvedValueOnce(undefined);
    const transport = new CodexAdapterTransport(
      () => new Date('2026-04-11T00:00:00Z'),
      terminateProcess,
    );
    const processHandle = new FakeCodexProcess();
    const record = createCodexSessionRecord({
      externalThreadId: 'thread-natural-retry',
      process: processHandle,
      provider: 'codex',
      threadId: 'thread-natural-retry',
      model: 'gpt-5-codex',
      nowIso: () => '2026-04-11T00:00:00Z',
    });
    transport.registerSession(record);
    transport.handleProcess(record);
    const iterator = transport.streamEvents()[Symbol.asyncIterator]();

    processHandle.exitCode = 1;
    processHandle.emit('exit', 1);
    expect(await nextEvent(iterator, 'cleanup warning')).toMatchObject({
      method: 'runtime.warning',
      code: 'codex-process-cleanup-unconfirmed',
    });
    expect(transport.hasSession('thread-natural-retry')).toBe(true);

    await transport.stopSession(
      'thread-natural-retry',
      () => '2026-04-11T00:00:01Z',
    );
    expect(await nextEvent(iterator, 'retried stop')).toMatchObject({
      method: 'session.exited',
      reason: 'stopped',
    });
    expect(terminateProcess).toHaveBeenCalledTimes(2);
  });

  // archive#3473 path 1: a process death must not leave a turn with no
  // turn-scoped terminal event — synthesize one before session.exited.
  test('a natural exit with an unresolved turn synthesizes runtime.error before session.exited', async () => {
    const transport = new CodexAdapterTransport(
      () => new Date('2026-04-11T00:00:00Z'),
    );
    const processHandle = new FakeCodexProcess();
    const record = createCodexSessionRecord({
      externalThreadId: 'thread-orphaned-exit',
      process: processHandle,
      provider: 'codex',
      threadId: 'thread-orphaned-exit',
      model: 'gpt-5-codex',
      nowIso: () => '2026-04-11T00:00:00Z',
    });
    record.activeTurnId = 'turn-mid-flight';
    transport.registerSession(record);
    transport.handleProcess(record);
    const iterator = transport.streamEvents()[Symbol.asyncIterator]();

    processHandle.exitCode = 1;
    processHandle.emit('exit', 1);

    expect(
      await nextEvent(iterator, 'synthesized runtime.error'),
    ).toMatchObject({
      method: 'runtime.error',
      severity: 'error',
      turnId: 'turn-mid-flight',
      threadId: 'thread-orphaned-exit',
    });
    expect(await nextEvent(iterator, 'session.exited')).toMatchObject({
      method: 'session.exited',
      sessionId: 'thread-orphaned-exit',
      exitCode: 1,
    });
    expect(record.activeTurnId).toBeUndefined();
  });

  // archive#3451 fix round: the exit-handler counterpart of the stopSession
  // race test in codex-adapter.test.ts — a process exit while a
  // turn/interrupt RPC is in flight must not ALSO synthesize a duplicate
  // terminal for the turn that RPC targeted.
  test('a natural exit with a turn/interrupt in flight does not synthesize a duplicate terminal', async () => {
    const transport = new CodexAdapterTransport(
      () => new Date('2026-04-11T00:00:00Z'),
    );
    const processHandle = new FakeCodexProcess();
    const record = createCodexSessionRecord({
      externalThreadId: 'thread-interrupt-race',
      process: processHandle,
      provider: 'codex',
      threadId: 'thread-interrupt-race',
      model: 'gpt-5-codex',
      nowIso: () => '2026-04-11T00:00:00Z',
    });
    record.activeTurnId = 'turn-interrupt-race';
    transport.registerSession(record);
    transport.handleProcess(record);
    const iterator = transport.streamEvents()[Symbol.asyncIterator]();

    // Dispatch (but never resolve) a turn/interrupt, mirroring
    // interruptTurn's own in-flight RPC. The 4th (tracking-only) argument is
    // archive#3451 fix round D2 — required for `rejectPendingRpcRequests` to
    // recognize this interrupt as targeting the CURRENT active turn.
    const interruptRequest = transport
      .sendRequest(
        record,
        'turn/interrupt',
        {
          threadId: record.codexThreadId,
          turnId: 'turn-interrupt-race',
        },
        { turnId: 'turn-interrupt-race' },
      )
      .catch(() => undefined);

    processHandle.exitCode = 1;
    processHandle.emit('exit', 1);
    await interruptRequest;

    expect(await nextEvent(iterator, 'session.exited')).toMatchObject({
      method: 'session.exited',
      sessionId: 'thread-interrupt-race',
    });
    const events = await drainEvents(iterator);
    expect(
      events.filter((event) => event.method === 'runtime.error'),
    ).toHaveLength(0);
  });

  // archive#3451 fix round D3: a third teardown door that was never
  // enumerated — `ChildProcess` 'error' also fires for a stdin WRITE
  // failure after the process has started (sendRequest writes to stdin on
  // every RPC, including turn/start and turn/interrupt), not just spawn
  // failure. A mid-turn one must strand the turn no differently than the
  // other two teardown doors.
  test('a process error with an unresolved turn synthesizes runtime.error before session.exited', async () => {
    const transport = new CodexAdapterTransport(
      () => new Date('2026-04-11T00:00:00Z'),
    );
    const processHandle = new FakeCodexProcess();
    const record = createCodexSessionRecord({
      externalThreadId: 'thread-process-error',
      process: processHandle,
      provider: 'codex',
      threadId: 'thread-process-error',
      model: 'gpt-5-codex',
      nowIso: () => '2026-04-11T00:00:00Z',
    });
    record.activeTurnId = 'turn-mid-flight-error';
    transport.registerSession(record);
    transport.handleProcess(record);
    const iterator = transport.streamEvents()[Symbol.asyncIterator]();

    processHandle.emit('error', new Error('write EPIPE'));

    expect(
      await nextEvent(iterator, 'synthesized runtime.error'),
    ).toMatchObject({
      method: 'runtime.error',
      severity: 'error',
      turnId: 'turn-mid-flight-error',
      threadId: 'thread-process-error',
    });
    expect(await nextEvent(iterator, 'session.exited')).toMatchObject({
      method: 'session.exited',
      reason: 'process-error',
    });
    expect(record.activeTurnId).toBeUndefined();
  });

  // #774: a stdin write landing after the reader is gone emits 'error'
  // (EPIPE) on the stdin stream — not the ChildProcess. It must run the same
  // teardown door as a process error, and stay idempotent when the process
  // 'exit' fires too (kernel reality: both usually arrive).
  test('a stdin EPIPE mid-turn rejects pending RPCs and synthesizes the terminal exactly once when exit also fires', async () => {
    const transport = new CodexAdapterTransport(
      () => new Date('2026-04-11T00:00:00Z'),
    );
    const processHandle = new FakeCodexProcess();
    const record = createCodexSessionRecord({
      externalThreadId: 'thread-stdin-epipe',
      process: processHandle,
      provider: 'codex',
      threadId: 'thread-stdin-epipe',
      model: 'gpt-5-codex',
      nowIso: () => '2026-04-11T00:00:00Z',
    });
    record.activeTurnId = 'turn-mid-flight-epipe';
    transport.registerSession(record);
    transport.handleProcess(record);
    const iterator = transport.streamEvents()[Symbol.asyncIterator]();

    const rpc = transport.sendRequest(record, 'turn/start', {});
    const rpcRejection = expect(rpc).rejects.toThrow(
      'Codex app-server stdin write failed: write EPIPE',
    );

    // stdin-first: EPIPE arrives, then the process exit for the same death.
    processHandle.stdin.emit(
      'error',
      Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }),
    );
    await rpcRejection;
    processHandle.exitCode = 1;
    processHandle.emit('exit', 1);

    expect(
      await nextEvent(iterator, 'synthesized runtime.error'),
    ).toMatchObject({
      method: 'runtime.error',
      severity: 'error',
      turnId: 'turn-mid-flight-epipe',
      threadId: 'thread-stdin-epipe',
    });
    expect(await nextEvent(iterator, 'session.exited')).toMatchObject({
      method: 'session.exited',
      reason: 'process-error',
    });
    expect(record.activeTurnId).toBeUndefined();
    expect(transport.hasSession('thread-stdin-epipe')).toBe(false);
    // No duplicate session.exited/terminal from the exit half of the
    // double fire.
    expect(await drainEvents(iterator)).toEqual([]);
  });

  // Reverse order of the same double fire: the exit door settles everything
  // (and unregisters the session) before the stdin EPIPE is observed — the
  // stdin handler must recognize the completed teardown and stay silent.
  test('a stdin EPIPE after a completed exit teardown does not duplicate session.exited', async () => {
    const transport = new CodexAdapterTransport(
      () => new Date('2026-04-11T00:00:00Z'),
    );
    const processHandle = new FakeCodexProcess();
    const record = createCodexSessionRecord({
      externalThreadId: 'thread-exit-then-epipe',
      process: processHandle,
      provider: 'codex',
      threadId: 'thread-exit-then-epipe',
      model: 'gpt-5-codex',
      nowIso: () => '2026-04-11T00:00:00Z',
    });
    record.activeTurnId = 'turn-mid-flight-exit-first';
    transport.registerSession(record);
    transport.handleProcess(record);
    const iterator = transport.streamEvents()[Symbol.asyncIterator]();

    const rpc = transport.sendRequest(record, 'turn/start', {});
    const rpcRejection = expect(rpc).rejects.toThrow(
      'Codex app-server exited before responding (code: 1)',
    );
    processHandle.exitCode = 1;
    processHandle.emit('exit', 1);
    await rpcRejection;
    // Let finalizeUnexpectedExit finish (terminate + unregister) before the
    // late stdin EPIPE lands.
    await new Promise((resolve) => setTimeout(resolve, 50));
    processHandle.stdin.emit(
      'error',
      Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }),
    );

    const events = await drainEvents(iterator);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      method: 'runtime.error',
      turnId: 'turn-mid-flight-exit-first',
    });
    expect(events[1]).toMatchObject({
      method: 'session.exited',
      reason: 'process-exit',
    });
  });

  // Double-terminal guard: a turn already closed by a real notification
  // (record.activeTurnId already cleared) must not get a second terminal
  // event synthesized on top of it.
  test('a natural exit with no unresolved turn publishes only session.exited', async () => {
    const transport = new CodexAdapterTransport(
      () => new Date('2026-04-11T00:00:00Z'),
    );
    const processHandle = new FakeCodexProcess();
    const record = createCodexSessionRecord({
      externalThreadId: 'thread-clean-exit',
      process: processHandle,
      provider: 'codex',
      threadId: 'thread-clean-exit',
      model: 'gpt-5-codex',
      nowIso: () => '2026-04-11T00:00:00Z',
    });
    // record.activeTurnId stays undefined — mirrors a turn already closed by
    // its own turn/completed notification.
    transport.registerSession(record);
    transport.handleProcess(record);
    const iterator = transport.streamEvents()[Symbol.asyncIterator]();

    processHandle.exitCode = 0;
    processHandle.emit('exit', 0);

    const events = await drainEvents(iterator);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      method: 'session.exited',
      reason: 'completed',
    });
  });

  // archive#3473 path 2: `stopSession` reached without a prior
  // `interruptTurn` (a hard session close) must also synthesize the missing
  // turn terminal.
  test('stopSession with an unresolved turn synthesizes runtime.error before session.exited', async () => {
    const transport = new CodexAdapterTransport(
      () => new Date('2026-04-11T00:00:00Z'),
    );
    const processHandle = new FakeCodexProcess();
    const record = createCodexSessionRecord({
      externalThreadId: 'thread-stop-orphaned',
      process: processHandle,
      provider: 'codex',
      threadId: 'thread-stop-orphaned',
      model: 'gpt-5-codex',
      nowIso: () => '2026-04-11T00:00:00Z',
    });
    record.activeTurnId = 'turn-stopped-mid-flight';
    transport.registerSession(record);
    transport.handleProcess(record);
    const iterator = transport.streamEvents()[Symbol.asyncIterator]();

    await transport.stopSession(
      'thread-stop-orphaned',
      () => '2026-04-11T00:00:01Z',
    );

    expect(
      await nextEvent(iterator, 'synthesized runtime.error'),
    ).toMatchObject({
      method: 'runtime.error',
      severity: 'error',
      turnId: 'turn-stopped-mid-flight',
    });
    expect(await nextEvent(iterator, 'session.exited')).toMatchObject({
      method: 'session.exited',
      reason: 'stopped',
    });
  });

  // Double-terminal guard: stopSession must not synthesize a runtime.error
  // for a turn interruptTurn already closed with its own turn.aborted
  // (interruptTurn marks `record.terminalPublishedForTurnId` on success —
  // see codex-adapter.ts).
  test('stopSession publishes only session.exited when no turn is unresolved', async () => {
    const transport = new CodexAdapterTransport(
      () => new Date('2026-04-11T00:00:00Z'),
    );
    const processHandle = new FakeCodexProcess();
    const record = createCodexSessionRecord({
      externalThreadId: 'thread-stop-clean',
      process: processHandle,
      provider: 'codex',
      threadId: 'thread-stop-clean',
      model: 'gpt-5-codex',
      nowIso: () => '2026-04-11T00:00:00Z',
    });
    transport.registerSession(record);
    transport.handleProcess(record);
    const iterator = transport.streamEvents()[Symbol.asyncIterator]();

    await transport.stopSession(
      'thread-stop-clean',
      () => '2026-04-11T00:00:01Z',
    );

    const events = await drainEvents(iterator);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      method: 'session.exited',
      reason: 'stopped',
    });
  });

  /**
   * station#1569 (item 4): `publishOrphanedTurnFailure` closes the orphaned
   * TURN, which says nothing about the individual tool rows of that turn —
   * they were left running forever in every client. Each session-end door now
   * settles them first, on the turn that issued them.
   */
  describe('open tool calls at session end (station#1569 item 4)', () => {
    function recordWithOpenCall(threadId: string) {
      const transport = new CodexAdapterTransport(
        () => new Date('2026-04-11T00:00:00Z'),
      );
      const processHandle = new FakeCodexProcess();
      const record = createCodexSessionRecord({
        externalThreadId: threadId,
        process: processHandle,
        provider: 'codex',
        threadId,
        model: 'gpt-5-codex',
        nowIso: () => '2026-04-11T00:00:00Z',
      });
      transport.registerSession(record);
      transport.handleProcess(record);
      // The shape `handleCodexItemStarted` leaves behind: the tool.started is
      // out, and the completion never came.
      record.activeTurnId = 'turn-open';
      record.toolNames.set('item-open', 'shell');
      record.openToolCalls.set('item-open', {
        toolName: 'shell',
        turnId: 'turn-open',
      });
      return { transport, processHandle, record };
    }

    test('stopSession settles them as unresolved, on their own turn, before session.exited', async () => {
      const { transport } = recordWithOpenCall('thread-stop-open-tool');
      const iterator = transport.streamEvents()[Symbol.asyncIterator]();

      await transport.stopSession(
        'thread-stop-open-tool',
        () => '2026-04-11T00:00:01Z',
      );

      const events = await drainEvents(iterator);
      expect(events.map((event) => event.method)).toEqual([
        'tool.completed',
        'runtime.error',
        'session.exited',
      ]);
      expect(events[0]).toMatchObject({
        toolCallId: 'item-open',
        toolName: 'shell',
        status: 'unresolved',
        turnId: 'turn-open',
        output:
          'No result was reported before the session ended; whether the tool ran is unknown.',
      });
    });

    test('an unexpected process exit settles them too', async () => {
      const { transport, processHandle } = recordWithOpenCall(
        'thread-exit-open-tool',
      );
      const iterator = transport.streamEvents()[Symbol.asyncIterator]();

      processHandle.emit('exit', 1, null);

      const events = await drainEvents(iterator);
      expect(events.map((event) => event.method)).toEqual([
        'tool.completed',
        'runtime.error',
        'session.exited',
      ]);
      expect(events[0]).toMatchObject({
        toolCallId: 'item-open',
        status: 'unresolved',
        turnId: 'turn-open',
      });
    });

    test('an exit whose process-tree cleanup was not confirmed settles them too', async () => {
      // station#1569 (L1): this handler runs ON the app-server's exit, so no
      // notification can arrive for an open call whatever happened to the
      // rest of its tree. Returning on the unconfirmed reap left those rows
      // running forever and made the contract's claim false for this path.
      const terminateProcess = vi
        .fn()
        .mockRejectedValueOnce(new Error('cleanup not confirmed'));
      const transport = new CodexAdapterTransport(
        () => new Date('2026-04-11T00:00:00Z'),
        terminateProcess,
      );
      const processHandle = new FakeCodexProcess();
      const record = createCodexSessionRecord({
        externalThreadId: 'thread-unconfirmed-open-tool',
        process: processHandle,
        provider: 'codex',
        threadId: 'thread-unconfirmed-open-tool',
        model: 'gpt-5-codex',
        nowIso: () => '2026-04-11T00:00:00Z',
      });
      transport.registerSession(record);
      transport.handleProcess(record);
      record.activeTurnId = 'turn-open';
      record.toolNames.set('item-open', 'shell');
      record.openToolCalls.set('item-open', {
        toolName: 'shell',
        turnId: 'turn-open',
      });
      const iterator = transport.streamEvents()[Symbol.asyncIterator]();

      processHandle.exitCode = 1;
      processHandle.emit('exit', 1);

      const events = await drainEvents(iterator);
      expect(events.map((event) => event.method)).toEqual([
        'runtime.warning',
        'tool.completed',
      ]);
      expect(events[1]).toMatchObject({
        toolCallId: 'item-open',
        status: 'unresolved',
        turnId: 'turn-open',
      });
      // The session is deliberately retained for a termination retry, so no
      // exit event here — the row is settled, not the session closed.
      expect(transport.hasSession('thread-unconfirmed-open-tool')).toBe(true);
    });

    /**
     * station#1586 (item 3): a record the thread no longer owns used to
     * publish NOTHING, so an open row on it would run forever. Its tool
     * terminals are turn-keyed (PR #1560 puts the issuing turnId on each one,
     * PR #1570 has both folds attribute by turn), so they land on that
     * record's own turn and never over a successor's. Only the thread-keyed
     * facts stay withheld.
     *
     * The state is constructed directly because production cannot reach it
     * with an open call today — `registerSession` throws while the old record
     * is still registered, so no restart lands mid-drain — which is why the
     * branch is documented as defensive in `finalizeUnexpectedExit` (fix
     * round, M3). This pins the decision the branch encodes; it is not
     * evidence of a live leak.
     */
    test('a superseded record settles its own open calls, without session.exited', async () => {
      const { transport, processHandle, record } = recordWithOpenCall(
        'thread-superseded-open-tool',
      );
      // The restart: the old record is replaced and a successor now owns this
      // thread id, while the old process is still on its way out.
      transport.unregisterSession(record);
      const successor = createCodexSessionRecord({
        externalThreadId: 'thread-superseded-open-tool',
        process: new FakeCodexProcess(),
        provider: 'codex',
        threadId: 'thread-superseded-open-tool',
        model: 'gpt-5-codex',
        nowIso: () => '2026-04-11T00:00:02Z',
      });
      transport.registerSession(successor);
      expect(transport.hasSession('thread-superseded-open-tool')).toBe(true);
      const iterator = transport.streamEvents()[Symbol.asyncIterator]();

      processHandle.emit('exit', 1, null);

      const events = await drainEvents(iterator);
      // Exactly one event: the old record's own tool row, on the turn that
      // issued it. No `session.exited` (the thread is live again, and a
      // client reads that as this thread's session ending) and no
      // orphaned-turn `runtime.error` (the turn it names is not the one in
      // flight).
      expect(events.map((event) => event.method)).toEqual(['tool.completed']);
      expect(events[0]).toMatchObject({
        toolCallId: 'item-open',
        toolName: 'shell',
        status: 'unresolved',
        turnId: 'turn-open',
        output:
          'No result was reported before the session ended; whether the tool ran is unknown.',
      });
      // The successor is untouched and still owns the thread.
      expect(transport.hasSession('thread-superseded-open-tool')).toBe(true);
      expect(record.openToolCalls.size).toBe(0);
      expect(successor.openToolCalls.size).toBe(0);
    });

    test('a stopped record publishes nothing here — stopSession owns its settle', async () => {
      // The discriminating control for the branch above: the guard that
      // remains is `record.stopped`, not supersession.
      const { transport, processHandle, record } = recordWithOpenCall(
        'thread-stopped-open-tool',
      );
      record.stopped = true;
      const iterator = transport.streamEvents()[Symbol.asyncIterator]();

      processHandle.emit('exit', 1, null);

      expect(await drainEvents(iterator)).toEqual([]);
      expect(record.openToolCalls.size).toBe(1);
    });

    test('a call that already completed is not settled again', async () => {
      // The discriminating control: the settle iterates observed open calls,
      // not every tool the session ever ran.
      const { transport, record } = recordWithOpenCall('thread-stop-no-open');
      record.openToolCalls.clear();
      const iterator = transport.streamEvents()[Symbol.asyncIterator]();

      await transport.stopSession(
        'thread-stop-no-open',
        () => '2026-04-11T00:00:01Z',
      );

      const events = await drainEvents(iterator);
      expect(events.map((event) => event.method)).toEqual([
        'runtime.error',
        'session.exited',
      ]);
    });
  });

  test('ignores notifications for foreign Codex subagent threads', async () => {
    const transport = new CodexAdapterTransport(
      () => new Date('2026-04-11T00:00:00Z'),
    );
    const processHandle = new FakeCodexProcess();
    const record = createCodexSessionRecord({
      externalThreadId: 'thread-foreign-filter',
      process: processHandle,
      provider: 'codex',
      threadId: 'thread-foreign-filter',
      model: 'gpt-5-codex',
      nowIso: () => '2026-04-11T00:00:00Z',
    });

    transport.registerSession(record);
    transport.setCodexThreadId(record, 'codex-thread-main');

    transport.handleStdoutLine(
      record,
      JSON.stringify({
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'codex-thread-subagent',
          turnId: 'turn-subagent',
          itemId: 'message-subagent',
          delta: 'foreign text',
        },
      }),
    );
    transport.handleStdoutLine(
      record,
      JSON.stringify({
        method: 'turn/completed',
        params: {
          threadId: 'codex-thread-subagent',
          turn: {
            id: 'turn-subagent',
            status: 'completed',
          },
        },
      }),
    );

    expect(record.turnOutput.has('turn-subagent')).toBe(false);
    expect(record.activeTurnId).toBeUndefined();
    expect(record.session.resumeCursor).toBeUndefined();

    const iterator = transport.streamEvents()[Symbol.asyncIterator]();
    transport.handleStdoutLine(
      record,
      JSON.stringify({
        method: 'thread/status/changed',
        params: {
          threadId: 'codex-thread-main',
          status: { type: 'active', activeFlags: [] },
        },
      }),
    );

    expect(await nextEvent(iterator, 'main-thread event')).toMatchObject({
      method: 'session.state-changed',
      threadId: 'thread-foreign-filter',
    });
  });

  test('writes JSON-RPC requests and resolves session lookup helpers', async () => {
    const transport = new CodexAdapterTransport(
      () => new Date('2026-04-11T00:00:00Z'),
    );
    const processHandle = new FakeCodexProcess();
    const record = createCodexSessionRecord({
      externalThreadId: 'thread-2',
      process: processHandle,
      provider: 'codex',
      threadId: 'thread-2',
      model: 'gpt-5-codex',
      nowIso: () => '2026-04-11T00:00:00Z',
    });

    transport.registerSession(record);
    expect(transport.hasSession('thread-2')).toBe(true);
    expect(transport.requireSession('thread-2')).toBe(record);
    const requestPromise = transport.sendRequest(record, 'initialize', {
      foo: 'bar',
    });
    expect(processHandle.stdin.lines[0]).toContain('"method":"initialize"');
    transport.handleStdoutLine(
      record,
      JSON.stringify({ id: '1', result: { ok: true } }),
    );
    await expect(requestPromise).resolves.toEqual({ ok: true });

    await transport.stopSession('thread-2', () => '2026-04-11T00:00:00Z');
    expect(transport.hasSession('thread-2')).toBe(false);
    expect(processHandle.killed).toBe(true);
  });

  test('waits for confirmed process exit before completing normal session teardown', async () => {
    const transport = new CodexAdapterTransport(
      () => new Date('2026-04-11T00:00:00Z'),
    );
    const processHandle = new DelayedExitCodexProcess();
    const record = createCodexSessionRecord({
      externalThreadId: 'thread-delayed-exit',
      process: processHandle,
      provider: 'codex',
      threadId: 'thread-delayed-exit',
      model: 'gpt-5-codex',
      nowIso: () => '2026-04-11T00:00:00Z',
    });
    transport.registerSession(record);
    transport.handleProcess(record);
    const iterator = transport.streamEvents()[Symbol.asyncIterator]();
    let stopped = false;

    const stop = transport
      .stopSession('thread-delayed-exit', () => '2026-04-11T00:00:00Z')
      .then(() => {
        stopped = true;
      });

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(processHandle.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(stopped).toBe(false);

    processHandle.confirmExit('SIGKILL');
    await stop;

    expect(stopped).toBe(true);
    expect(await nextEvent(iterator, 'session.exited')).toMatchObject({
      method: 'session.exited',
      sessionId: 'thread-delayed-exit',
      reason: 'stopped',
    });
  });

  test('bounds teardown when a process never confirms exit', async () => {
    vi.useFakeTimers();
    try {
      const transport = new CodexAdapterTransport(
        () => new Date('2026-04-11T00:00:00Z'),
      );
      const processHandle = new DelayedExitCodexProcess();
      const record = createCodexSessionRecord({
        externalThreadId: 'thread-no-exit',
        process: processHandle,
        provider: 'codex',
        threadId: 'thread-no-exit',
        model: 'gpt-5-codex',
        nowIso: () => '2026-04-11T00:00:00Z',
      });
      transport.registerSession(record);

      const stop = transport.stopSession(
        'thread-no-exit',
        () => '2026-04-11T00:00:00Z',
      );
      const assertion = expect(stop).rejects.toThrow(
        'Codex process did not confirm exit after SIGKILL.',
      );
      await vi.advanceTimersByTimeAsync(1_099);
      let settled = false;
      void stop.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await assertion;
      expect(processHandle.signals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(transport.hasSession('thread-no-exit')).toBe(true);
      expect(record.stopped).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// archive#896 wave 2: CODEX_HOME spawn seam — pure env-layering helper (no
// spawning), mirrors the claude-adapter's app-home env layering contract.
describe('codexSpawnEnv', () => {
  test('layers the override onto a full process.env spread', () => {
    const result = codexSpawnEnv({ CODEX_HOME: '/tmp/codex-profile' });
    expect(result).not.toBe(process.env);
    expect(result.CODEX_HOME).toBe('/tmp/codex-profile');
    for (const key of Object.keys(process.env)) {
      if (key === 'CODEX_HOME') continue;
      if (key === 'STATION_INTERNAL_API_TOKEN') continue;
      if (key === 'STATION_UI_BOOTSTRAP_TOKEN') continue;
      expect(result[key]).toBe(process.env[key]);
    }
  });

  test('returns a scrubbed copy, never the live process.env object', () => {
    const result = codexSpawnEnv();
    expect(result).not.toBe(process.env);
    expect(result).not.toHaveProperty('STATION_INTERNAL_API_TOKEN');
    expect(codexSpawnEnv(undefined)).not.toHaveProperty(
      'STATION_INTERNAL_API_TOKEN',
    );
  });
});
