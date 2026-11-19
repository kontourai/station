// @vitest-environment jsdom
import {
  _setApiBase,
  type STTProvider,
  voiceRegistry,
} from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import {
  useVoiceProviderContext,
  VoiceProviderContext,
} from '../../../contexts/VoiceProviderContext';

vi.mock('../useLocalSpeechProvider', () => ({
  useLocalSpeechProvider: () => {},
}));
vi.mock('../../../contexts/DeviceSettingsContext', () => ({
  useDeviceSettings: () => ({
    sttProvider: 'remote-stt',
    ttsProvider: 'remote-tts',
  }),
  useDeviceSettingsActions: () => ({ setDeviceSetting: vi.fn() }),
}));

const remoteSTT = { id: 'remote-stt', name: 'Remote STT', configured: true };
const remoteTTS = { id: 'remote-tts', name: 'Remote TTS', configured: true };
const configuredVoice = { voice: { stt: [remoteSTT], tts: [remoteTTS] } };
const emptyVoice = { voice: { stt: [], tts: [] } };

function VoiceSelection() {
  const { activeSTT, activeTTS } = useVoiceProviderContext();
  return (
    <output>
      {activeSTT?.name ?? 'No STT'} / {activeTTS?.name ?? 'No TTS'}
    </output>
  );
}

function voiceTree(key: string, client: QueryClient) {
  return (
    <QueryClientProvider key={key} client={client}>
      <VoiceProviderContext>
        <VoiceSelection />
      </VoiceProviderContext>
    </QueryClientProvider>
  );
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

afterEach(() => {
  cleanup();
  _setApiBase('');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const id of ['remote-stt', 'plugin-stt'])
    voiceRegistry.unregisterSTT(id);
  voiceRegistry.unregisterTTS('remote-tts');
});

test('changing the mounted Station retires its stubs and preserves a plugin replacement', async () => {
  const fetchCapabilities = vi.fn(async (url: string) => {
    if (url === 'https://station-a.test/api/system/capabilities')
      return Response.json(configuredVoice);
    if (url === 'https://station-b.test/api/system/capabilities')
      return Response.json(emptyVoice);
    throw new Error(`Unexpected test URL ${url}`);
  });
  vi.stubGlobal('fetch', fetchCapabilities);
  _setApiBase('https://station-a.test');
  const view = render(voiceTree('a', client()));
  await screen.findByText('Remote STT / Remote TTS');

  const plugin: STTProvider = {
    id: 'remote-stt',
    name: 'Plugin STT',
    isSupported: true,
    state: 'idle',
    transcript: '',
    subscribe: () => () => {},
    startListening() {},
    stopListening() {},
  };
  let dispose: () => void = () => {};
  act(() => {
    dispose = voiceRegistry.registerSTT(plugin);
  });
  try {
    await screen.findByText('Plugin STT / Remote TTS');
    _setApiBase('https://station-b.test');
    view.rerender(voiceTree('b', client()));
    await screen.findByText('Plugin STT / No TTS');
    expect(voiceRegistry.getSTT('remote-stt')).toBe(plugin);
    expect(voiceRegistry.getTTS('remote-tts')).toBeUndefined();
    expect(fetchCapabilities.mock.calls.map(([url]) => url)).toEqual([
      'https://station-a.test/api/system/capabilities',
      'https://station-b.test/api/system/capabilities',
    ]);
  } finally {
    act(() => dispose());
  }
});

test('empty and failed observations retire cached capability stubs before remount', async () => {
  _setApiBase('https://station-a.test');
  vi.stubGlobal('fetch', async () => Response.json(configuredVoice));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const queryClient = client();
  const view = render(voiceTree('a', queryClient));
  await screen.findByText('Remote STT / Remote TTS');

  await act(async () =>
    queryClient.setQueryData(['system-capabilities'], emptyVoice),
  );
  await screen.findByText('No STT / No TTS');
  await act(async () =>
    queryClient.setQueryData(['system-capabilities'], configuredVoice),
  );
  await screen.findByText('Remote STT / Remote TTS');
  vi.stubGlobal('fetch', async () => new Response(null, { status: 503 }));
  await act(async () =>
    queryClient.refetchQueries({ queryKey: ['system-capabilities'] }),
  );
  await screen.findByText('No STT / No TTS');
  expect(queryClient.getQueryData(['system-capabilities'])).toEqual(
    configuredVoice,
  );

  view.unmount();
  vi.stubGlobal('fetch', async () => Response.json(configuredVoice));
  const remounted = render(voiceTree('a', client()));
  await screen.findByText('Remote STT / Remote TTS');
  remounted.unmount();
  await waitFor(() =>
    expect(voiceRegistry.getSTT('remote-stt')).toBeUndefined(),
  );
  expect(voiceRegistry.getTTS('remote-tts')).toBeUndefined();
});
