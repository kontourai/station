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
   * The access-denied branch, and the one that hides its control: a button
   * cannot repair a credential, so offering Try again would be an action that
   * cannot work. Leaving Capture rendered under a 403 reds the last
   * assertion.
   */
  test.each([403, 401])(
    '%i names the read-only credential and the changed sign-in, and withdraws Capture',
    async (status) => {
      await captureWith(status);
      await screen.findByText(/refused the screen capture/);
      expect(screen.getByText(/read-only credential/)).toBeTruthy();
      expect(screen.getByText(/sign-in that changed/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
      expect(
        screen.queryByRole('button', { name: 'Refresh devices' }),
      ).toBeNull();
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
