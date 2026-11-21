import {
  setClientCredentialResolver,
  voiceRegistry,
} from '@kontourai/station-sdk';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { activate } from '../index';

const station = 'https://station.test';
const stationCredential = 'fixture-station-credential';
const vendorKey = 'fixture-server-key';
const token = 'fixture-token';
const mocks = vi.hoisted(() => ({
  stopTrack: vi.fn(),
}));

class Socket {
  static OPEN = 1;
  static opened: Socket[] = [];
  readyState = Socket.OPEN;
  sent: unknown[] = [];
  onmessage?: (event: { data: string }) => void | Promise<void>;
  onopen?: () => void;
  onclose?: () => void;
  constructor(readonly url: string) {
    Socket.opened.push(this);
  }
  send(frame: string) {
    this.sent.push(JSON.parse(frame));
  }
  close = vi.fn(() => this.onclose?.());
  async message(value: unknown) {
    await this.onmessage?.({ data: JSON.stringify(value) });
  }
}

class Audio {
  static instances: Audio[] = [];
  sampleRate = 16_000;
  destination = {};
  readonly processor = {
    connect: vi.fn(),
    onaudioprocess: null as
      | null
      | ((event: { inputBuffer: { getChannelData(): Float32Array } }) => void),
  };
  readonly source = {
    buffer: null,
    connect: vi.fn(),
    onended: null as null | (() => void),
    start: vi.fn(),
  };
  readonly decodeAudioData = vi.fn(async (_bytes: ArrayBuffer) => ({}));
  readonly close = vi.fn(async () => {});
  constructor() {
    Audio.instances.push(this);
  }
  createMediaStreamSource() {
    return { connect: vi.fn() };
  }
  createScriptProcessor() {
    return this.processor;
  }
  createBufferSource() {
    return this.source;
  }
}

let dispose: (() => void) | undefined;
const stream = { getTracks: () => [{ stop: mocks.stopTrack }] };

async function setup() {
  const path = new URL('../../plugin.mjs', import.meta.url).href;
  const { default: register } = await import(path);
  const plugin = new Hono();
  const logger = { warn: vi.fn(), error: vi.fn() };
  register(plugin, {
    config: {
      get: (key: string) => (key === 'apiKey' ? vendorKey : undefined),
    },
    logger,
  });
  const app = new Hono();
  app.use('/api/plugins/*', async (c, next) => {
    if (c.req.header('authorization') !== `Bearer ${stationCredential}`)
      return c.text('Unauthorized', 401);
    await next();
  });
  app.route('/api/plugins/elevenlabs-voice', plugin);
  const upstream = vi.fn(async (_request: Request) => Response.json({ token }));
  const mintReplies: Response[] = [];
  vi.stubGlobal(
    'fetch',
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === station) {
        const reply = await app.fetch(request);
        mintReplies.push(reply.clone());
        return reply;
      }
      if (url.origin === 'https://api.elevenlabs.io') return upstream(request);
      throw new Error('Unexpected fixture URL');
    },
  );
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('AudioContext', Audio);
  const getUserMedia = vi.fn(async () => stream);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  setClientCredentialResolver(() => ({
    credential: stationCredential,
    origin: station,
  }));
  dispose = activate({ apiBase: station });
  return {
    stt: voiceRegistry.getSTT('elevenlabs')!,
    tts: voiceRegistry.getTTS('elevenlabs')!,
    upstream,
    getUserMedia,
    logger,
    mintReplies,
  };
}

afterEach(() => {
  dispose?.();
  dispose = undefined;
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
  mocks.stopTrack.mockClear();
  Socket.opened.length = 0;
  Audio.instances.length = 0;
});

