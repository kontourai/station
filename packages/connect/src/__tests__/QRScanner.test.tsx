// @vitest-environment jsdom
import { fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { decodeDevicePairingPayload, jsQR } = vi.hoisted(() => ({
  decodeDevicePairingPayload: vi.fn(),
  jsQR: vi.fn(),
}));

vi.mock('../core/devicePairing', () => ({ decodeDevicePairingPayload }));
vi.mock('jsqr', () => ({ default: jsQR }));

import { QRScanner } from '../react/QRScanner';

describe('QRScanner camera lifecycle', () => {
  const stopTrack = vi.fn();
  const getUserMedia = vi.fn();

  beforeEach(() => {
    stopTrack.mockReset();
    getUserMedia.mockReset();
    decodeDevicePairingPayload.mockReset();
    jsQR.mockReset();
    jsQR.mockReturnValue(null);
    getUserMedia.mockResolvedValue({
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream);

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    Object.defineProperties(HTMLVideoElement.prototype, {
      readyState: { configurable: true, get: () => 4 },
      videoHeight: { configurable: true, get: () => 480 },
      videoWidth: { configurable: true, get: () => 640 },
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({
        data: new Uint8ClampedArray(4),
        height: 1,
        width: 1,
      })),
    } as unknown as CanvasRenderingContext2D);
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('offers manual entry from the camera-denied error state instead of dead-ending', async () => {
    getUserMedia.mockRejectedValue(
      Object.assign(new Error('denied'), { name: 'NotAllowedError' }),
    );
    const onManualEntry = vi.fn();

    const { findByText, getByRole } = render(
      <QRScanner
        onScan={vi.fn()}
        onCancel={vi.fn()}
        onManualEntry={onManualEntry}
      />,
    );

    await findByText('Camera permission denied. Please allow camera access.');
    const manualButton = getByRole('button', {
      name: 'Enter the pairing code manually',
    });
    fireEvent.click(manualButton);
    expect(onManualEntry).toHaveBeenCalledTimes(1);
  });

  test('omits the manual-entry affordance when no handler is supplied', async () => {
    getUserMedia.mockRejectedValue(
      Object.assign(new Error('denied'), { name: 'NotAllowedError' }),
    );

    const { findByText, queryByRole } = render(
      <QRScanner onScan={vi.fn()} onCancel={vi.fn()} />,
    );

    await findByText('Camera permission denied. Please allow camera access.');
    expect(
      queryByRole('button', { name: 'Enter the pairing code manually' }),
    ).toBeNull();
  });

  test('does not reacquire the camera when callback identities change', async () => {
    const firstScan = vi.fn();
    const { rerender, unmount } = render(
      <QRScanner onScan={firstScan} onCancel={vi.fn()} />,
    );

    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    rerender(<QRScanner onScan={vi.fn()} onCancel={vi.fn()} />);
    await Promise.resolve();

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    unmount();
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });

  test('delivers one valid scan and stops the stream before cancel or unmount', async () => {
    const firstScan = vi.fn();
    const replacementScan = vi.fn();
    const onCancel = vi.fn();
    jsQR.mockReturnValue({ data: 'station-pairing-payload' });
    decodeDevicePairingPayload.mockReturnValue({ offerId: 'offer' });

    const { getByRole, rerender, unmount } = render(
      <QRScanner onScan={firstScan} onCancel={onCancel} />,
    );

    await waitFor(() => expect(firstScan).toHaveBeenCalledTimes(1));
    expect(firstScan).toHaveBeenCalledWith('station-pairing-payload');
    expect(stopTrack).toHaveBeenCalledTimes(1);

    rerender(<QRScanner onScan={replacementScan} onCancel={onCancel} />);
    fireEvent.click(getByRole('button', { name: 'Cancel' }));
    unmount();

    expect(firstScan).toHaveBeenCalledTimes(1);
    expect(replacementScan).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });
});
