import { describe, expect, it } from 'vitest';
import type {
  VoiceAgentTurnAdapter,
  VoiceAudioChunk,
  VoiceInputAdapter,
  VoiceInputEvent,
  VoicePlaybackAdapter,
  VoiceSynthesisAdapter,
  VoiceTurnTelemetryEvent,
} from '../voice/component-types.js';

describe('voice component contracts', () => {
  it('keeps component descriptors, input events, and telemetry content-free', () => {
    const event: VoiceInputEvent = Object.freeze({
      type: 'final',
      epoch: 3,
      transcript: 'a transcript belongs to the component event, not telemetry',
    });
    const telemetry: VoiceTurnTelemetryEvent = Object.freeze({
      type: 'secondary',
      durationMs: 12,
      attributes: Object.freeze({
        role: 'agent',
        failedComponentId: 'primary',
        secondaryComponentId: 'secondary',
        reasonCode: 'operation-failed',
      }),
    });

    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(telemetry)).toBe(true);
    expect(JSON.stringify(telemetry)).not.toContain('transcript');
    expect(JSON.stringify(telemetry)).not.toContain('audio');
  });

  it('makes every replaceable role abort-aware', async () => {
    const controller = new AbortController();
    const input: VoiceInputAdapter = {
      descriptor: { id: 'input', name: 'Input' },
      subscribe: () => () => {},
      start: async (signal) => expect(signal).toBe(controller.signal),
      stop: async (signal) => expect(signal).toBe(controller.signal),
    };
    const agent: VoiceAgentTurnAdapter = {
      descriptor: { id: 'agent', name: 'Agent' },
      async *run(input) {
        expect(input.signal).toBe(controller.signal);
        yield 'hello';
      },
    };
    const synthesis: VoiceSynthesisAdapter = {
      descriptor: { id: 'synthesis', name: 'Synthesis' },
      async *synthesize(input) {
        expect(input.signal).toBe(controller.signal);
        yield { data: new Uint8Array([1]), format: 'audio/pcm' };
      },
    };
    const playback: VoicePlaybackAdapter = {
      descriptor: { id: 'playback', name: 'Playback' },
      play: async (_chunk: VoiceAudioChunk, signal) =>
        expect(signal).toBe(controller.signal),
      stop: async (signal) => expect(signal).toBe(controller.signal),
    };

    await input.start(controller.signal);
    await input.stop(controller.signal);
    for await (const _token of agent.run({
      text: 'hi',
      context: Object.freeze({}),
      signal: controller.signal,
    })) {
    }
    for await (const chunk of synthesis.synthesize({
      text: 'hi',
      signal: controller.signal,
    }))
      await playback.play(chunk, controller.signal);
    await playback.stop(controller.signal);
  });
});
