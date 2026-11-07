// @vitest-environment jsdom
/**
 * The share receiver's web half: listen for the plugin's nudge, then take
 * what is pending (the agent-activity launch-route pattern), gated on
 * `share-intake`. The native layer is a fake adapter.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type {
  NativeCapabilityState,
  NativeCommandResult,
  NativeImageList,
} from '../platform/native/types';

const native = vi.hoisted(() => ({ adapter: null as unknown }));

vi.mock('../platform/native', () => ({
  get nativePlatformPromise() {
    return Promise.resolve(native.adapter);
  },
}));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [{ slug: 'agent-one', name: 'Agent One' }],
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost:3242' }),
}));
vi.mock('../hooks/useShareToConversation', () => ({
  useShareToConversation: () => vi.fn(),
}));
vi.mock('../components/chat/ShareTargetPickerModal', () => ({
  ShareTargetPickerModal: ({ sharedFiles }: { sharedFiles: File[] }) => (
    <div role="dialog" aria-label="Share to">
      {sharedFiles.map((file) => file.name).join(',')}
    </div>
  ),
}));

import {
  ShareIntakeController,
  subscribeToSharedImageIntake,
} from '../components/chat/ShareIntakeController';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const SHARED: NativeImageList = {
  files: [
    { name: 'one.png', mimeType: 'image/png', dataUrl: PNG },
    { name: 'two.png', mimeType: 'image/png', dataUrl: PNG },
  ],
};

function fakeAdapter(
  state: NativeCapabilityState,
  takes: Array<NativeCommandResult<NativeImageList>>,
) {
  const events: string[] = [];
  let nudge: (() => void) | undefined;
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const adapter = {
    capability: (id: 'share-intake') => ({ id, state, reason: 'fixture' }),
    takeSharedImages: vi.fn(async () => {
      events.push('take');
      return takes.shift() ?? { status: 'ok' as const, value: { files: [] } };
    }),
    subscribeToSharedImages: vi.fn((listener: () => void) => {
      events.push('subscribe');
      nudge = listener;
      return {
        ready,
        dispose: vi.fn(() => events.push('dispose')),
      };
    }),
  };
  return {
    adapter,
    events,
    nudge: () => nudge?.(),
    markReady: () => markReady(),
  };
}

const settle = () => act(async () => {});

afterEach(cleanup);

describe('subscribeToSharedImageIntake', () => {
  test('a host without share-intake is never subscribed to or taken from', async () => {
    const host = fakeAdapter('disabled', [{ status: 'ok', value: SHARED }]);
    const openPicker = vi.fn();
    subscribeToSharedImageIntake(host.adapter, openPicker, vi.fn());
    host.markReady();
    await settle();
    expect(host.events).toEqual([]);
    expect(openPicker).not.toHaveBeenCalled();
  });

  test('listens first, takes once listening, and opens the picker with the files', async () => {
    const host = fakeAdapter('enabled', [{ status: 'ok', value: SHARED }]);
    const openPicker = vi.fn();
    subscribeToSharedImageIntake(host.adapter, openPicker, vi.fn());
    await settle();
    // Not before the listener is registered.
    expect(host.events).toEqual(['subscribe']);
    host.markReady();
    await settle();
    expect(host.events).toEqual(['subscribe', 'take']);
    expect(openPicker).toHaveBeenCalledOnce();
    const files: File[] = openPicker.mock.calls[0][0];
    expect(files.map((file) => [file.name, file.type])).toEqual([
      ['one.png', 'image/png'],
      ['two.png', 'image/png'],
    ]);
  });

  test('a share while running is announced and taken', async () => {
    const host = fakeAdapter('enabled', [
      { status: 'ok', value: { files: [] } },
      { status: 'ok', value: SHARED },
    ]);
    const openPicker = vi.fn();
    subscribeToSharedImageIntake(host.adapter, openPicker, vi.fn());
    host.markReady();
    await settle();
    expect(openPicker).not.toHaveBeenCalled();
    host.nudge();
    await settle();
    expect(host.events).toEqual(['subscribe', 'take', 'take']);
    expect(openPicker).toHaveBeenCalledOnce();
  });

  test("a refused share reports the plugin's sentence and opens nothing", async () => {
    const host = fakeAdapter('enabled', [
      {
        status: 'error',
        command: 'take-shared-images',
        message: 'Station can take at most 5 images at once.',
      },
    ]);
    const openPicker = vi.fn();
    const reportError = vi.fn();
    subscribeToSharedImageIntake(host.adapter, openPicker, reportError);
    host.markReady();
    await settle();
    expect(reportError).toHaveBeenCalledWith(
      'Station can take at most 5 images at once.',
    );
    expect(openPicker).not.toHaveBeenCalled();
  });

  test('after dispose a pending take is ignored and the listener released', async () => {
    const host = fakeAdapter('enabled', [{ status: 'ok', value: SHARED }]);
    const openPicker = vi.fn();
    const dispose = subscribeToSharedImageIntake(
      host.adapter,
      openPicker,
      vi.fn(),
    );
    dispose();
    host.markReady();
    await settle();
    expect(host.events).toEqual(['subscribe', 'dispose']);
    expect(openPicker).not.toHaveBeenCalled();
  });
});

describe('ShareIntakeController', () => {
  test('opens the picker with images shared before the app was listening', async () => {
    const host = fakeAdapter('enabled', [{ status: 'ok', value: SHARED }]);
    native.adapter = host.adapter;
    host.markReady();
    render(<ShareIntakeController />);
    expect(
      (await screen.findByRole('dialog', { name: 'Share to' })).textContent,
    ).toBe('one.png,two.png');
  });

  test('renders nothing and takes nothing where share-intake is disabled', async () => {
    const host = fakeAdapter('disabled', [{ status: 'ok', value: SHARED }]);
    native.adapter = host.adapter;
    host.markReady();
    render(<ShareIntakeController />);
    await settle();
    expect(host.adapter.takeSharedImages).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
