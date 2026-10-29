// @vitest-environment jsdom

import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { VoiceOrb } from '../../../components/voice/VoiceOrb';
import { useSTT } from '../../../hooks/useSTT';
import { LocalSpeechSTTProvider } from '../LocalSpeechSTTProvider';

class Recorder {
  static isTypeSupported = (type: string) => type.startsWith('audio/webm');
  static instances: Recorder[] = [];
  state = 'inactive';
  mimeType = 'audio/webm;codecs=opus';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    Recorder.instances.push(this);
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({
      data: new Blob(['recorded audio'], { type: this.mimeType }),
    });
    this.onstop?.();
  }
}
const binding = vi.hoisted(() => ({ provider: null as unknown }));
vi.mock('../../../contexts/VoiceProviderContext', () => ({
  useVoiceProviderContext: () => ({ activeSTT: binding.provider }),
}));
let provider: LocalSpeechSTTProvider;
let fetcher: ReturnType<typeof vi.fn>;
const stopTrack = vi.fn();
const getUserMedia = vi.fn();
beforeEach(() => {
  Recorder.instances = [];
  stopTrack.mockReset();
  getUserMedia
    .mockReset()
    .mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
  vi.stubGlobal('MediaRecorder', Recorder);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('isSecureContext', true);
  fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  setClientCredentialResolver(() => ({
    credential: 'test',
    origin: 'http://station',
  }));
  provider = new LocalSpeechSTTProvider('http://station');
  binding.provider = provider;
});
afterEach(() => {
  cleanup();
  provider.destroy();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});
async function record() {
  provider.startListening();
  await vi.waitFor(() => expect(Recorder.instances).toHaveLength(1));
  provider.stopListening();
}
function result(data: unknown) {
  fetcher.mockResolvedValue(Response.json({ success: true, data }));
}

test('records while active and emits only the final batch transcript through the real authenticated SDK upload', async () => {
  let complete!: (response: Response) => void;
  fetcher.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        complete = resolve;
      }),
  );
  const observed: { state: string; text: string }[] = [];
  provider.subscribe(() =>
    observed.push({ state: provider.state, text: provider.transcript }),
  );
  provider.startListening({ interimResults: true });
  await vi.waitFor(() => expect(Recorder.instances).toHaveLength(1));
  expect(fetcher).not.toHaveBeenCalled();
  expect(provider.transcript).toBe('');
  provider.stopListening();
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  expect(provider.state).toBe('transcribing');
  expect(stopTrack).toHaveBeenCalled();
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe('http://station/api/transcription');
  expect(init.method).toBe('POST');
  expect(init.body).toBeInstanceOf(Blob);
  expect(init.body.size).toBe(14);
  expect(new Headers(init.headers).get('authorization')).toBe('Bearer test');
  complete(
    Response.json({
      success: true,
      data: {
        status: 'transcribed',
        engine: {
          runtime: 'sherpa-onnx@2.0.0',
          model: 'parakeet-tdt-110m-int8',
        },
        durationMs: 2400,
        segments: [
          { startMs: 0, endMs: 900, text: 'Hello there.', tokens: [] },
          { startMs: 1000, endMs: 2400, text: 'Look here.', tokens: [] },
        ],
      },
    }),
  );
  await vi.waitFor(() => expect(provider.state).toBe('idle'));
  expect(provider.transcript).toBe('Hello there. Look here.');
  expect(observed.filter((s) => s.text)).toEqual([
    { state: 'idle', text: 'Hello there. Look here.' },
  ]);
});

test('needs-consent points to explicit operator status and download commands without downloading', async () => {
  result({
    status: 'unavailable',
    reason: 'needs-consent',
    downloads: [{ component: 'speech-model', version: 'pin', bytes: 123 }],
  });
  await record();
  await vi.waitFor(() => expect(provider.state).toBe('error'));
  expect(provider.errorMessage).toContain('operator');
  expect(provider.errorMessage).toContain('station media-tools status');
  expect(provider.errorMessage).toContain('station media-tools download --yes');
  expect(provider.errorMessage).toContain('explicit download');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]![0]).toBe('http://station/api/transcription');
});

test.each([
  [
    {
      status: 'unavailable',
      reason: 'unsupported-platform',
      platform: 'win32-arm64',
    },
    'supported Station host',
  ],
  [
    { status: 'failed', reason: 'too-long', message: 'too long' },
    'shorter message',
  ],
  [
    { status: 'failed', reason: 'timeout', message: 'timed out' },
    'Retry with a shorter',
  ],
  [{ status: 'failed', reason: 'busy', message: 'full' }, 'Wait a few seconds'],
  [
    { status: 'failed', reason: 'invalid-input', message: 'bad audio' },
    'Try recording again',
  ],
  [
    { status: 'failed', reason: 'aborted', message: 'cancelled' },
    'Record the message again',
  ],
  [
    { status: 'failed', reason: 'engine-error', message: 'bad output' },
    'station media-tools status',
  ],
  [
    {
      status: 'transcribed',
      engine: { runtime: 'test', model: 'test' },
      durationMs: 10,
      segments: [],
    },
    'No speech was detected',
  ],
])('typed server outcome %j is an actionable error', async (data, remedy) => {
  result(data);
  await record();
  await vi.waitFor(() => expect(provider.state).toBe('error'));
  expect(provider.errorMessage).toContain(remedy);
  expect(provider.transcript).toBe('');
});

