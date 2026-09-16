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

  /**
   * Staleness reaches a screen reader, not only a sighted reader.
   *
   * It used to live in the `figcaption` alone while the `alt` carried a bare
   * `toLocaleTimeString()` — no date and no age — so a frame six hours old
   * was announced as "captured 5:25:59 AM" and nothing else. Both now read
   * the same `STALE_NOTE`. Removing it from the `alt` reds the first
   * assertion; letting a fresh frame carry it reds the last.
   *
   * The date is the other half: a time alone is the same string for a frame
   * taken a minute ago and one taken at the same hour yesterday, so the label
   * carries a date exactly when the frame is not from today.
   */
  test('the alt text carries the staleness, and a day-old frame carries its date', async () => {
    await captureAt(new Date(Date.now() - 120_000).toISOString());
    expect(screen.getByRole('img').getAttribute('alt')).toMatch(
      /more than 30 seconds old, so it may not be the current screen$/,
    );
    cleanup();

    const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000);
    await captureAt(yesterday.toISOString());
    const alt = screen.getByRole('img').getAttribute('alt') ?? '';
    expect(alt).toContain(yesterday.toLocaleString());
    expect(alt).toContain('more than 30 seconds old');
    cleanup();

    // Bound to one `Date`, not read from the clock twice: a second boundary
    // between the fixture and the expectation would make this flake.
    const fresh = new Date();
    await captureAt(fresh.toISOString());
    expect(screen.getByRole('img').getAttribute('alt')).toBe(
      `Snapshot of iPhone 17 Pro, captured ${fresh.toLocaleTimeString()}`,
    );
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
