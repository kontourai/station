import { EventEmitter } from 'node:events';
import { runVoiceRealtimeConformance } from '@kontourai/station-sdk/testing';
import { describe, expect, it } from 'vitest';
import { createS2SRealtimeProvider } from '../realtime/s2s-realtime-provider.js';
import type {
  IS2SProvider,
  S2SAudioFormat,
  S2SSessionConfig,
} from '../s2s-types.js';

const FORMAT: S2SAudioFormat = {
  mediaType: 'audio/pcm',
  sampleRateHertz: 16_000,
  sampleSizeBits: 16,
  channelCount: 1,
  encoding: 'raw',
};
const CONFIG: S2SSessionConfig = { systemPrompt: 'test', tools: [] };

class FakeS2SProvider extends EventEmitter implements IS2SProvider {
  state = 'disconnected' as const;
  outputAudioFormat = FORMAT;
  readonly sentAudio: Buffer[] = [];
  disconnected = 0;

  async connect(): Promise<S2SAudioFormat> {
    return FORMAT;
  }
  sendAudio(chunk: Buffer): void {
    this.sentAudio.push(chunk);
  }
  sendToolResult(): void {}
  async disconnect(): Promise<void> {
    this.disconnected += 1;
  }
}

describe('S2S realtime provider bridge', () => {
  it('passes common conformance and maps audio input without an AWS import', async () => {
    const fake = new FakeS2SProvider();
    const provider = createS2SRealtimeProvider(
      () => fake,
      CONFIG,
      async () => ({ status: 'ready' }),
    );
    const report = await runVoiceRealtimeConformance({
      provider,
      requiredEvents: ['speech', 'transcript'],
      exercise: () => {
        fake.emit('audio', Buffer.from([1]));
        fake.emit('transcript', {
          text: 'conformance',
          role: 'assistant',
          stage: 'final',
        });
      },
    });

    expect(report.ok).toBe(true);
    expect(fake.sentAudio).toHaveLength(1);
    expect(fake.disconnected).toBe(1);
  });

  it('is unconfigured without a caller-owned provider readiness probe', async () => {
    const provider = createS2SRealtimeProvider(
      () => new FakeS2SProvider(),
      CONFIG,
    );

    await expect(provider.readiness()).resolves.toEqual({
      status: 'unconfigured',
      reason: 'missing-configuration',
    });
  });

  it('detaches provider listeners on close so late events are suppressed', async () => {
    const fake = new FakeS2SProvider();
    const provider = createS2SRealtimeProvider(() => fake, CONFIG);
    const connection = await (await provider.mint()).open();
    const events: string[] = [];
    connection.subscribe((event) => events.push(event.type));

    fake.emit('transcript', {
      text: 'before close',
      role: 'assistant',
      stage: 'final',
    });
    await connection.close();
    fake.emit('transcript', {
      text: 'after close',
      role: 'assistant',
      stage: 'final',
    });

    expect(events).toEqual(['transcript']);
    expect(fake.disconnected).toBe(1);
  });

  it('retries provider disconnect after a failed close without restoring listeners', async () => {
    const fake = new FakeS2SProvider();
    fake.disconnect = async () => {
      fake.disconnected += 1;
      if (fake.disconnected === 1) throw new Error('Bearer disconnect-secret');
    };
    const provider = createS2SRealtimeProvider(() => fake, CONFIG);
    const connection = await (await provider.mint()).open();
    const events: string[] = [];
    connection.subscribe((event) => events.push(event.type));

    await expect(connection.close()).rejects.toThrow('disconnect-secret');
    fake.emit('audio', Buffer.from([1]));
    await expect(connection.close()).resolves.toBeUndefined();

    expect(fake.disconnected).toBe(2);
    expect(events).toEqual([]);
  });
});