test.each([
  [
    404,
    {
      success: false,
      error: 'Enable Local speech in Settings → Advanced → Feature previews.',
      code: 'feature_preview_disabled',
      previewId: 'local-speech',
      settingsPath:
        '/settings?view=feature-previews&highlight=feature-previews',
    },
    'Settings → Advanced → Feature previews',
  ],
  [
    503,
    {
      success: false,
      code: 'busy',
      error: 'The local recognizer queue is full.',
    },
    'Wait a few seconds',
  ],
  [413, { success: false, code: 'upload-too-large' }, '32 MiB'],
  [400, { success: false, code: 'invalid-input' }, 'Try recording again'],
  [403, { success: false, code: 'unauthorized' }, 'sign in'],
])(
  'HTTP %i envelope is preserved into an actionable error',
  async (status, body, remedy) => {
    fetcher.mockResolvedValue(
      Response.json(body, {
        status,
        headers: status === 503 ? { 'Retry-After': '5' } : undefined,
      }),
    );
    await record();
    await vi.waitFor(() => expect(provider.state).toBe('error'));
    expect(provider.errorMessage).toContain(remedy);
  },
);

test('microphone permission denial remains visible and never uploads', async () => {
  getUserMedia.mockRejectedValue(
    new DOMException('Permission denied', 'NotAllowedError'),
  );
  provider.startListening();
  await vi.waitFor(() => expect(provider.state).toBe('error'));
  expect(provider.errorMessage).toContain('Allow microphone access');
  expect(fetcher).not.toHaveBeenCalled();
});
test('MediaRecorder unsupported explains how to proceed before requesting a microphone', () => {
  vi.stubGlobal('MediaRecorder', undefined);
  expect(provider.isSupported).toBe(false);
  provider.startListening();
  expect(provider.errorMessage).toContain('MediaRecorder is unavailable');
  expect(getUserMedia).not.toHaveBeenCalled();
});
test('cancelling pending microphone permission stops the late stream and records nothing', async () => {
  let grant!: (stream: unknown) => void;
  getUserMedia.mockImplementation(
    () =>
      new Promise((resolve) => {
        grant = resolve;
      }),
  );
  provider.startListening();
  provider.stopListening();
  grant({ getTracks: () => [{ stop: stopTrack }] });
  await vi.waitFor(() => expect(stopTrack).toHaveBeenCalled());
  expect(provider.state).toBe('idle');
  expect(Recorder.instances).toHaveLength(0);
  expect(fetcher).not.toHaveBeenCalled();
});
test('cancelling a submitted recording aborts upload and suppresses its late transcript', async () => {
  let complete!: (response: Response) => void;
  fetcher.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        complete = resolve;
      }),
  );
  await record();
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  const signal = fetcher.mock.calls[0]![1].signal as AbortSignal;
  provider.cancelListening();
  expect(signal.aborted).toBe(true);
  complete(
    Response.json({
      success: true,
      data: {
        status: 'transcribed',
        engine: { runtime: 'test', model: 'test' },
        durationMs: 1000,
        segments: [
          { text: 'stale result', startMs: 0, endMs: 1000, tokens: [] },
        ],
      },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(provider.state).toBe('idle');
  expect(provider.transcript).toBe('');
});

test('an unknown unavailable reason settles in an actionable error', async () => {
  result({ status: 'unavailable', reason: 'future-reason' });
  await record();
  await vi.waitFor(() => expect(provider.state).toBe('error'));
  expect(provider.errorMessage).toContain('media tools');
  expect(provider.transcript).toBe('');
});
test('the mounted VoiceOrb cancels pending transcription through useSTT and discards a late result', async () => {
  let complete!: (response: Response) => void;
  let signal!: AbortSignal;
  fetcher.mockImplementation((_url, init: RequestInit) => {
    signal = init.signal!;
    return new Promise<Response>((r) => {
      complete = r;
    });
  });
  function Orb() {
    const stt = useSTT();
    return createElement(VoiceOrb, {
      state: stt.state,
      supported: stt.supported,
      onStart: stt.startListening,
      onStop: stt.stopListening,
    });
  }
  render(createElement(Orb));
  fireEvent.click(screen.getByRole('button', { name: 'Speak message' }));
  await vi.waitFor(() => expect(Recorder.instances).toHaveLength(1));
  fireEvent.click(screen.getByRole('button', { name: 'Speak message' }));
  await vi.waitFor(() => expect(provider.state).toBe('transcribing'));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel transcription' }));
  expect(signal.aborted).toBe(true);
  expect(provider.state).toBe('idle');
  await act(async () =>
    complete(
      Response.json({
        success: true,
        data: { status: 'transcribed', segments: [{ text: 'late words' }] },
      }),
    ),
  );
  expect(provider.transcript).toBe('');
  expect(stopTrack).toHaveBeenCalled();
});
