// @vitest-environment jsdom

/**
 * #1969: a snapshot going stale is a DECORATION of a captured frame.
 *
 * Blanking the image when it goes stale reds the first test: a timestamped
 * old frame is more informative than nothing, provided it says it is old.
 * Removing the threshold entirely reds the second.
 */

import { act, cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'authority-1',
  }),
}));

import {
  DEVICE_SNAPSHOT_STALE_AFTER_MS,
  DeviceWorkspacePane,
} from '../DeviceWorkspacePane';
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
  vi.useRealTimers();
  localStorage.clear();
});

async function captureAt(capturedAt: string) {
  stubDeviceFetch({
    inventory: readyInventory(),
    captures: [captureBody({ capturedAt })],
  });
  authorizeScope();
  const view = renderInQueryClient(<DeviceWorkspacePane />);
  await click(await screen.findByRole('radio', { name: /iPhone/ }));
  await click(screen.getByRole('button', { name: 'Capture' }));
  await screen.findByRole('img');
  return view;
}

describe('a stale snapshot (#1969)', () => {
  test('an old frame gains the stale wording and KEEPS its image', async () => {
    await captureAt(new Date(Date.now() - 120_000).toISOString());
    expect(screen.getByText(/more than 30 seconds old/)).toBeTruthy();
    // The frame is still there, and still says what it is.
    const image = screen.getByRole('img');
    expect(image.getAttribute('alt')).toMatch(/^Snapshot of iPhone 17 Pro/);
    expect(image.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
  });

  test('a fresh frame carries no stale wording', async () => {
    await captureAt(new Date().toISOString());
    expect(screen.queryByText(/more than 30 seconds old/)).toBeNull();
    expect(screen.getByRole('img')).toBeTruthy();
  });

  /**
   * The threshold is a named constant and the copy states the same number.
   * Changing one without the other makes the sentence a claim nothing
   * derives, which this catches.
   */
  test('the copy states the threshold the code uses', async () => {
    expect(DEVICE_SNAPSHOT_STALE_AFTER_MS).toBe(30_000);
    await captureAt(new Date(Date.now() - 120_000).toISOString());
    expect(
      screen.getByText(
        new RegExp(
          `more than ${DEVICE_SNAPSHOT_STALE_AFTER_MS / 1000} seconds`,
        ),
      ),
    ).toBeTruthy();
  });

  /**
   * A frame that is fresh when it lands becomes stale where it sits: the
   * pane's own ticker re-derives the decoration rather than freezing the
   * answer it computed at render time. Removing the interval reds this.
   */
  test('a frame that was fresh becomes stale without another capture', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await captureAt(new Date().toISOString());
      expect(screen.queryByText(/more than 30 seconds old/)).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(
          DEVICE_SNAPSHOT_STALE_AFTER_MS + 1500,
        );
      });
      expect(screen.getByText(/more than 30 seconds old/)).toBeTruthy();
      expect(screen.getByRole('img')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
