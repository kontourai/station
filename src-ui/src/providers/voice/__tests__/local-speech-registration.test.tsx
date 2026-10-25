// @vitest-environment jsdom
import { voiceRegistry } from '@kontourai/station-sdk';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  useVoiceProviderContext,
  VoiceProviderContext,
} from '../../../contexts/VoiceProviderContext';

const state = vi.hoisted(() => ({
  previews: undefined as { id: string; enabled: boolean }[] | undefined,
  apiBase: 'http://station-a',
  connectionId: 'a',
}));
vi.mock('@kontourai/station-sdk', async (original) => ({
  ...(await original<object>()),
  useFeaturePreviewsQuery: () => ({ data: state.previews }),
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({
    apiBase: state.apiBase,
    connectionId: state.connectionId,
  }),
}));
vi.mock('../../../hooks/useServerCapabilities', () => ({
  useServerCapabilities: () => {},
}));
vi.mock('../../../contexts/DeviceSettingsContext', () => ({
  useDeviceSettings: () => ({
    developerToolsEnabled: false,
    sttProvider: 'station-local',
  }),
  useDeviceSettingsActions: () => ({ setDeviceSetting: vi.fn() }),
}));
function Probe() {
  const { availableSTT, activeSTT } = useVoiceProviderContext();
  return (
    <div>
      {availableSTT.map((p) => p.name).join(',')} / {activeSTT?.id}
    </div>
  );
}
function tree() {
  return (
    <VoiceProviderContext>
      <Probe />
    </VoiceProviderContext>
  );
}
beforeEach(() => {
  state.previews = undefined;
  state.apiBase = 'http://station-a';
  state.connectionId = 'a';
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('app registration is absent while local-speech is off or unresolved, present while on, and removed on a live disable', () => {
  const view = render(tree());
  expect(voiceRegistry.getSTT('station-local')).toBeUndefined();
  state.previews = [
    { id: 'walkthroughs', enabled: true },
    { id: 'local-speech', enabled: false },
  ];
  view.rerender(tree());
  expect(voiceRegistry.getSTT('station-local')).toBeUndefined();
  state.previews = [{ id: 'local-speech', enabled: true }];
  view.rerender(tree());
  expect(view.getByText('Station (local) / station-local')).toBeTruthy();
  const provider = voiceRegistry.getSTT('station-local');
  expect(provider).toBeDefined();
  state.previews = [{ id: 'local-speech', enabled: false }];
  view.rerender(tree());
  expect(voiceRegistry.getSTT('station-local')).toBeUndefined();
  expect(view.queryByText(/Station \(local\)/)).toBeNull();
});

test('disable and Station switch dispose the old provider including a late microphone permission grant', async () => {
  state.previews = [{ id: 'local-speech', enabled: true }];
  const stop = vi.fn();
  let grant!: (stream: unknown) => void;
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    },
  });
  vi.stubGlobal('MediaRecorder', class {});
  const view = render(tree());
  const old = voiceRegistry.getSTT('station-local')!;
  act(() => old.startListening());
  state.apiBase = 'http://station-b';
  state.connectionId = 'b';
  view.rerender(tree());
  expect(voiceRegistry.getSTT('station-local')).not.toBe(old);
  expect(old.state).toBe('idle');
  grant({ getTracks: () => [{ stop }] });
  await waitFor(() => expect(stop).toHaveBeenCalledOnce());
  state.previews = undefined;
  view.rerender(tree());
  expect(voiceRegistry.getSTT('station-local')).toBeUndefined();
});
