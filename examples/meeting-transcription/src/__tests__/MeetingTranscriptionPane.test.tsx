/**
 * @vitest-environment jsdom
 */
/**
 * The modal is reachable from the Workspace Pane plugin.json declares (#2401):
 * the bundle exports a component under the renderer name the manifest names,
 * and that Pane opens the modal and sends its transcript to chat. The old
 * manifest declared a toolbar action no runtime reads, so nothing opened it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SDKProvider,
  type STTOptions,
  type STTProvider,
  type STTState,
  voiceRegistry,
} from '@kontourai/station-sdk';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { components } from '../index';

const manifest = JSON.parse(
  readFileSync(
    join(process.cwd(), 'examples/meeting-transcription/plugin.json'),
    'utf8',
  ),
) as {
  extensions: {
    'io.kontourai.station': {
      workspacePanes: Array<{ renderer: { kind: string; name: string } }>;
    };
  };
};

function fakeSTT() {
  const listeners = new Set<() => void>();
  const provider = {
    id: 'pane-stt',
    name: 'pane-stt',
    isSupported: true,
    state: 'idle' as STTState,
    transcript: '',
    startListening: vi.fn((_opts?: STTOptions) => {
      provider.state = 'listening';
      for (const fn of listeners) fn();
    }),
    stopListening: vi.fn(() => {
      provider.state = 'idle';
      for (const fn of listeners) fn();
    }),
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    hear(text: string) {
      provider.transcript = text;
      for (const fn of listeners) fn();
    },
  };
  return provider satisfies STTProvider;
}

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

describe('meeting-transcription Workspace Pane', () => {
  test('exports a component for every plugin-component Pane the manifest declares', () => {
    const renderers = manifest.extensions['io.kontourai.station'].workspacePanes
      .filter((pane) => pane.renderer.kind === 'plugin-component')
      .map((pane) => pane.renderer.name);
    expect(renderers).toEqual(['meeting-transcription']);
    for (const name of renderers)
      expect(components).toHaveProperty([name], expect.any(Function));
  });

  test('opens the modal and sends the transcript to Station’s Agent', () => {
    const stt = fakeSTT();
    disposers.push(voiceRegistry.registerSTT(stt));
    const launchChat = vi.fn();
    const Pane = components['meeting-transcription'];
    render(
      <SDKProvider
        value={{
          apiBase: '',
          contexts: {
            agents: { useAgents: () => [{ slug: 'station', name: 'Station' }] },
            activeChats: { useLaunchChat: () => launchChat },
          },
          hooks: {},
        }}
      >
        <Pane />
      </SDKProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Start meeting' }));
    expect(stt.startListening).toHaveBeenCalledTimes(1);
    act(() => stt.hear('ship the release on Friday'));
    fireEvent.click(screen.getByRole('button', { name: 'Send as message' }));

    expect(launchChat).toHaveBeenCalledExactlyOnceWith(
      'station',
      'Station',
      'ship the release on Friday',
    );
  });
});
