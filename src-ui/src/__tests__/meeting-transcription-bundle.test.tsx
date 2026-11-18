// @vitest-environment jsdom
import { cpSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TextEncoder as NodeTextEncoder } from 'node:util';
import { STATION_AGENT_ID } from '@kontourai/station-contracts/agent-identity';
import { SDKProvider, voiceRegistry } from '@kontourai/station-sdk';
import { buildPlugin } from '@kontourai/station-shared/build';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { fakeSTT } from '../../../examples/meeting-transcription/src/__tests__/helpers/fake-stt';
import { trackTempDirs } from '../../../src-server/__test-utils__/temp-dirs';
import { PluginRegistry } from '../core/PluginRegistry';
import {
  ensurePluginSharedRuntimeReady,
  installPluginSharedRuntime,
} from '../core/pluginSharedRuntime';

const example = resolve(__dirname, '../../../examples/meeting-transcription');
const makeTempDir = trackTempDirs({ lifetime: 'file' });
const sdkEntry = '@kontourai/station-sdk/agent';
const host = window as Window & {
  __station_ai_shared?: Record<string, unknown>;
  __station_ai_plugins?: Record<string, unknown>;
  require?: unknown;
};
let bundle: string;

beforeAll(async () => {
  const plugin = makeTempDir('meeting-transcription-bundle-');
  cpSync(resolve(example, 'plugin.json'), resolve(plugin, 'plugin.json'));
  cpSync(resolve(example, 'src'), resolve(plugin, 'src'), { recursive: true });
  // esbuild needs its encoder and byte array from the same realm.
  const previousEncoder = globalThis.TextEncoder;
  const previousArray = globalThis.Uint8Array;
  globalThis.TextEncoder = NodeTextEncoder as typeof TextEncoder;
  globalThis.Uint8Array = new NodeTextEncoder().encode('')
    .constructor as Uint8ArrayConstructor;
  try {
    const result = await buildPlugin(plugin);
    if (!result.bundlePath) throw new Error('Meeting bundle was not built.');
    bundle = readFileSync(result.bundlePath, 'utf8');
  } finally {
    globalThis.TextEncoder = previousEncoder;
    globalThis.Uint8Array = previousArray;
  }
  installPluginSharedRuntime();
  await ensurePluginSharedRuntimeReady();
}, 60_000);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.head
    .querySelectorAll('[data-station-plugin]')
    .forEach((node) => node.remove());
  delete host.__station_ai_plugins?.['meeting-transcription'];
  delete host.require;
});

async function loadMeetingPane() {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const path = new URL(input.toString(), location.origin).pathname;
    if (path === '/api/plugins') {
      return Response.json({
        plugins: [
          { name: 'meeting-transcription', version: '0.1.0', hasBundle: true },
        ],
      });
    }
    if (path === '/api/plugins/meeting-transcription/bundle.css') {
      return new Response('');
    }
    throw new Error(`Unexpected fixture request: ${path}`);
  });
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (
          node instanceof HTMLScriptElement &&
          new URL(node.src).pathname ===
            '/api/plugins/meeting-transcription/bundle.js'
        ) {
          // Supply the response bytes for a script request jsdom does not fetch.
          new Function(bundle)();
          node.dispatchEvent(new Event('load'));
        }
      }
    }
  });
  observer.observe(document.head, { childList: true });
  try {
    const registry = new PluginRegistry();
    registry.setApiBase(location.origin);
    expect(await registry.reload()).toBe('ready');
    const Pane = registry.getLayout('meeting-transcription');
    if (!Pane)
      throw new Error('Station did not register Meeting Transcription.');
    return Pane;
  } finally {
    observer.disconnect();
  }
}

test('Station loads the built meeting pane and sends only to the cataloged Station Agent', async () => {
  const Pane = await loadMeetingPane();
  const stt = fakeSTT('bundled-meeting-stt');
  const dispose = voiceRegistry.registerSTT(stt);
  const launchChat = vi.fn();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  let available = true;
  try {
    render(
      <SDKProvider
        value={{
          apiBase: '',
          contexts: {
            agents: {
              useAgents: () =>
                available
                  ? [{ slug: STATION_AGENT_ID, name: 'Station Assistant' }]
                  : [],
            },
            activeChats: { useLaunchChat: () => launchChat },
          },
          hooks: {},
        }}
      >
        <Pane />
      </SDKProvider>,
    );
    const sendTranscript = (transcript: string) => {
      fireEvent.click(screen.getByRole('button', { name: 'Start meeting' }));
      act(() => stt.hear(transcript));
      fireEvent.click(screen.getByRole('button', { name: 'Send as message' }));
    };
    sendTranscript('Review the draft');
    expect(launchChat).toHaveBeenCalledExactlyOnceWith(
      STATION_AGENT_ID,
      'Station Assistant',
      'Review the draft',
    );

    available = false;
    sendTranscript('Keep the original draft');
    expect(launchChat).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not found'));
  } finally {
    dispose();
  }
});

test('a host SDK predating the identity export loads the pane with upgrade guidance', async () => {
  const shared = host.__station_ai_shared;
  if (!shared) throw new Error('Station did not publish the shared SDK.');
  const current = shared[sdkEntry];
  const agent = await import('@kontourai/station-sdk/agent');
  shared[sdkEntry] = { ...agent, STATION_AGENT_ID: undefined };
  try {
    const Pane = await loadMeetingPane();
    const launchChat = vi.fn();
    render(
      <SDKProvider
        value={{
          apiBase: '',
          contexts: {
            agents: { useAgents: () => [] },
            activeChats: { useLaunchChat: () => launchChat },
          },
          hooks: {},
        }}
      >
        <Pane />
      </SDKProvider>,
    );
    expect(screen.getByRole('status').textContent).toBe(
      'Update Station to use Meeting Transcription.',
    );
    expect(screen.queryByRole('button', { name: 'Start meeting' })).toBeNull();
  } finally {
    shared[sdkEntry] = current;
  }
});
