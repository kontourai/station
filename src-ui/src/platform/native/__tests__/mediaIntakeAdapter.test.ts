import { describe, expect, it } from 'vitest';
import { TauriNativePlatformAdapter } from '../tauri';
import type { NativeCapabilityState } from '../types';
import { WebNativePlatformAdapter } from '../web';
import { completeNativeCapabilityReport } from './completeNativeCapabilityReportFixture';

/**
 * The adapter is the only place the media-intake plugin's command and event
 * names are written down. They must match the native plugins
 * (src-desktop/plugins/media-intake: `@Command fun readClipboardImages` is
 * invoked as `read_clipboard_images`; Kotlin triggers `sharedImages`).
 */
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const FILES = [{ name: 'shot.png', mimeType: 'image/png', dataUrl: PNG }];

function adapter(
  states: {
    shareIntake?: NativeCapabilityState;
    clipboard?: NativeCapabilityState;
  },
  reply: (command: string) => unknown = () => ({ files: [] }),
) {
  const calls: string[] = [];
  const registered: Array<{ plugin: string; event: string }> = [];
  let fire: (() => void) | undefined;
  let unregistered = 0;
  const instance = new TauriNativePlatformAdapter({
    async invoke<T>(command: string) {
      if (command === 'native_capability_report') {
        return completeNativeCapabilityReport('android', {
          'image-share-intake': { state: states.shareIntake ?? 'disabled' },
          'clipboard-image': { state: states.clipboard ?? 'disabled' },
        }) as T;
      }
      calls.push(command);
      const value = reply(command);
      if (value instanceof Error) throw value;
      return value as T;
    },
    listen: async () => () => {},
    async addPluginListener(plugin, event, handler) {
      registered.push({ plugin, event });
      fire = handler;
      return () => {
        unregistered += 1;
      };
    },
  });
  return {
    instance,
    calls,
    registered,
    fire: () => fire?.(),
    unregistered: () => unregistered,
  };
}

describe('Tauri media-intake adapter', () => {
  it('maps each read to its plugin command and validates the reply', async () => {
    const host = adapter(
      { shareIntake: 'enabled', clipboard: 'enabled' },
      () => ({ files: FILES }),
    );
    await host.instance.getCapabilityReport();

    await expect(host.instance.readClipboardImages()).resolves.toEqual({
      status: 'ok',
      value: { files: FILES },
    });
    await expect(host.instance.takeSharedImages()).resolves.toEqual({
      status: 'ok',
      value: { files: FILES },
    });
    expect(host.calls).toEqual([
      'plugin:station-media-intake|read_clipboard_images',
      'plugin:station-media-intake|take_shared_images',
    ]);
  });

  it('accepts an empty list and refuses a malformed one', async () => {
    const replies = [
      { files: [] },
      { files: [{ name: 'x', mimeType: 'text/plain', dataUrl: PNG }] },
    ];
    const host = adapter({ clipboard: 'enabled' }, () => replies.shift());
    await host.instance.getCapabilityReport();
    await expect(host.instance.readClipboardImages()).resolves.toEqual({
      status: 'ok',
      value: { files: [] },
    });
    await expect(host.instance.readClipboardImages()).resolves.toMatchObject({
      status: 'error',
      command: 'read-clipboard-images',
    });
  });

  it("keeps the plugin's refusal sentence", async () => {
    // A plugin rejection arrives as `{ message }`, not an Error.
    const rejecting = adapter({ shareIntake: 'enabled' }, () => {
      throw { message: 'Station can take at most 5 images at once.' };
    });
    await rejecting.instance.getCapabilityReport();
    await expect(rejecting.instance.takeSharedImages()).resolves.toEqual({
      status: 'error',
      command: 'take-shared-images',
      message: 'Station can take at most 5 images at once.',
    });
  });

  it('never calls the plugin when the host does not report the capability', async () => {
    const host = adapter({ shareIntake: 'disabled', clipboard: 'unsupported' });
    await host.instance.getCapabilityReport();
    await expect(host.instance.readClipboardImages()).resolves.toMatchObject({
      status: 'unsupported',
      command: 'read-clipboard-images',
    });
    await expect(host.instance.takeSharedImages()).resolves.toMatchObject({
      status: 'unsupported',
      command: 'take-shared-images',
    });
    const subscription = host.instance.subscribeToSharedImages(() => {});
    await subscription.ready;
    subscription.dispose();
    expect(host.calls).toEqual([]);
    expect(host.registered).toEqual([]);
  });

  it('listens for the sharedImages nudge only where image-share-intake is enabled', async () => {
    const host = adapter({ shareIntake: 'enabled' });
    await host.instance.getCapabilityReport();
    let nudges = 0;
    const subscription = host.instance.subscribeToSharedImages(() => {
      nudges += 1;
    });
    await subscription.ready;
    expect(host.registered).toEqual([
      { plugin: 'station-media-intake', event: 'sharedImages' },
    ]);
    host.fire();
    expect(nudges).toBe(1);
    subscription.dispose();
    host.fire();
    expect(nudges).toBe(1);
    expect(host.unregistered()).toBe(1);
  });

  it('accepts an older shell report without the media-intake ids, leaving them disabled', async () => {
    const instance = new TauriNativePlatformAdapter({
      async invoke<T>() {
        const report = completeNativeCapabilityReport('android');
        return {
          ...report,
          capabilities: report.capabilities.filter(
            ({ id }) => id !== 'clipboard-image' && id !== 'image-share-intake',
          ),
        } as T;
      },
      listen: async () => () => {},
    });
    await expect(instance.getCapabilityReport()).resolves.toMatchObject({
      status: 'ok',
    });
    expect(instance.capability('clipboard-image').state).toBe('disabled');
    expect(instance.capability('image-share-intake').state).toBe('disabled');
  });

  it('the web adapter has no native image reads', async () => {
    const web = new WebNativePlatformAdapter();
    expect(web.capability('clipboard-image').state).toBe('unsupported');
    expect(web.capability('image-share-intake').state).toBe('unsupported');
    // PWA text shares are the web's share-intake; they are not image shares.
    expect(web.capability('share-intake').state).toBe('enabled');
    await expect(web.readClipboardImages()).resolves.toMatchObject({
      status: 'unsupported',
    });
    await expect(web.takeSharedImages()).resolves.toMatchObject({
      status: 'unsupported',
    });
  });
});
