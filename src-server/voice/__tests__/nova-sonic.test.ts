import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NovaSonicProvider } from '../providers/nova-sonic.js';
import type { S2SToolUseEvent, S2STranscript } from '../s2s-types.js';

function rawEvent(event: any) {
  return {
    chunk: { bytes: new TextEncoder().encode(JSON.stringify({ event })) },
  };
}

function createMockBody() {
  const events: any[] = [];
  let resolve: (() => void) | null = null;

  return {
    push(event: any) {
      events.push(event);
      resolve?.();
    },
    done() {
      events.push(null);
      resolve?.();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (events.length > 0) {
          const e = events.shift();
          if (e === null) return;
          yield e;
        }
        await new Promise<void>((r) => {
          resolve = r;
        });
      }
    },
  };
}

describe('NovaSonicProvider', () => {
  let provider: NovaSonicProvider;
  let mockBody: ReturnType<typeof createMockBody>;

  beforeEach(() => {
    provider = new NovaSonicProvider({ region: 'us-east-1' });
    mockBody = createMockBody();
    (provider as any).client = {
      send: vi.fn().mockResolvedValue({ body: mockBody }),
    };
  });

  test('connect sends setup events and returns input audio format', async () => {
    const format = await provider.connect({
      systemPrompt: 'You are a test assistant.',
      tools: [
        {
          name: 'test_tool',
          description: 'A test',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });

    expect(format.sampleRateHertz).toBe(16000);
    expect(format.encoding).toBe('base64');
    expect(provider.state).toBe('listening');
    expect(provider.outputAudioFormat.sampleRateHertz).toBe(24000);
  });

  test('emits transcript for USER ASR (FINAL)', async () => {
    await provider.connect({ systemPrompt: 'test', tools: [] });

    const transcripts: S2STranscript[] = [];
    provider.on('transcript', (t) => transcripts.push(t));

    mockBody.push(
      rawEvent({
        completionStart: {
          sessionId: 's1',
          promptName: 'p1',
          completionId: 'c1',
        },
      }),
    );
    mockBody.push(
      rawEvent({
        contentStart: {
          role: 'USER',
          type: 'TEXT',
          additionalModelFields: '{"generationStage":"FINAL"}',
        },
      }),
    );
    mockBody.push(rawEvent({ textOutput: { content: 'Hello world' } }));
    mockBody.push(rawEvent({ contentEnd: {} }));

    await new Promise((r) => setTimeout(r, 50));

    expect(transcripts).toContainEqual({
      text: 'Hello world',
      role: 'user',
      stage: 'final',
    });
  });

  test('emits transcript for ASSISTANT SPECULATIVE', async () => {
    await provider.connect({ systemPrompt: 'test', tools: [] });

    const transcripts: S2STranscript[] = [];
    provider.on('transcript', (t) => transcripts.push(t));

    mockBody.push(
      rawEvent({
        contentStart: {
          role: 'ASSISTANT',
          type: 'TEXT',
          additionalModelFields: '{"generationStage":"SPECULATIVE"}',
        },
      }),
    );
    mockBody.push(rawEvent({ textOutput: { content: 'Let me check' } }));

    await new Promise((r) => setTimeout(r, 50));

    expect(transcripts).toContainEqual({
      text: 'Let me check',
      role: 'assistant',
      stage: 'speculative',
    });
  });

  test('emits audio event from audioOutput', async () => {
    await provider.connect({ systemPrompt: 'test', tools: [] });

    const audioChunks: Buffer[] = [];
    provider.on('audio', (chunk) => audioChunks.push(chunk));

    const testData = Buffer.from('test-audio').toString('base64');
    mockBody.push(
      rawEvent({ contentStart: { type: 'AUDIO', role: 'ASSISTANT' } }),
    );
    mockBody.push(rawEvent({ audioOutput: { content: testData } }));

    await new Promise((r) => setTimeout(r, 50));

    expect(audioChunks.length).toBe(1);
    expect(audioChunks[0].toString()).toBe('test-audio');
  });

  test('emits toolUse event and accepts toolResult', async () => {
    await provider.connect({
      systemPrompt: 'test',
      tools: [
        {
          name: 'get_weather',
          description: 'Get weather',
          inputSchema: {
            type: 'object',
            properties: { city: { type: 'string' } },
          },
        },
      ],
    });

    const toolUses: S2SToolUseEvent[] = [];
    provider.on('toolUse', (e) => toolUses.push(e));

    mockBody.push(rawEvent({ contentStart: { type: 'TOOL', role: 'TOOL' } }));
    mockBody.push(
      rawEvent({
        toolUse: {
          toolName: 'get_weather',
          toolUseId: 'tu-123',
          content: '{"city":"Seattle"}',
        },
      }),
    );
    mockBody.push(
      rawEvent({ contentEnd: { stopReason: 'TOOL_USE', type: 'TOOL' } }),
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(toolUses).toHaveLength(1);
    expect(toolUses[0]).toEqual({
      toolName: 'get_weather',
      toolUseId: 'tu-123',
      parameters: { city: 'Seattle' },
    });

    provider.sendToolResult('tu-123', '{"temp": 72}');
  });

  test('emits stateChange through lifecycle', async () => {
    const states: string[] = [];
    provider.on('stateChange', (s) => states.push(s));

    await provider.connect({ systemPrompt: 'test', tools: [] });
    expect(states).toContain('connecting');
    expect(states).toContain('listening');

    mockBody.push(rawEvent({ completionStart: {} }));
    await new Promise((r) => setTimeout(r, 50));
    expect(states).toContain('processing');

    mockBody.push(
      rawEvent({ contentStart: { type: 'AUDIO', role: 'ASSISTANT' } }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(states).toContain('speaking');

    mockBody.push(rawEvent({ completionEnd: {} }));
    await new Promise((r) => setTimeout(r, 50));
    expect(
      states.filter((s) => s === 'listening').length,
    ).toBeGreaterThanOrEqual(2);
  });

  test('disconnect sets state to disconnected', async () => {
    await provider.connect({ systemPrompt: 'test', tools: [] });
    await provider.disconnect();
    expect(provider.state).toBe('disconnected');
  });

  test('a reentrant disconnect from connecting cannot reactivate Nova', async () => {
    const states: string[] = [];
    provider.on('stateChange', (state) => {
      states.push(state);
      if (state === 'connecting') void provider.disconnect();
    });

    await provider.connect({ systemPrompt: 'test', tools: [] });

    expect(states).toContain('connecting');
    expect(states).not.toContain('listening');
    expect(provider.state).toBe('disconnected');
    expect((provider as any).active).toBe(false);
    expect((provider as any).client.send).not.toHaveBeenCalled();
  });

  test('sendAudio does not throw when active', async () => {
    await provider.connect({ systemPrompt: 'test', tools: [] });
    expect(() => provider.sendAudio(Buffer.from('audio-data'))).not.toThrow();
  });

  test('sendAudio is no-op after disconnect', async () => {
    await provider.connect({ systemPrompt: 'test', tools: [] });
    await provider.disconnect();
    expect(() => provider.sendAudio(Buffer.from('audio-data'))).not.toThrow();
  });
});
