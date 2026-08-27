import { describe, expect, it } from 'vitest';
import {
  createFakeVoiceRealtimeProvider,
  runVoiceRealtimeConformance,
} from '../voice/realtime-testing.js';

describe('Voice realtime fake conformance', () => {
  it('covers the common safe realtime operations', async () => {
    const provider = createFakeVoiceRealtimeProvider({
      descriptor: { id: 'fake-realtime', name: 'Fake realtime' },
    });

    const report = await runVoiceRealtimeConformance({
      provider,
      requiredEvents: ['speech', 'transcript', 'usage', 'disconnect'],
      exercise: (connection) => {
        const emitter = connection as typeof connection & {
          emit(
            event: import('../voice/realtime-types.js').VoiceRealtimeEvent,
          ): void;
        };
        emitter.emit({ type: 'speech', audio: new Uint8Array([1]) });
        emitter.emit({
          type: 'transcript',
          text: 'conformance',
          role: 'assistant',
        });
        emitter.emit({ type: 'usage', inputAudioMs: 1 });
        emitter.emit({ type: 'disconnect' });
      },
    });

    expect(report.ok).toBe(true);
    expect(report.operations).toEqual([
      'open',
      'send-text',
      'send-audio',
      'update-context',
      'interrupt',
      'close',
    ]);
    expect(report.events).toEqual(
      expect.arrayContaining(['speech', 'transcript', 'usage', 'disconnect']),
    );
    expect(JSON.stringify(report)).not.toMatch(/token|key|signed|url/i);
  });

  it('fails closed when declared capabilities and connection methods differ', async () => {
    const provider = createFakeVoiceRealtimeProvider();
    const report = await runVoiceRealtimeConformance({
      provider: {
        descriptor: provider.descriptor,
        capabilities: { ...provider.capabilities, textTurn: false },
        readiness: provider.readiness.bind(provider),
        mint: provider.mint.bind(provider),
      },
      requiredEvents: ['speech'],
      exercise: () => undefined,
    });

    expect(report.ok).toBe(false);
    expect(report.violations).toContain(
      'send-text capability and connection method must be declared together',
    );
    expect(report.violations).toContain(
      'required speech event was not observed',
    );
  });

  it('always closes the connection when a conformance operation throws', async () => {
    let closeCount = 0;
    const report = await runVoiceRealtimeConformance({
      provider: {
        descriptor: { id: 'throwing', name: 'Throwing' },
        capabilities: { textTurn: true },
        readiness: async () => ({ status: 'ready' }),
        mint: async () => ({
          providerId: 'throwing',
          open: async () => ({
            subscribe: () => () => undefined,
            sendText: async () => {
              throw new Error('Bearer conformance-secret');
            },
            close: async () => {
              closeCount += 1;
            },
          }),
        }),
      },
      requiredEvents: [],
      exercise: () => undefined,
    });

    expect(report.ok).toBe(false);
    expect(report.violations).toContain('send-text operation failed');
    expect(closeCount).toBe(1);
    expect(JSON.stringify(report)).not.toContain('conformance-secret');
  });

  it('returns a sanitized report and closes when subscription throws', async () => {
    let closeCount = 0;
    const report = await runVoiceRealtimeConformance({
      provider: {
        descriptor: { id: 'subscribe-throws', name: 'Subscribe throws' },
        capabilities: {},
        readiness: async () => ({ status: 'ready' }),
        mint: async () => ({
          providerId: 'subscribe-throws',
          open: async () => ({
            subscribe: () => {
              throw new Error('Bearer subscribe-secret');
            },
            close: async () => {
              closeCount += 1;
            },
          }),
        }),
      },
      requiredEvents: [],
      exercise: () => undefined,
    });

    expect(report.ok).toBe(false);
    expect(report.violations).toContain('connection subscription failed');
    expect(closeCount).toBe(1);
    expect(JSON.stringify(report)).not.toContain('subscribe-secret');
  });

  it('records a throwing unsubscriber and still closes content-free', async () => {
    let closeCount = 0;
    const report = await runVoiceRealtimeConformance({
      provider: {
        descriptor: { id: 'unsubscribe-throws', name: 'Unsubscribe throws' },
        capabilities: {},
        readiness: async () => ({ status: 'ready' }),
        mint: async () => ({
          providerId: 'unsubscribe-throws',
          open: async () => ({
            subscribe: () => () => {
              throw new Error('Bearer unsubscribe-secret');
            },
            close: async () => {
              closeCount += 1;
            },
          }),
        }),
      },
      requiredEvents: [],
      exercise: () => undefined,
    });

    expect(report.ok).toBe(false);
    expect(report.violations).toContain('connection unsubscribe failed');
    expect(closeCount).toBe(1);
    expect(JSON.stringify(report)).not.toContain('unsubscribe-secret');
  });
});
