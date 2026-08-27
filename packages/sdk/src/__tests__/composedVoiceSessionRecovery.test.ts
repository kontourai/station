import { describe, expect, it, vi } from 'vitest';
import { ComposedVoiceSessionAdapter } from '../voice/composed-session-adapter.js';
import { createTestingVoiceComponents } from '../voice/testing-components.js';

describe('ComposedVoiceSessionAdapter recovery', () => {
  it('hot-swaps a primary input runtime error to its secondary with ordered stop and receipt', async () => {
    const primary = createTestingVoiceComponents();
    const secondary = createTestingVoiceComponents();
    const order: string[] = [];
    vi.spyOn(primary.input, 'stop').mockImplementation(async () => {
      order.push('primary-stop');
    });
    vi.spyOn(secondary.input, 'start').mockImplementation(async () => {
      order.push('secondary-start');
    });
    const telemetry = vi.fn();
    const adapter = new ComposedVoiceSessionAdapter({
      ...primary,
      input: { primary: primary.input, secondary: secondary.input },
      telemetry,
    });
    await adapter.start();
    primary.input.emit({
      type: 'error',
      epoch: 1,
      error: new Error('primary failed after start'),
    });
    await drainUntil(() => order.includes('secondary-start'));
    expect(order).toEqual(['primary-stop', 'secondary-start']);
    expect(adapter.getSnapshot().state).toBe('listening');
    expect(
      telemetry.mock.calls
        .map(([event]) => event)
        .find((event) => event.type === 'secondary'),
    ).toMatchObject({
      attributes: {
        role: 'input',
        failedComponentId: primary.input.descriptor.id,
        secondaryComponentId: secondary.input.descriptor.id,
      },
    });
  });

  it('serializes concurrent primary input errors into one truthful secondary recovery', async () => {
    const primary = createTestingVoiceComponents();
    const secondary = createTestingVoiceComponents();
    const telemetry = vi.fn();
    const adapter = new ComposedVoiceSessionAdapter({
      ...primary,
      input: { primary: primary.input, secondary: secondary.input },
      telemetry,
    });
    await adapter.start();
    primary.input.emit({ type: 'error', epoch: 1, error: new Error('first') });
    primary.input.emit({ type: 'error', epoch: 1, error: new Error('second') });
    await drainUntil(() => secondary.input.startSignals.length === 1);

    expect(primary.input.stopSignals).toHaveLength(1);
    expect(secondary.input.startSignals).toHaveLength(1);
    expect(
      telemetry.mock.calls
        .map(([event]) => event)
        .filter((event) => event.type === 'secondary')
        .map((event) => event.attributes),
    ).toEqual([
      expect.objectContaining({
        role: 'input',
        failedComponentId: primary.input.descriptor.id,
        secondaryComponentId: secondary.input.descriptor.id,
      }),
    ]);
  });

  it('cleans up a runtime secondary whose start rejects and preserves that failure for retry', async () => {
    const primary = createTestingVoiceComponents();
    const secondary = createTestingVoiceComponents();
    const startFailure = new Error('runtime secondary start failed');
    let secondarySignal: AbortSignal | undefined;
    vi.spyOn(secondary.input, 'start').mockImplementationOnce(
      async (signal) => {
        secondarySignal = signal;
        throw startFailure;
      },
    );
    const adapter = new ComposedVoiceSessionAdapter({
      ...primary,
      input: { primary: primary.input, secondary: secondary.input },
    });
    await adapter.start();

    primary.input.emit({ type: 'error', epoch: 1, error: new Error('down') });
    await drainUntil(() => adapter.getSnapshot().state === 'error');

    expect(secondarySignal?.aborted).toBe(true);
    expect(secondary.input.stopSignals).toHaveLength(1);
    expect(adapter.getSnapshot()).toMatchObject({
      error: { message: startFailure.message },
    });
    await expect(adapter.start()).resolves.toMatchObject({ ok: true });
  });

  it('does not resurrect listening when stop wins a pending runtime secondary start', async () => {
    const primary = createTestingVoiceComponents();
    const secondary = createTestingVoiceComponents();
    const pendingStart = deferred<void>();
    const secondaryStart = vi
      .spyOn(secondary.input, 'start')
      .mockImplementation(async () => pendingStart.promise);
    const adapter = new ComposedVoiceSessionAdapter({
      ...primary,
      input: { primary: primary.input, secondary: secondary.input },
    });
    await adapter.start();

    primary.input.emit({ type: 'error', epoch: 1, error: new Error('down') });
    await drainUntil(() => secondaryStart.mock.calls.length === 1);
    await adapter.stop();
    pendingStart.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(adapter.getSnapshot().state).toBe('disconnected');
    expect(secondary.input.stopSignals).toHaveLength(1);
  });

  it('does not resurrect listening when dispose wins a pending runtime secondary start', async () => {
    const primary = createTestingVoiceComponents();
    const secondary = createTestingVoiceComponents();
    const pendingStart = deferred<void>();
    const secondaryStart = vi
      .spyOn(secondary.input, 'start')
      .mockImplementation(async () => pendingStart.promise);
    const adapter = new ComposedVoiceSessionAdapter({
      ...primary,
      input: { primary: primary.input, secondary: secondary.input },
    });
    await adapter.start();

    primary.input.emit({ type: 'error', epoch: 1, error: new Error('down') });
    await drainUntil(() => secondaryStart.mock.calls.length === 1);
    await adapter.dispose();
    pendingStart.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(adapter.getSnapshot().state).toBe('disconnected');
    expect(secondary.input.stopSignals).toHaveLength(1);
  });

  it('replays a secondary error emitted during its own start as a terminal failure', async () => {
    const primary = createTestingVoiceComponents();
    const secondary = createTestingVoiceComponents();
    const secondaryFailure = new Error('secondary emitted while starting');
    vi.spyOn(secondary.input, 'start').mockImplementation(async () => {
      secondary.input.emit({
        type: 'error',
        epoch: 1,
        error: secondaryFailure,
      });
    });
    const adapter = new ComposedVoiceSessionAdapter({
      ...primary,
      input: { primary: primary.input, secondary: secondary.input },
    });
    await adapter.start();

    primary.input.emit({ type: 'error', epoch: 1, error: new Error('down') });
    await drainUntil(() => adapter.getSnapshot().state === 'error');

    expect(adapter.getSnapshot()).toMatchObject({
      error: { message: secondaryFailure.message },
    });
    expect(secondary.input.stopSignals).toHaveLength(1);
  });

  it('treats a secondary error emitted by a listening snapshot subscriber as terminal', async () => {
    const primary = createTestingVoiceComponents();
    const secondary = createTestingVoiceComponents();
    const secondaryFailure = new Error(
      'secondary failed after recovery commit',
    );
    const adapter = new ComposedVoiceSessionAdapter({
      ...primary,
      input: { primary: primary.input, secondary: secondary.input },
    });
    let emitted = false;
    adapter.subscribe(() => {
      if (
        !emitted &&
        adapter.getSnapshot().state === 'listening' &&
        secondary.input.startSignals.length === 1
      ) {
        emitted = true;
        secondary.input.emit({
          type: 'error',
          epoch: 1,
          error: secondaryFailure,
        });
      }
    });
    await adapter.start();

    primary.input.emit({ type: 'error', epoch: 1, error: new Error('down') });
    await drainUntil(() => adapter.getSnapshot().state === 'error');

    expect(adapter.getSnapshot()).toMatchObject({
      error: { message: secondaryFailure.message },
    });
  });

  it('invalidates a stopped recovery before a restart reuses the primary adapter', async () => {
    const primary = createTestingVoiceComponents();
    const secondary = createTestingVoiceComponents();
    const staleSecondaryStart = deferred<void>();
    const secondaryStart = vi
      .spyOn(secondary.input, 'start')
      .mockImplementationOnce(async () => staleSecondaryStart.promise)
      .mockImplementation(async () => undefined);
    const adapter = new ComposedVoiceSessionAdapter({
      ...primary,
      input: { primary: primary.input, secondary: secondary.input },
    });
    await adapter.start();

    primary.input.emit({ type: 'error', epoch: 1, error: new Error('first') });
    await drainUntil(() => secondaryStart.mock.calls.length === 1);
    await adapter.stop();
    await adapter.start();
    primary.input.emit({ type: 'error', epoch: 2, error: new Error('second') });
    await drainUntil(() => secondaryStart.mock.calls.length === 2);
    staleSecondaryStart.reject(new Error('stale secondary start failed'));
    await Promise.resolve();

    expect(adapter.getSnapshot().state).toBe('listening');
    expect(secondary.input.start).toHaveBeenCalledTimes(2);
  });

  it('keeps a newer restart listening when a stale secondary start later rejects', async () => {
    const primary = createTestingVoiceComponents();
    const secondary = createTestingVoiceComponents();
    const staleSecondaryStart = deferred<void>();
    const secondaryStart = vi
      .spyOn(secondary.input, 'start')
      .mockImplementationOnce(async () => staleSecondaryStart.promise);
    const adapter = new ComposedVoiceSessionAdapter({
      ...primary,
      input: { primary: primary.input, secondary: secondary.input },
    });
    await adapter.start();

    primary.input.emit({ type: 'error', epoch: 1, error: new Error('down') });
    await drainUntil(() => secondaryStart.mock.calls.length === 1);
    await adapter.stop();
    await adapter.start();
    const restartRevision = adapter.getSnapshot().revision;
    staleSecondaryStart.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(adapter.getSnapshot()).toMatchObject({ state: 'listening' });
    expect(adapter.getSnapshot().revision).toBe(restartRevision);
  });

  it('ignores secondary speech events until its runtime start commits', async () => {
    const primary = createTestingVoiceComponents();
    const secondary = createTestingVoiceComponents();
    const pendingStart = deferred<void>();
    const secondaryStart = vi
      .spyOn(secondary.input, 'start')
      .mockImplementation(async () => {
        secondary.input.emit({
          type: 'interim',
          epoch: 1,
          transcript: 'early',
        });
        secondary.input.emit({ type: 'final', epoch: 1, transcript: 'early' });
        await pendingStart.promise;
      });
    const adapter = new ComposedVoiceSessionAdapter({
      ...primary,
      input: { primary: primary.input, secondary: secondary.input },
    });
    await adapter.start();

    primary.input.emit({ type: 'error', epoch: 1, error: new Error('down') });
    await drainUntil(() => secondaryStart.mock.calls.length === 1);
    pendingStart.resolve();
    await drainUntil(() => adapter.getSnapshot().state === 'listening');

    expect(adapter.getSnapshot().transcript).toBeUndefined();
    expect(primary.agent.inputs).toEqual([]);
  });

  it('deduplicates concurrent starts and stop aborts their shared provider signal', async () => {
    const components = createTestingVoiceComponents();
    const pendingStart = deferred<void>();
    let signal: AbortSignal | undefined;
    const inputStart = vi
      .spyOn(components.input, 'start')
      .mockImplementation(async (inputSignal) => {
        signal = inputSignal;
        await pendingStart.promise;
      });
    const adapter = new ComposedVoiceSessionAdapter(components);

    const first = adapter.start();
    const second = adapter.start();
    await drainUntil(() => inputStart.mock.calls.length === 1);
    await adapter.stop();
    pendingStart.resolve();
    await Promise.all([first, second]);

    expect(components.input.start).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(true);
    expect(adapter.getSnapshot().state).toBe('disconnected');
  });

  it('immediately aborts and terminally fails a secondary error during a hung runtime start', async () => {
    const primary = createTestingVoiceComponents();
    const secondary = createTestingVoiceComponents();
    const pendingStart = deferred<void>();
    let secondarySignal: AbortSignal | undefined;
    const secondaryStart = vi
      .spyOn(secondary.input, 'start')
      .mockImplementation(async (signal) => {
        secondarySignal = signal;
        await pendingStart.promise;
      });
    const adapter = new ComposedVoiceSessionAdapter({
      ...primary,
      input: { primary: primary.input, secondary: secondary.input },
    });
    await adapter.start();

    primary.input.emit({ type: 'error', epoch: 1, error: new Error('down') });
    await drainUntil(() => secondaryStart.mock.calls.length === 1);
    secondary.input.emit({
      type: 'error',
      epoch: 1,
      error: new Error('secondary failed while starting'),
    });
    await drainUntil(() => adapter.getSnapshot().state === 'error');

    expect(secondarySignal?.aborted).toBe(true);
    expect(secondary.input.stopSignals).toHaveLength(1);
    pendingStart.resolve();
    await Promise.resolve();
    expect(adapter.getSnapshot().state).toBe('error');
  });

  it('waits for a non-awaited stop before beginning a new start', async () => {
    const components = createTestingVoiceComponents();
    const pendingStop = deferred<void>();
    const playbackStop = vi
      .spyOn(components.playback, 'stop')
      .mockImplementation(async () => pendingStop.promise);
    const adapter = new ComposedVoiceSessionAdapter(components);
    await adapter.start();

    const stopping = adapter.stop();
    await drainUntil(() => playbackStop.mock.calls.length === 1);
    const restarting = adapter.start();
    expect(components.input.startSignals).toHaveLength(1);
    pendingStop.resolve();
    await Promise.all([stopping, restarting]);

    expect(components.input.startSignals).toHaveLength(2);
    expect(adapter.getSnapshot().state).toBe('listening');
  });

  it('deduplicates overlapping stops into one teardown operation', async () => {
    const components = createTestingVoiceComponents();
    const pendingStop = deferred<void>();
    vi.spyOn(components.playback, 'stop').mockImplementation(
      async () => pendingStop.promise,
    );
    const adapter = new ComposedVoiceSessionAdapter(components);
    await adapter.start();

    const first = adapter.stop();
    const second = adapter.stop();
    expect(second).toBe(first);
    pendingStop.resolve();
    await first;

    expect(components.playback.stop).toHaveBeenCalledTimes(1);
    expect(components.input.stopSignals).toHaveLength(1);
  });

  it('does not let a stale interrupt projection overwrite a completed stop', async () => {
    const components = createTestingVoiceComponents();
    const pendingInterrupt = deferred<void>();
    let playbackStops = 0;
    vi.spyOn(components.playback, 'stop').mockImplementation(async () => {
      playbackStops += 1;
      if (playbackStops === 1) await pendingInterrupt.promise;
    });
    const adapter = new ComposedVoiceSessionAdapter(components);
    await adapter.start();

    const interrupt = adapter.interrupt();
    await drainUntil(() => playbackStops === 1);
    await adapter.stop();
    const stoppedRevision = adapter.getSnapshot().revision;
    pendingInterrupt.resolve();
    await interrupt;

    expect(adapter.getSnapshot()).toMatchObject({ state: 'disconnected' });
    expect(adapter.getSnapshot().revision).toBe(stoppedRevision);
  });

  it('returns the exact active start promise to a connecting snapshot subscriber', async () => {
    const components = createTestingVoiceComponents();
    const adapter = new ComposedVoiceSessionAdapter(components);
    let reentrant: Promise<unknown> | undefined;
    adapter.subscribe(() => {
      if (adapter.getSnapshot().state === 'connecting' && !reentrant)
        reentrant = adapter.start();
    });

    const start = adapter.start();
    expect(reentrant).toBe(start);
    await start;
    expect(components.input.startSignals).toHaveLength(1);
  });

  it('waits for tracked failed-recovery cleanup before an error-listener restart', async () => {
    const primary = createTestingVoiceComponents();
    const secondary = createTestingVoiceComponents();
    const pendingCleanup = deferred<void>();
    vi.spyOn(secondary.input, 'stop').mockImplementation(
      async () => pendingCleanup.promise,
    );
    vi.spyOn(secondary.input, 'start').mockImplementation(async () => {
      secondary.input.emit({
        type: 'error',
        epoch: 1,
        error: new Error('secondary failed'),
      });
    });
    const adapter = new ComposedVoiceSessionAdapter({
      ...primary,
      input: { primary: primary.input, secondary: secondary.input },
    });
    let restart: Promise<unknown> | undefined;
    adapter.subscribe(() => {
      if (adapter.getSnapshot().state === 'error' && !restart)
        restart = adapter.start();
    });
    await adapter.start();

    primary.input.emit({ type: 'error', epoch: 1, error: new Error('down') });
    await drainUntil(() => restart !== undefined);
    expect(primary.input.startSignals).toHaveLength(1);
    pendingCleanup.resolve();
    await restart;

    expect(primary.input.startSignals).toHaveLength(2);
    expect(adapter.getSnapshot().state).toBe('listening');
  });

  it('waits for both active stop and tracked cleanup without stopping the failed secondary twice', async () => {
    const primary = createTestingVoiceComponents();
    const secondary = createTestingVoiceComponents();
    const pendingCleanup = deferred<void>();
    const secondaryStop = vi
      .spyOn(secondary.input, 'stop')
      .mockImplementation(async () => pendingCleanup.promise);
    vi.spyOn(secondary.input, 'start').mockImplementation(async () => {
      secondary.input.emit({
        type: 'error',
        epoch: 1,
        error: new Error('secondary failed'),
      });
    });
    const adapter = new ComposedVoiceSessionAdapter({
      ...primary,
      input: { primary: primary.input, secondary: secondary.input },
    });
    let stopping: Promise<unknown> | undefined;
    let restarting: Promise<unknown> | undefined;
    adapter.subscribe(() => {
      if (adapter.getSnapshot().state === 'error' && !restarting) {
        stopping = adapter.stop();
        restarting = adapter.start();
      }
    });
    await adapter.start();

    primary.input.emit({ type: 'error', epoch: 1, error: new Error('down') });
    await drainUntil(() => restarting !== undefined);
    expect(primary.input.startSignals).toHaveLength(1);
    expect(secondaryStop).toHaveBeenCalledTimes(1);
    pendingCleanup.resolve();
    await Promise.all([stopping, restarting]);

    expect(primary.input.startSignals).toHaveLength(2);
    expect(secondaryStop).toHaveBeenCalledTimes(1);
    expect(adapter.getSnapshot().state).toBe('listening');
  });

  it('coalesces dispose and joins an active stop without duplicate teardown', async () => {
    const components = createTestingVoiceComponents();
    const pendingStop = deferred<void>();
    const playbackStop = vi
      .spyOn(components.playback, 'stop')
      .mockImplementation(async () => pendingStop.promise);
    const adapter = new ComposedVoiceSessionAdapter(components);
    await adapter.start();

    const stopping = adapter.stop();
    await drainUntil(() => playbackStop.mock.calls.length === 1);
    const firstDispose = adapter.dispose();
    const secondDispose = adapter.dispose();
    expect(secondDispose).toBe(firstDispose);
    await expect(adapter.start()).resolves.toMatchObject({ ok: false });
    pendingStop.resolve();
    await Promise.all([stopping, firstDispose]);

    expect(components.playback.stop).toHaveBeenCalledTimes(1);
    expect(components.input.stopSignals).toHaveLength(1);
    expect(adapter.getSnapshot().state).toBe('disconnected');
  });

  it('treats stop after completed disposal as a no-op', async () => {
    const components = createTestingVoiceComponents();
    const adapter = new ComposedVoiceSessionAdapter(components);
    await adapter.start();
    await adapter.dispose();
    const playbackStops = components.playback.calls.filter(
      (call) => call === 'stop',
    ).length;
    const inputStops = components.input.stopSignals.length;
    const revision = adapter.getSnapshot().revision;

    await expect(adapter.stop()).resolves.toMatchObject({ ok: true });

    expect(
      components.playback.calls.filter((call) => call === 'stop'),
    ).toHaveLength(playbackStops);
    expect(components.input.stopSignals).toHaveLength(inputStops);
    expect(adapter.getSnapshot()).toMatchObject({
      state: 'disconnected',
      revision,
    });
  });
});

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function drainUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Expected deferred operation to start.');
}
