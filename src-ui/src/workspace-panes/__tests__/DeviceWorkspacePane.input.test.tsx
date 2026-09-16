// @vitest-environment jsdom

/**
 * #1969: the pane sends nothing to the device, and says so.
 *
 * The view-only line is a property of this build, not a transient condition,
 * so it is present in every state that shows the frame area — idle, captured
 * and stale alike. Making it conditional reds one of the three cases below.
 */

import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'authority-1',
  }),
}));

import { DeviceWorkspacePane } from '../DeviceWorkspacePane';
import {
  authorizeScope,
  captureBody,
  click,
  readyInventory,
  renderInQueryClient,
  stubDeviceFetch,
} from './deviceWorkspacePaneHarness';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const VIEW_ONLY = /View only — taps and typing are not sent to this device\./;

describe('the pane is view-only (#1969)', () => {
  test('the line is present before a device is chosen, and after', async () => {
    stubDeviceFetch({ inventory: readyInventory() });
    authorizeScope();
    renderInQueryClient(<DeviceWorkspacePane />);
    await screen.findByRole('radio', { name: /iPhone/ });
    expect(screen.getByText(VIEW_ONLY)).toBeTruthy();

    await click(screen.getByRole('radio', { name: /iPhone/ }));
    expect(screen.getByText(VIEW_ONLY)).toBeTruthy();
  });

  test('the line is present with a frame on screen, fresh and stale alike', async () => {
    stubDeviceFetch({
      inventory: readyInventory(),
      captures: [
        captureBody({ capturedAt: new Date().toISOString() }),
        // Older than the threshold the moment it arrives.
        captureBody({
          captureId: 'capture-old',
          capturedAt: new Date(Date.now() - 120_000).toISOString(),
        }),
      ],
    });
    authorizeScope();
    renderInQueryClient(<DeviceWorkspacePane />);
    await click(await screen.findByRole('radio', { name: /iPhone/ }));

    await click(screen.getByRole('button', { name: 'Capture' }));
    await screen.findByRole('img');
    expect(screen.getByText(VIEW_ONLY)).toBeTruthy();

    await click(screen.getByRole('button', { name: 'Capture' }));
    await screen.findByText(/more than 30 seconds old/);
    expect(screen.getByText(VIEW_ONLY)).toBeTruthy();
  });

  /**
   * The absence of a handler, not a disabled one: there is nothing here to
   * re-enable by accident. Attaching an `onClick` or an `onKeyDown` to the
   * frame or the image reds this; so does making either focusable.
   */
  test('the frame and its image carry no handler and are not in the tab order', async () => {
    stubDeviceFetch({
      inventory: readyInventory(),
      captures: [captureBody()],
    });
    authorizeScope();
    const { container } = renderInQueryClient(<DeviceWorkspacePane />);
    await click(await screen.findByRole('radio', { name: /iPhone/ }));
    await click(screen.getByRole('button', { name: 'Capture' }));

    const image = await screen.findByRole('img');
    const frame = image.parentElement as HTMLElement;
    for (const element of [image, frame]) {
      expect(element.getAttribute('tabindex')).toBeNull();
      expect(element.getAttribute('onclick')).toBeNull();
      expect(element.getAttribute('onkeydown')).toBeNull();
      // React attaches through its own props rather than DOM attributes, so
      // assert on the props React actually mounted as well.
      const reactProps = Object.entries(element).find(([key]) =>
        key.startsWith('__reactProps$'),
      )?.[1] as Record<string, unknown> | undefined;
      expect(reactProps?.onClick).toBeUndefined();
      expect(reactProps?.onKeyDown).toBeUndefined();
      expect(reactProps?.onPointerDown).toBeUndefined();
    }

    // The only focusable things in the pane are its own controls.
    const focusable = [
      ...container.querySelectorAll(
        'a[href], button, input, select, textarea, [tabindex]',
      ),
    ];
    expect(
      focusable.every((node) => !node.closest('.device-pane__frame')),
    ).toBe(true);
  });
});
