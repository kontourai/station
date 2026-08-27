import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RealtimeVoiceSessionAdapter,
  type VoiceRealtimeConnection,
  type VoiceRealtimeEvent,
  type VoiceRealtimeProvider,
} from '@kontourai/station-sdk/voice';
import WebSocket from 'ws';
import { OpenAIRealtimeProvider } from '../examples/openai-realtime-voice/src/OpenAIRealtimeProvider.js';

const OPENAI_REALTIME_URL =
  'wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1';
const TIMEOUT_MS = 20_000;
type SmokeStage =
  | 'credential'
  | 'start'
  | 'text'
  | 'interrupt'
  | 'synthesize'
  | 'speech'
  | 'stop'
  | 'receipt';
let smokeStage: SmokeStage = 'credential';

function credential(): string | undefined {
  const direct = process.env.OPENAI_API_KEY?.trim();
  if (direct) return direct;
  const path = process.env.OPENAI_API_KEY_FILE;
  if (!path) return undefined;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) return undefined;
    return readFileSync(path, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

function within<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Timed out')),
      TIMEOUT_MS,
    );
    void promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

interface SmokeReceipt {
  audioResponseSpeechBytes: number;
}

class OpenAIRealtimeConnection implements VoiceRealtimeConnection {
  private readonly events = new EventEmitter();
  private socket: WebSocket | undefined;
  private closed = false;
  private responseWaiter:
    | {
        readonly event:
          | 'response.created'
          | 'response.done'
          | 'response.output_audio.delta'
          | 'session.updated';
        readonly responseId?: string;
        readonly status?: 'cancelled' | 'completed';
        resolve(responseId?: string): void;
        reject(error: Error): void;
      }
    | undefined;
  private activeResponseId: string | undefined;
  private audioResponseId: string | undefined;

  constructor(
    private readonly apiKey: string,
    private readonly receipt: SmokeReceipt,
  ) {}

  async connect(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('Aborted');
    try {
      await within(
        new Promise<void>((resolve, reject) => {
          const socket = new WebSocket(OPENAI_REALTIME_URL, {
            headers: { Authorization: `Bearer ${this.apiKey}` },
            handshakeTimeout: TIMEOUT_MS,
          });
          this.socket = socket;
          const abort = () => {
            socket.terminate();
            reject(new Error('Aborted'));
          };
          signal?.addEventListener('abort', abort, { once: true });
          socket.once('open', () => {
            signal?.removeEventListener('abort', abort);
            resolve();
          });
          socket.once('error', () =>
            reject(new Error('Realtime connection failed')),
          );
          socket.on('message', (raw) => this.onMessage(raw.toString()));
          socket.on('close', () => {
            if (!this.closed) this.events.emit('event', { type: 'disconnect' });
          });
        }),
      );
      const configured = this.waitFor('session.updated');
      this.send({
        type: 'session.update',
        session: {
          type: 'realtime',
          audio: { input: { turn_detection: null } },
        },
      });
      await configured;
    } catch (error) {
      this.closed = true;
      this.socket?.terminate();
      this.socket = undefined;
      throw error;
    }
  }

  subscribe(listener: (event: VoiceRealtimeEvent) => void): () => void {
    this.events.on('event', listener);
    return () => this.events.off('event', listener);
  }

  async sendText(input: { readonly text: string }): Promise<void> {
    const created = this.waitFor('response.created');
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: input.text }],
      },
    });
    this.send({ type: 'response.create' });
    this.activeResponseId = await created;
    await this.waitFor('response.output_audio.delta', this.activeResponseId);
  }

  async sendAudio(audio: Uint8Array): Promise<void> {
    const created = this.waitFor('response.created');
    this.send({
      type: 'input_audio_buffer.append',
      audio: Buffer.from(audio).toString('base64'),
    });
    this.send({ type: 'input_audio_buffer.commit' });
    this.send({ type: 'response.create' });
    this.audioResponseId = await created;
    this.receipt.audioResponseSpeechBytes = 0;
    await this.waitFor('response.done', this.audioResponseId, 'completed');
  }

  async updateContext(input: Readonly<Record<string, unknown>>): Promise<void> {
    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: JSON.stringify(input),
      },
    });
  }

  async interrupt(): Promise<void> {
    if (!this.activeResponseId)
      throw new Error('No active response to interrupt');
    const completed = this.waitFor(
      'response.done',
      this.activeResponseId,
      'cancelled',
    );
    this.send({ type: 'response.cancel', response_id: this.activeResponseId });
    await completed;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) return;
    await within(
      new Promise<void>((resolve) => {
        socket.once('close', () => resolve());
        socket.close();
      }),
    ).catch(() => socket.terminate());
  }

  private send(event: object): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Realtime connection is unavailable');
    }
    this.socket.send(JSON.stringify(event));
  }

  private waitFor(
    event:
      | 'response.created'
      | 'response.done'
      | 'response.output_audio.delta'
      | 'session.updated',
    responseId?: string,
    status?: 'cancelled' | 'completed',
  ): Promise<string | undefined> {
    return within(
      new Promise<string | undefined>((resolve, reject) => {
        this.responseWaiter = { event, responseId, status, resolve, reject };
      }),
    );
  }

  private onMessage(raw: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = typeof event.type === 'string' ? event.type : '';
    const responseId = responseIdFrom(event);
    const responseStatus = responseStatusFrom(event);
    if (
      this.responseWaiter?.event === type &&
      (!this.responseWaiter.responseId ||
        this.responseWaiter.responseId === responseId) &&
      (!this.responseWaiter.status ||
        this.responseWaiter.status === responseStatus)
    ) {
      const waiter = this.responseWaiter;
      this.responseWaiter = undefined;
      waiter.resolve(responseId);
    }
    if (
      type === 'response.output_audio.delta' &&
      typeof event.delta === 'string'
    ) {
      const audio = new Uint8Array(Buffer.from(event.delta, 'base64'));
      if (responseId && responseId === this.audioResponseId) {
        this.receipt.audioResponseSpeechBytes += audio.byteLength;
      }
      this.events.emit('event', { type: 'speech', audio });
    } else if (
      type === 'response.output_audio_transcript.delta' &&
      typeof event.delta === 'string'
    ) {
      this.events.emit('event', {
        type: 'transcript',
        text: event.delta,
        role: 'assistant',
      });
    } else if (type === 'error') {
      const waiter = this.responseWaiter;
      this.responseWaiter = undefined;
      waiter?.reject(new Error('Realtime provider operation failed'));
      this.events.emit('event', { type: 'error', code: 'unavailable' });
    }
  }
}

