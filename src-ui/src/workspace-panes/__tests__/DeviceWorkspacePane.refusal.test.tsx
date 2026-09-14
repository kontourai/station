// @vitest-environment jsdom

/**
 * #1969: a refused capture, by status.
 *
 * The status is the ONLY thing the client surfaces —
 * `MobileDeviceRequestError` carries no server code and no server message —
 * so these cases drive the real transport and assert what the pane derives
 * from it. Mapping every non-2xx onto one sentence reds four of the five.
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
  describeCaptureFailure,
  describeCaptureRefusal,
} from '../deviceCaptureOutcome';
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

async function captureWith(status: number) {
  const log = stubDeviceFetch({
    inventory: readyInventory(),
    captures: [{ status }],
  });
  authorizeScope();
  const view = renderInQueryClient(<DeviceWorkspacePane />);
  await click(await screen.findByRole('radio', { name: /iPhone/ }));
  await click(screen.getByRole('button', { name: 'Capture' }));
  return { ...view, log };
}

describe('a refused capture (#1969)', () => {
  /**
   * The access-denied branch names BOTH causes and adds no control of its
   * own — Try again and Refresh devices belong to the `retry` and `refresh`
   * arms — while the toolbar's Capture STAYS live, because one of the two
   * causes is repairable in place: sign in again and the very next Capture
   * succeeds. Withdrawing the control would serve the read-only credential
   * and strand the changed sign-in at a dead end.
   *
   * Each half has its own assertion, and the two point opposite ways:
   * rendering a Try again or a Refresh devices here reds the first pair;
   * withdrawing Capture reds `getByRole`, disabling it reds `disabled`, and
   * making the press a no-op reds the request count. The count is asserted
   * before AND after so a Capture that fires on render could not supply it.
   */
  test.each([403, 401])(
    '%i names the read-only credential and the changed sign-in, and keeps Capture live',
    async (status) => {
      const { log } = await captureWith(status);
      await screen.findByText(/refused the screen capture/);
      expect(screen.getByText(/read-only credential/)).toBeTruthy();
      expect(screen.getByText(/sign-in that changed/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
      expect(
        screen.queryByRole('button', { name: 'Refresh devices' }),
      ).toBeNull();

      // The standing control is the retry for the repairable cause.
      expect(screen.getByRole('button', { name: 'Capture' })).toHaveProperty(
        'disabled',
        false,
      );
      expect(log.captureRequests).toHaveLength(1);
      await click(screen.getByRole('button', { name: 'Capture' }));
      await waitFor(() => expect(log.captureRequests).toHaveLength(2));
    },
  );

  /**
   * A device that is gone is not a capture to retry: the reader is sent to
   * the inventory. Routing 409 to the retry arm reds the second half.
   */
  test('409 says the device is gone and offers a device refresh, not a retry', async () => {
    const { log } = await captureWith(409);
    await screen.findByText(/no longer running/);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    const refresh = screen.getByRole('button', { name: 'Refresh devices' });
    const before = log.inventoryReads;
    await click(refresh);
    await waitFor(() => expect(log.inventoryReads).toBe(before + 1));
    expect(log.captureRequests).toHaveLength(1);
  });

  test('503 says the capture did not complete and offers a retry', async () => {
    const { log } = await captureWith(503);
    await screen.findByText(/capture did not complete/);
    await click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(log.captureRequests).toHaveLength(2));
  });

  /**
   * Anything that is not a `MobileDeviceRequestError` falls to
   * `describeReadFailure`, so the sentence is the most specific honest thing
   * available rather than an invented cause.
   */
  test('a non-request failure falls back to the shared read-failure sentence', () => {
    const outcome = describeCaptureFailure(new Error('socket hang up'));
    expect(outcome.kind).toBe('transport');
    expect(outcome.description).toBe('socket hang up');
    expect(outcome.action).toBe('retry');
    expect(describeCaptureFailure('a string').description).toBe(
      'Try again in a moment.',
    );
  });

  /** The map itself, so an unlisted status cannot silently take a branch. */
  test('the status map routes each refusal to its own kind', () => {
    expect(describeCaptureRefusal(401).kind).toBe('access-denied');
    expect(describeCaptureRefusal(403).kind).toBe('access-denied');
    expect(describeCaptureRefusal(403).action).toBe('none');
    expect(describeCaptureRefusal(409).kind).toBe('device-gone');
    expect(describeCaptureRefusal(409).action).toBe('refresh');
    expect(describeCaptureRefusal(400).kind).toBe('invalid-target');
    expect(describeCaptureRefusal(500).kind).toBe('unavailable');
    expect(describeCaptureRefusal(503).action).toBe('retry');
  });

  /**
   * A refused RE-capture keeps the frame that already arrived.
   *
   * React Query's mutation clears its own `data` the moment `mutate` is
   * called, so unless the surface holds the last good frame the error card
   * replaces it — discarding information in order to report a failure, which
   * is the opposite of what the stale decoration exists to say. The frame is
   * still labelled with its own capture time, so nothing claims it is
   * current.
   *
   * Dropping the retained frame reds the second image assertion. Retaining it
   * WITHOUT keying it to the selection reds the third, where the same
   * retained frame would otherwise be captioned with a different device's
   * name. Keying it but never CLEARING it reds the fourth: keying only
   * withholds the frame while another device is selected, so coming back
   * re-presents it.
   */
  test('a refused re-capture keeps the frame that already arrived, and neither carries it to another device nor brings it back', async () => {
    stubDeviceFetch({
      inventory: readyInventory(),
      captures: [captureBody(), { status: 503 }],
    });
    authorizeScope();
    renderInQueryClient(<DeviceWorkspacePane />);
    await click(await screen.findByRole('radio', { name: /iPhone/ }));
    await click(screen.getByRole('button', { name: 'Capture' }));
    expect((await screen.findByRole('img')).getAttribute('alt')).toMatch(
      /^Snapshot of iPhone 17 Pro/,
    );

    await click(screen.getByRole('button', { name: 'Capture' }));
    await screen.findByText(/capture did not complete/);
    expect(screen.getByRole('img').getAttribute('alt')).toMatch(
      /^Snapshot of iPhone 17 Pro/,
    );

    await click(screen.getByRole('radio', { name: /Pixel/ }));
    await waitFor(() => expect(screen.queryByRole('img')).toBeNull());

    // And back. `click` has already awaited the re-render, so this is a plain
    // assertion rather than a `waitFor`: a retained frame that survives the
    // round trip is on screen in that same render, and a `waitFor` whose
    // callback is satisfied on its first synchronous call would not be
    // waiting for anything anyway.
    await click(screen.getByRole('radio', { name: /iPhone/ }));
    expect(screen.queryByRole('img')).toBeNull();
  });

  /**
   * After a refusal, leaving the device and coming back brings back NEITHER
   * half of what was on screen.
   *
   * `capture.reset()` clears the refusal on the way out, so a frame that
   * survived the round trip would return alone: the capture the reader left
   * behind, re-presented in the ordinary success position, with the failure
   * that produced it gone. Removing `retained.current = null` from
   * `selectDevice` reds the image assertion; keeping the refusal across the
   * switch reds the other.
   */
  test('after a refusal, leaving the device and returning brings back neither the frame nor the refusal', async () => {
    stubDeviceFetch({
      inventory: readyInventory(),
      captures: [captureBody(), { status: 503 }],
    });
    authorizeScope();
    renderInQueryClient(<DeviceWorkspacePane />);
    await click(await screen.findByRole('radio', { name: /iPhone/ }));
    await click(screen.getByRole('button', { name: 'Capture' }));
    await screen.findByRole('img');

    await click(screen.getByRole('button', { name: 'Capture' }));
    await screen.findByText(/capture did not complete/);
    expect(screen.getByRole('img')).toBeTruthy();

    await click(screen.getByRole('radio', { name: /Pixel/ }));
    await click(screen.getByRole('radio', { name: /iPhone/ }));
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByText(/capture did not complete/)).toBeNull();
  });

  /** Picking another device clears the previous refusal rather than keeping it. */
  test('choosing another device clears the refusal', async () => {
    stubDeviceFetch({
      inventory: readyInventory(),
      captures: [{ status: 503 }, captureBody({ platform: 'android' })],
    });
    authorizeScope();
    renderInQueryClient(<DeviceWorkspacePane />);
    await click(await screen.findByRole('radio', { name: /iPhone/ }));
    await click(screen.getByRole('button', { name: 'Capture' }));
    await screen.findByText(/capture did not complete/);
    await click(screen.getByRole('radio', { name: /Pixel/ }));
    await waitFor(() =>
      expect(screen.queryByText(/capture did not complete/)).toBeNull(),
    );
  });
});
