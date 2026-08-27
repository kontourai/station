import { describe, expect, it, vi } from 'vitest';
import { ComposedVoiceSessionAdapter } from '../voice/composed-session-adapter.js';
import {
  createTestingVoiceComponents,
  deferredVoiceTokens,
} from '../voice/testing-components.js';

describe('ComposedVoiceSessionAdapter', () => {
  it('projects the composed lifecycle and shares one immutable turn path for speech and text', async () => {
    const components = createTestingVoiceComponents({
      tokens: ['hello', ' world'],
    });
    const adapter = new ComposedVoiceSessionAdapter(components);
    const states: string[] = [];
    adapter.subscribe(() => states.push(adapter.getSnapshot().state));

    await adapter.start({ context: { project: 'one' } });
    components.input.emit({ type: 'final', epoch: 1, transcript: 'spoken' });
    await components.settle();
    await adapter.sendText?.({ text: 'typed' });

    expect(components.agent.inputs.map((input) => input.text)).toEqual([
      'spoken',
      'typed',
    ]);
    expect(
      components.agent.inputs.every((input) => Object.isFrozen(input.context)),
    ).toBe(true);
    expect(states).toEqual(
      expect.arrayContaining([
        'listening',
        'transcribing',
        'thinking',
        'speaking',
        'connected-idle',
      ]),
    );
  });

  it('snapshots nested context so caller mutation cannot change an active session', async () => {
    const components = createTestingVoiceComponents({ tokens: ['answer'] });
    const source = { project: { name: 'one' }, tags: ['initial'] };
    const adapter = new ComposedVoiceSessionAdapter(components);
    await adapter.start({ context: source });
    source.project.name = 'mutated';
    source.tags.push('late');
    await adapter.sendText?.({ text: 'context' });

    expect(components.agent.inputs[0]?.context).toEqual({
      project: { name: 'one' },
      tags: ['initial'],
    });
    expect(
      Object.isFrozen(
        components.agent.inputs[0]?.context.project as Record<string, unknown>,
      ),
    ).toBe(true);
    expect(Object.isFrozen(components.agent.inputs[0]?.context.tags)).toBe(
      true,
    );
  });

  it('aborts stale agent output and awaits playback stop before accepting a barge-in turn', async () => {
    const pending = deferredVoiceTokens();
    const components = createTestingVoiceComponents({
      tokenStream: pending.stream,
    });
    const adapter = new ComposedVoiceSessionAdapter(components);
    const log: string[] = [];
    const stop = deferred<void>();
    let stopCount = 0;
    vi.spyOn(components.playback, 'stop').mockImplementation(async () => {
      stopCount += 1;
      log.push(`stop:${stopCount}`);
      if (stopCount === 2) {
        await stop.promise;
        log.push('stop:resolved');
      }
    });
    const run = components.agent.run.bind(components.agent);
    vi.spyOn(components.agent, 'run').mockImplementation((input) => {
      log.push(`agent:${input.text}`);
      return run(input);
    });
    await adapter.start();
    components.input.emit({ type: 'final', epoch: 1, transcript: 'first' });
    await Promise.resolve();
    components.input.emit({ type: 'final', epoch: 2, transcript: 'second' });
    await Promise.resolve();
    expect(log).not.toContain('agent:second');
    stop.resolve();
    await components.settle();
    pending.resolve(['late']);
    await components.settle();

    expect(log.indexOf('stop:resolved')).toBeLessThan(
      log.indexOf('agent:second'),
    );
    expect(components.agent.inputs.map((input) => input.text)).toEqual([
      'first',
      'second',
    ]);
    expect(
      components.synthesis.inputs.map((input) => input.text),
    ).not.toContain('late');
  });

  it('waits to project interim barge-in speech until deferred playback stop resolves', async () => {
    const pending = deferred<void>();
    const agent = deferred<readonly string[]>();
    const components = createTestingVoiceComponents({
      tokenStream: async function* () {
        yield* await agent.promise;
      },
    });
    const adapter = new ComposedVoiceSessionAdapter(components);
    await adapter.start();
    const turn = adapter.sendText?.({ text: 'turn' });
    await components.settle();
    let stopCalls = 0;
    vi.spyOn(components.playback, 'stop').mockImplementation(async () => {
      stopCalls += 1;
      if (stopCalls === 1) await pending.promise;
    });
    components.input.emit({ type: 'interim', epoch: 2, transcript: 'barge' });
    await Promise.resolve();
    expect(adapter.getSnapshot().transcript).not.toBe('barge');
    pending.resolve();
    await components.settle();
    expect(adapter.getSnapshot()).toMatchObject({
      state: 'listening',
      transcript: 'barge',
      transcriptRole: 'user',
    });
    agent.resolve(['late']);
    await turn;
  });

  it('aborts deferred agent and synthesis work on explicit interrupt without stale playback', async () => {
    const pendingAgent = deferred<readonly string[]>();
    const components = createTestingVoiceComponents({
      tokenStream: async function* () {
        yield* await pendingAgent.promise;
      },
    });
    const adapter = new ComposedVoiceSessionAdapter(components);
    await adapter.start();
    const agentTurn = adapter.sendText?.({ text: 'agent' });
    await components.settle();
    await adapter.interrupt?.();
    expect(components.agent.inputs[0]?.signal.aborted).toBe(true);
    pendingAgent.resolve(['late']);
    await agentTurn;
    expect(components.playback.calls).not.toContain('play');

    const pendingSynthesis =
      deferred<readonly { data: Uint8Array; format: string }[]>();
    let synthesisSignal: AbortSignal | undefined;
    vi.spyOn(components.synthesis, 'synthesize').mockImplementation(
      async function* (input) {
        synthesisSignal = input.signal;
        yield* await pendingSynthesis.promise;
      },
    );
    const synthesisTurn = adapter.sendText?.({ text: 'synthesis' });
    await drainUntil(() => synthesisSignal !== undefined);
    await adapter.interrupt?.();
    expect(synthesisSignal?.aborted).toBe(true);
    pendingSynthesis.resolve([
      { data: new Uint8Array([9]), format: 'audio/pcm' },
    ]);
    await synthesisTurn;
    expect(components.playback.calls).not.toContain('play');
  });

  it('sends bounded response chunks to synthesis in order', async () => {
    const components = createTestingVoiceComponents({
      tokens: ['one two three four'],
    });
    const adapter = new ComposedVoiceSessionAdapter({
      ...components,
      synthesisChunkLength: 8,
    });
    await adapter.start();
    await adapter.sendText?.({ text: 'chunk' });
    expect(components.synthesis.inputs.map((input) => input.text)).toEqual([
      'one two',
      'three',
      'four',
    ]);
  });

  it('keeps a selected synthesis secondary for the rest of the session', async () => {
    const components = createTestingVoiceComponents({
      tokens: ['one two three four'],
    });
    const secondary = createTestingVoiceComponents().synthesis;
    const primary = {
      descriptor: { id: 'synthesis-primary', name: 'Synthesis primary' },
      synthesize: vi.fn(async function* () {
        yield await Promise.reject(new Error('primary synthesis failed'));
      }),
    };
    const adapter = new ComposedVoiceSessionAdapter({
      ...components,
      synthesis: { primary, secondary },
      synthesisChunkLength: 8,
    });
    await adapter.start();
    await adapter.sendText?.({ text: 'chunk' });

    expect(primary.synthesize).toHaveBeenCalledTimes(1);
    expect(secondary.inputs.map((input) => input.text)).toEqual([
      'one two',
      'three',
      'four',
    ]);
  });

  it('aborts the session input signal on stop and resets endpoint epochs on restart', async () => {
    const components = createTestingVoiceComponents({ tokens: ['ok'] });
    const adapter = new ComposedVoiceSessionAdapter(components);
    await adapter.start();
    const firstInputSignal = components.input.startSignals[0]!;
    components.input.emit({ type: 'final', epoch: 1, transcript: 'first' });
    await components.settle();
    await adapter.stop();
    expect(firstInputSignal.aborted).toBe(true);

    await adapter.start();
    components.input.emit({ type: 'final', epoch: 1, transcript: 'restart' });
    await components.settle();
    expect(components.agent.inputs.map((input) => input.text)).toEqual([
      'first',
      'restart',
    ]);
  });

  it('keeps exhausted playback failure separate from synthesis secondary', async () => {
    const components = createTestingVoiceComponents({ tokens: ['audio'] });
    const synthesisSecondary = createTestingVoiceComponents().synthesis;
    const telemetry = vi.fn();
    const adapter = new ComposedVoiceSessionAdapter({
      ...components,
      synthesis: {
        primary: components.synthesis,
        secondary: synthesisSecondary,
      },
      playback: {
        primary: {
          descriptor: { id: 'playback-primary', name: 'Playback primary' },
          play: async () => {
            throw new Error('primary playback failed');
          },
          stop: async () => undefined,
        },
        secondary: {
          descriptor: { id: 'playback-secondary', name: 'Playback secondary' },
          play: async () => {
            throw new Error('secondary playback failed');
          },
          stop: async () => undefined,
        },
      },
      telemetry,
    });
    await adapter.start();
    await expect(
      adapter.sendText?.({ text: 'playback' }),
    ).resolves.toMatchObject({
      ok: false,
    });

    expect(
      telemetry.mock.calls
        .map(([event]) => event)
        .filter((event) => event.type === 'secondary')
        .map((event) => event.attributes.role),
    ).toEqual(['playback']);
    expect(synthesisSecondary.inputs).toEqual([]);
    expect(
      telemetry.mock.calls
        .map(([event]) => event)
        .filter((event) => event.type === 'turn-complete')
        .map((event) => event.attributes.outcome),
    ).toEqual(['failed']);
  });

  it('attributes first audio to the playback secondary that actually accepted it', async () => {
    const components = createTestingVoiceComponents({ tokens: ['audio'] });
    const secondary = createTestingVoiceComponents().playback;
    const telemetry = vi.fn();
    const primary = {
      descriptor: { id: 'playback-primary', name: 'Playback primary' },
      play: vi.fn(async () => {
        throw new Error('primary playback failed');
      }),
      stop: vi.fn(async () => undefined),
    };
    const adapter = new ComposedVoiceSessionAdapter({
      ...components,
      playback: { primary, secondary },
      telemetry,
    });
    await adapter.start();
    await adapter.sendText?.({ text: 'playback' });

    expect(
      telemetry.mock.calls
        .map(([event]) => event)
        .find((event) => event.type === 'first-audio'),
    ).toMatchObject({
      attributes: { playbackComponentId: secondary.descriptor.id },
    });
  });

  it('uses an explicit secondary receipt and emits content-free latency telemetry', async () => {
    const primary = createTestingVoiceComponents({
      agentError: new Error('down'),
    });
    const secondary = createTestingVoiceComponents({ tokens: ['safe'] });
    const telemetry = vi.fn();
    const adapter = new ComposedVoiceSessionAdapter({
      ...primary,
      agent: { primary: primary.agent, secondary: secondary.agent },
      telemetry,
      now: (() => {
        let time = 0;
        return () => ++time;
      })(),
    });
    await adapter.start();
    await adapter.sendText?.({ text: 'secret response content' });

    const events = telemetry.mock.calls.map(([event]) => event);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'first-token',
        'first-audio',
        'turn-complete',
        'secondary',
      ]),
    );
    expect(events.find((event) => event.type === 'secondary')).toMatchObject({
      attributes: {
        role: 'agent',
        failedComponentId: primary.agent.descriptor.id,
        secondaryComponentId: secondary.agent.descriptor.id,
      },
    });
    expect(JSON.stringify(events)).not.toContain('secret response content');
    expect(JSON.stringify(events)).not.toContain('safe');
  });

  it('uses assistant/user snapshot roles and emits one terminal outcome per turn', async () => {
    const components = createTestingVoiceComponents({
      tokens: ['assistant answer'],
    });
    const telemetry = vi.fn();
    const adapter = new ComposedVoiceSessionAdapter({
      ...components,
      telemetry,
    });
    await adapter.start();
    await adapter.sendText?.({ text: 'typed' });
    expect(adapter.getSnapshot().transcriptRole).toBe('assistant');
    expect(
      telemetry.mock.calls
        .map(([event]) => event)
        .filter((event) => event.type === 'turn-complete')
        .map((event) => event.attributes.outcome),
    ).toEqual(['completed']);
    expect(
      telemetry.mock.calls
        .map(([event]) => event)
        .find((event) => event.type === 'transcript-final'),
    ).toMatchObject({ attributes: { inputSource: 'text' } });
  });

  it('attempts both teardown operations, preserves the first fault, and projects it on the snapshot', async () => {
    const components = createTestingVoiceComponents();
    vi.spyOn(components.playback, 'stop').mockRejectedValueOnce(
      new Error('playback stop failed'),
    );
    vi.spyOn(components.input, 'stop').mockRejectedValueOnce(
      new Error('input stop failed'),
    );
    const adapter = new ComposedVoiceSessionAdapter(components);
    await adapter.start();
    await expect(adapter.stop()).resolves.toMatchObject({
      ok: false,
      error: { message: 'playback stop failed' },
    });
    expect(components.input.stop).toHaveBeenCalledTimes(1);
    expect(adapter.getSnapshot()).toMatchObject({
      state: 'error',
      error: { message: 'playback stop failed' },
    });
  });

  it('cancels an active turn before projecting input errors and records interruption once', async () => {
    const pending = deferred<readonly string[]>();
    const components = createTestingVoiceComponents({
      tokenStream: async function* () {
        yield* await pending.promise;
      },
    });
    const telemetry = vi.fn();
    const adapter = new ComposedVoiceSessionAdapter({
      ...components,
      telemetry,
    });
    await adapter.start();
    const turn = adapter.sendText?.({ text: 'pending' });
    await components.settle();
    components.input.emit({
      type: 'error',
      epoch: 1,
      error: new Error('input failed'),
    });
    await components.settle();
    expect(components.agent.inputs[0]?.signal.aborted).toBe(true);
    expect(adapter.getSnapshot()).toMatchObject({
      state: 'error',
      error: { message: 'input failed' },
    });
    expect(
      telemetry.mock.calls
        .map(([event]) => event)
        .filter((event) => event.type === 'turn-complete')
        .map((event) => event.attributes.outcome),
    ).toEqual(['interrupted']);
    await adapter.start();
    expect(components.input.startSignals).toHaveLength(2);
    pending.resolve(['late']);
    await turn;
  });

  it('does not replay a text chunk through synthesis secondary after primary audio was played', async () => {
    const components = createTestingVoiceComponents({
      tokens: ['whole chunk'],
    });
    const secondary = createTestingVoiceComponents().synthesis;
    const primary = {
      descriptor: { id: 'primary-synthesis', name: 'Primary synthesis' },
      async *synthesize() {
        yield { data: new Uint8Array([1]), format: 'audio/pcm' };
        throw new Error('late iterator failure');
      },
    };
    const telemetry = vi.fn();
    const adapter = new ComposedVoiceSessionAdapter({
      ...components,
      synthesis: { primary, secondary },
      telemetry,
    });
    await adapter.start();
    await expect(adapter.sendText?.({ text: 'turn' })).resolves.toMatchObject({
      ok: false,
    });

    expect(components.playback.calls).toEqual(['stop', 'play']);
    expect(secondary.inputs).toEqual([]);
    expect(
      telemetry.mock.calls
        .map(([event]) => event)
        .filter((event) => event.type === 'first-audio'),
    ).toHaveLength(1);
    expect(
      telemetry.mock.calls
        .map(([event]) => event)
        .filter((event) => event.type === 'secondary')
        .map((event) => event.attributes.role),
    ).not.toContain('synthesis');
  });

  it('cleans up every failed input start before retry, including failed secondary startup', async () => {
    const components = createTestingVoiceComponents();
    const signals: AbortSignal[] = [];
    const primary = {
      descriptor: { id: 'failing-primary', name: 'Failing primary' },
      subscribe: components.input.subscribe.bind(components.input),
      start: vi.fn(async (signal: AbortSignal) => {
        signals.push(signal);
        throw new Error('primary start failed');
      }),
      stop: vi.fn(async () => undefined),
    };
    const noSecondary = new ComposedVoiceSessionAdapter({
      ...components,
      input: primary,
    });
    await expect(noSecondary.start()).resolves.toMatchObject({ ok: false });
    await expect(noSecondary.start()).resolves.toMatchObject({ ok: false });
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(primary.stop).toHaveBeenCalledTimes(2);

    const secondary = {
      descriptor: { id: 'failing-secondary', name: 'Failing secondary' },
      subscribe: components.input.subscribe.bind(components.input),
      start: vi.fn(async () => {
        throw new Error('secondary start failed');
      }),
      stop: vi.fn(async () => undefined),
    };
    const withSecondary = new ComposedVoiceSessionAdapter({
      ...components,
      input: { primary, secondary },
    });
    await expect(withSecondary.start()).resolves.toMatchObject({ ok: false });
    expect(secondary.stop).toHaveBeenCalledTimes(1);
  });

  it('isolates telemetry sink failures and measures speech milestones from epoch start', async () => {
    let clock = 0;
    const token = deferred<void>();
    const components = createTestingVoiceComponents();
    vi.spyOn(components.agent, 'run').mockImplementation(async function* () {
      await token.promise;
      yield 'answer';
    });
    const events: unknown[] = [];
    const adapter = new ComposedVoiceSessionAdapter({
      ...components,
      now: () => clock,
      telemetry: (event) => {
        events.push(event);
        if (event.type === 'secondary')
          throw new Error('telemetry sink failed');
      },
    });
    await adapter.start();
    clock = 100;
    components.input.emit({ type: 'interim', epoch: 7, transcript: 'he' });
    clock = 350;
    components.input.emit({ type: 'final', epoch: 7, transcript: 'hello' });
    await components.settle();
    clock = 400;
    token.resolve();
    await drainUntil(() => adapter.getSnapshot().state === 'connected-idle');
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'transcript-final', durationMs: 250 }),
        expect.objectContaining({ type: 'first-token', durationMs: 50 }),
        expect.objectContaining({ type: 'first-audio', durationMs: 50 }),
        expect.objectContaining({ type: 'turn-complete', durationMs: 300 }),
      ]),
    );

    const primary = createTestingVoiceComponents({
      agentError: new Error('down'),
    });
    const secondary = createTestingVoiceComponents({ tokens: ['safe'] });
    const sinkThrowingOnSecondary = new ComposedVoiceSessionAdapter({
      ...primary,
      agent: { primary: primary.agent, secondary: secondary.agent },
      telemetry: (event) => {
        if (event.type === 'secondary') throw new Error('sink down');
      },
    });
    await sinkThrowingOnSecondary.start();
    await expect(
      sinkThrowingOnSecondary.sendText?.({ text: 'turn' }),
    ).resolves.toMatchObject({ ok: true });
    expect(secondary.agent.inputs).toHaveLength(1);
  });

  it('disposes the coordinator input subscription exactly once', async () => {
    const components = createTestingVoiceComponents();
    const unsubscribe = vi.fn();
    const input = {
      descriptor: components.input.descriptor,
      subscribe: vi.fn(() => unsubscribe),
      start: components.input.start.bind(components.input),
      stop: components.input.stop.bind(components.input),
    };
    const adapter = new ComposedVoiceSessionAdapter({ ...components, input });
    await adapter.dispose?.();
    await adapter.dispose?.();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('disposes every configured input exactly once, including an inactive secondary', async () => {
    const components = createTestingVoiceComponents();
    const primaryDispose = vi.fn();
    const secondaryDispose = vi.fn();
    const primary = {
      ...components.input,
      descriptor: { id: 'primary', name: 'Primary' },
      subscribe: components.input.subscribe.bind(components.input),
      start: components.input.start.bind(components.input),
      stop: components.input.stop.bind(components.input),
      dispose: primaryDispose,
    };
    const secondary = {
      ...components.input,
      descriptor: { id: 'secondary', name: 'Secondary' },
      subscribe: components.input.subscribe.bind(components.input),
      start: components.input.start.bind(components.input),
      stop: components.input.stop.bind(components.input),
      dispose: secondaryDispose,
    };
    const adapter = new ComposedVoiceSessionAdapter({
      ...components,
      input: { primary, secondary },
    });

    await adapter.dispose?.();
    await adapter.dispose?.();

    expect(primaryDispose).toHaveBeenCalledTimes(1);
    expect(secondaryDispose).toHaveBeenCalledTimes(1);
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