function responseIdFrom(event: Record<string, unknown>): string | undefined {
  if (typeof event.response_id === 'string') return event.response_id;
  if (event.response && typeof event.response === 'object') {
    const id = (event.response as { id?: unknown }).id;
    return typeof id === 'string' ? id : undefined;
  }
  return undefined;
}

function responseStatusFrom(
  event: Record<string, unknown>,
): 'cancelled' | 'completed' | undefined {
  if (!event.response || typeof event.response !== 'object') return undefined;
  const status = (event.response as { status?: unknown }).status;
  return status === 'cancelled' || status === 'completed' ? status : undefined;
}

function provider(
  apiKey: string,
  receipt: SmokeReceipt,
): VoiceRealtimeProvider {
  return new OpenAIRealtimeProvider({
    readiness: async () => ({ status: 'ready' }),
    mint: async () => ({ endpoint: OPENAI_REALTIME_URL }),
    open: async (endpoint, signal) => {
      if (endpoint !== OPENAI_REALTIME_URL)
        throw new Error('Realtime endpoint is not allowed');
      const connection = new OpenAIRealtimeConnection(apiKey, receipt);
      await connection.connect(signal);
      return connection;
    },
  });
}

function synthesize(): Uint8Array {
  const pcmFile = process.env.VOICE_REALTIME_PCM_FILE;
  if (pcmFile) {
    const stat = statSync(pcmFile);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0)
      throw new Error('Protected PCM input unavailable');
    return new Uint8Array(readFileSync(pcmFile));
  }
  if (process.platform !== 'darwin')
    throw new Error('A protected PCM input is required on this platform');
  const directory = mkdtempSync(join(tmpdir(), 'station-realtime-speech-'));
  const wavePath = join(directory, 'turn.wav');
  try {
    execFileSync(
      '/usr/bin/say',
      [
        '-o',
        wavePath,
        '--file-format=WAVE',
        '--data-format=LEI16@24000',
        'Station realtime smoke speech turn.',
      ],
      { stdio: 'ignore', timeout: TIMEOUT_MS, windowsHide: true },
    );
    return pcmDataFromWave(readFileSync(wavePath));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function pcmDataFromWave(wave: Buffer): Uint8Array {
  if (
    wave.byteLength < 12 ||
    wave.toString('ascii', 0, 4) !== 'RIFF' ||
    wave.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('Local speech did not produce a WAVE file');
  }
  let offset = 12;
  while (offset + 8 <= wave.byteLength) {
    const type = wave.toString('ascii', offset, offset + 4);
    const length = wave.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > wave.byteLength) break;
    if (type === 'data' && length > 0)
      return new Uint8Array(wave.subarray(start, end));
    offset = end + (length % 2);
  }
  throw new Error('Local speech WAVE data was unavailable');
}

async function main(): Promise<void> {
  const apiKey = credential();
  if (!apiKey) throw new Error('Credential unavailable');
  const receipt: SmokeReceipt = { audioResponseSpeechBytes: 0 };
  const adapter = new RealtimeVoiceSessionAdapter(provider(apiKey, receipt));
  try {
    smokeStage = 'start';
    const start = await within(adapter.start());
    if (!start.ok) throw new Error('Start failed');
    smokeStage = 'text';
    const text = await within(
      adapter.sendText({
        text: 'Count slowly from one to one hundred, pausing between numbers.',
      }),
    );
    if (!text.ok) throw new Error('Text turn failed');
    smokeStage = 'interrupt';
    const interrupt = await within(adapter.interrupt());
    if (!interrupt.ok) throw new Error('Interrupt failed');
    smokeStage = 'synthesize';
    const audio = synthesize();
    smokeStage = 'speech';
    const speech = await within(adapter.sendAudio({ audio }));
    if (!speech.ok) throw new Error('Speech turn failed');
    smokeStage = 'stop';
    const stop = await within(adapter.stop());
    if (!stop.ok) throw new Error('Stop failed');
    smokeStage = 'receipt';
    if (receipt.audioResponseSpeechBytes === 0)
      throw new Error('Speech receipt failed');
    console.log('OPENAI_REALTIME_START_TEXT_SPEECH_INTERRUPT_STOP_COMPLETE');
  } finally {
    await within(adapter.stop()).catch(() => undefined);
  }
}

main().catch(() => {
  console.error(`FAIL_STAGE:${smokeStage}`);
  process.exitCode = 1;
});
