// @vitest-environment jsdom

/**
 * #1969: what a capture puts on screen, and what it must not put anywhere.
 */

import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'authority-1',
  }),
}));

import { DeviceWorkspacePane } from '../DeviceWorkspacePane';
import {
  ANDROID_DEVICE_ID,
  authorizeScope,
  captureBody,
  click,
  IOS_DEVICE_ID,
  ONE_BY_ONE_PNG,
  readyInventory,
  renderInQueryClient,
  stubDeviceFetch,
} from './deviceWorkspacePaneHarness';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('capturing a frame (#1969)', () => {
  /**
   * The request goes to the SELECTED device, by platform and id. Binding the
   * capture to the first listed device instead — or to the last one hovered —
   * reds the url assertion.
   */
  test('Capture asks for the selected device and renders the frame with its own ratio', async () => {
    const log = stubDeviceFetch({
      inventory: readyInventory(),
      captures: [captureBody({ width: 1179, height: 2556 })],
    });
    authorizeScope();
    renderInQueryClient(<DeviceWorkspacePane />);

    await click(await screen.findByRole('radio', { name: /iPhone/ }));
    await click(screen.getByRole('button', { name: 'Capture' }));

    await waitFor(() => expect(log.captureRequests).toHaveLength(1));
    expect(log.captureRequests[0]).toBe(
      `http://station.test/api/mobile-devices/hosts/local/devices/ios/${IOS_DEVICE_ID}/capture`,
    );

    const image = await screen.findByRole('img');
    // The ratio is the CAPTURE's own width/height, read off the frame's
    // custom property. Hard-coding a phone ratio reds this.
    const frame = image.parentElement;
    expect(frame?.style.getPropertyValue('--device-frame-ratio')).toBe(
      '1179 / 2556',
    );
  });

  /**
   * Rotation without an orientation field: the same two numbers arrive the
   * other way round and the frame follows. Retaining the previous ratio —
   * or deriving it from the decoded bitmap rather than the contract — reds
   * the second assertion.
   */
  test('a second capture in landscape flips the ratio', async () => {
    stubDeviceFetch({
      inventory: readyInventory(),
      captures: [
        captureBody({ width: 1179, height: 2556, captureId: 'capture-1' }),
        captureBody({
          width: 2556,
          height: 1179,
          captureId: 'capture-2',
          capturedAt: '2026-09-14T10:00:09.000Z',
        }),
      ],
    });
    authorizeScope();
    renderInQueryClient(<DeviceWorkspacePane />);

    await click(await screen.findByRole('radio', { name: /iPhone/ }));
    await click(screen.getByRole('button', { name: 'Capture' }));
    await waitFor(() =>
      expect(
        screen
          .getByRole('img')
          .parentElement?.style.getPropertyValue('--device-frame-ratio'),
      ).toBe('1179 / 2556'),
    );

    await click(screen.getByRole('button', { name: 'Capture' }));
    await waitFor(() =>
      expect(
        screen
          .getByRole('img')
          .parentElement?.style.getPropertyValue('--device-frame-ratio'),
      ).toBe('2556 / 1179'),
    );
  });

  /**
   * The caption AND the alt text both say snapshot and both carry the time,
   * so a screen-reader user is not told something different from what is on
   * screen. Dropping the wording from either reds this; so does any of the
   * forbidden live-stream words appearing.
   */
  test('the caption and the alt text both claim a snapshot and a time', async () => {
    stubDeviceFetch({
      inventory: readyInventory(),
      captures: [captureBody({ capturedAt: '2026-09-14T10:00:05.000Z' })],
    });
    authorizeScope();
    const { container } = renderInQueryClient(<DeviceWorkspacePane />);

    await click(await screen.findByRole('radio', { name: /iPhone/ }));
    await click(screen.getByRole('button', { name: 'Capture' }));

    const time = new Date('2026-09-14T10:00:05.000Z').toLocaleTimeString();
    const image = await screen.findByRole('img');
    expect(image.getAttribute('alt')).toBe(
      `Snapshot of iPhone 17 Pro, captured ${time}`,
    );
    const caption = container.querySelector('figcaption');
    expect(caption?.textContent).toContain('Snapshot of iPhone 17 Pro');
    expect(caption?.textContent).toContain(time);
    for (const forbidden of ['Live', 'Streaming', 'Connected'])
      expect(container.textContent).not.toContain(forbidden);
  });

  /**
   * The bytes are never written down. Adding the capture to the pane's
   * persisted state — the thing the contract parser refuses and this asserts
   * end to end — reds the last two expectations.
   */
  test('the selected target is remembered and the captured image is not', async () => {
    stubDeviceFetch({
      inventory: readyInventory(),
      captures: [captureBody({ platform: 'android' })],
    });
    authorizeScope();
    renderInQueryClient(<DeviceWorkspacePane />);

    await click(await screen.findByRole('radio', { name: /Pixel/ }));
    await click(screen.getByRole('button', { name: 'Capture' }));
    await screen.findByRole('img');

    const stored = Object.keys(localStorage).filter((key) =>
      key.startsWith('station:device-pane-state:v1:'),
    );
    expect(stored).toHaveLength(1);
    const raw = localStorage.getItem(stored[0] as string) ?? '';
    expect(JSON.parse(raw)).toEqual({
      version: '1.0',
      hostId: 'local',
      platform: 'android',
      deviceId: ANDROID_DEVICE_ID,
    });
    expect(raw).not.toContain(ONE_BY_ONE_PNG.slice(0, 24));
    // And nothing anywhere else in the store carries the frame either.
    const everything = Object.keys(localStorage)
      .map((key) => localStorage.getItem(key) ?? '')
      .join('');
    expect(everything).not.toContain(ONE_BY_ONE_PNG.slice(0, 24));
  });

  /** A remembered target is the selection on the next mount. */
  test('a remembered target is reselected on mount', async () => {
    localStorage.setItem(
      `station:device-pane-state:v1:${encodeURIComponent('http://station.test')}:${encodeURIComponent('authority-1')}`,
      JSON.stringify({
        version: '1.0',
        hostId: 'local',
        platform: 'android',
        deviceId: ANDROID_DEVICE_ID,
      }),
    );
    stubDeviceFetch({ inventory: readyInventory() });
    authorizeScope();
    renderInQueryClient(<DeviceWorkspacePane />);
    const pixel = await screen.findByRole('radio', { name: /Pixel/ });
    expect(pixel).toHaveProperty('checked', true);
    expect(screen.getByRole('radio', { name: /iPhone/ })).toHaveProperty(
      'checked',
      false,
    );
  });
});