test('mounted STT mints a Scribe token and sends PCM while retaining committed segments', async () => {
  const { stt, upstream, mintReplies } = await setup();
  await stt.startListening();
  const mint = upstream.mock.calls[0][0];
  expect(mint.url).toBe(
    'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe',
  );
  expect(mint.method).toBe('POST');
  expect(mint.headers.get('xi-api-key')).toBe(vendorKey);
  expect(mint.headers.get('authorization')).toBeNull();
  expect(mintReplies[0].headers.get('Cache-Control')).toBe('no-store');
  expect(await mintReplies[0].text()).not.toContain(vendorKey);
  const socket = Socket.opened[0];
  const url = new URL(socket.url);
  expect(url.origin + url.pathname).toBe(
    'wss://api.elevenlabs.io/v1/speech-to-text/realtime',
  );
  expect(Object.fromEntries(url.searchParams)).toEqual({
    token,
    model_id: 'scribe_v2_realtime',
    audio_format: 'pcm_16000',
    commit_strategy: 'vad',
  });

  const pushAudio = () =>
    Audio.instances[0].processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array([-1, 0, 1]) },
    });
  pushAudio();
  expect(socket.sent).toEqual([]);
  await socket.message({ message_type: 'session_started' });
  pushAudio();
  expect(socket.sent).toEqual([
    {
      message_type: 'input_audio_chunk',
      audio_base_64: 'AIAAAP9/',
      sample_rate: 16_000,
    },
  ]);
  await socket.message({ message_type: 'committed_transcript', text: 'one' });
  await socket.message({ message_type: 'partial_transcript', text: 'tw' });
  expect(stt.transcript).toBe('one tw');
  await socket.message({ message_type: 'committed_transcript', text: 'two' });
  expect(stt.transcript).toBe('one two');

  await socket.message({ message_type: 'auth_error', error: 'fixture denied' });
  expect(stt.state).toBe('error');
  expect(mocks.stopTrack).toHaveBeenCalledTimes(1);
  expect(Audio.instances[0].close).toHaveBeenCalledTimes(1);
  expect(socket.close).toHaveBeenCalledTimes(1);
  await socket.message({ message_type: 'partial_transcript', text: 'late' });
  expect(stt.transcript).toBe('one two');
});

test('TTS uses its own token, sends init/text/end and releases resources after playback', async () => {
  const { tts, upstream } = await setup();
  await tts.speak('Synthetic text');
  expect(upstream.mock.calls[0][0].url).toBe(
    'https://api.elevenlabs.io/v1/single-use-token/tts_websocket',
  );
  const socket = Socket.opened[0];
  const url = new URL(socket.url);
  expect(url.pathname).toBe(
    '/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM/stream-input',
  );
  expect(url.searchParams.get('single_use_token')).toBe(token);
  socket.onopen?.();
  expect(socket.sent).toEqual([
    { text: ' ' },
    { text: 'Synthetic text ' },
    { text: '' },
  ]);
  await socket.message({ audio: 'AQI=', is_final: false });
  await socket.message({ audio: 'Aw==', isFinal: true });
  const audio = Audio.instances[0];
  expect(new Uint8Array(audio.decodeAudioData.mock.calls[0][0])).toEqual(
    new Uint8Array([1, 2, 3]),
  );
  expect(audio.source.start).toHaveBeenCalledOnce();
  expect(tts.speaking).toBe(true);
  audio.source.onended?.();
  expect(tts.speaking).toBe(false);
  expect(audio.close).toHaveBeenCalledOnce();
});

test('a malformed authorization refuses STT and stops the acquired microphone', async () => {
  const { stt, upstream, mintReplies, logger } = await setup();
  upstream.mockResolvedValueOnce(
    Response.json({ signed_url: 'fixture-private-upstream-value' }),
  );
  await stt.startListening();
  expect(stt.state).toBe('error');
  expect(Socket.opened).toHaveLength(0);
  expect(mocks.stopTrack).toHaveBeenCalledOnce();
  expect(mintReplies[0].status).toBe(502);
  expect(await mintReplies[0].text()).not.toContain(
    'fixture-private-upstream-value',
  );
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(
    'fixture-private-upstream-value',
  );
});

test('Station credential refusal never reaches the vendor token endpoint', async () => {
  const { stt, upstream, mintReplies } = await setup();
  setClientCredentialResolver(undefined);
  await stt.startListening();
  expect(mintReplies[0].status).toBe(401);
  expect(upstream).not.toHaveBeenCalled();
  expect(stt.state).toBe('error');
  expect(mocks.stopTrack).toHaveBeenCalledOnce();
  expect(Socket.opened).toHaveLength(0);
});

test('withdrawal while waiting on permission or minting cannot reopen voice resources', async () => {
  const { stt, tts, upstream, getUserMedia } = await setup();
  let grant!: (value: typeof stream) => void;
  getUserMedia.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        grant = resolve;
      }),
  );
  const listening = stt.startListening();
  stt.stopListening();
  grant(stream);
  await listening;
  expect(mocks.stopTrack).toHaveBeenCalledOnce();
  expect(upstream).not.toHaveBeenCalled();

  let mint!: (reply: Response) => void;
  upstream.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        mint = resolve;
      }),
  );
  const speaking = tts.speak('Cancelled');
  await vi.waitFor(() => expect(upstream).toHaveBeenCalledOnce());
  dispose?.();
  dispose = undefined;
  mint(Response.json({ token }));
  await speaking;
  expect(tts.speaking).toBe(false);
  expect(voiceRegistry.getTTS('elevenlabs')).toBeUndefined();
  expect(Socket.opened).toHaveLength(0);
  expect(Audio.instances).toHaveLength(0);
});
