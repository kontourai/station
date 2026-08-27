// @vitest-environment jsdom
/**
 * station#3423 review MEDIUM-2/MEDIUM-3: `qr-round-trip.test.ts` asserts
 * properties of the `qrcode` package's own default (its "same
 * error-correction level" test derives nothing about `QRDisplay` — it
 * would pass unchanged even if `QRDisplay` started passing an explicit
 * `errorCorrectionLevel`), and nothing enforced that `QRDisplay` actually
 * imports `QR_MARGIN`/`QR_COLOR` from `qr-render-options.ts` rather than
 * its own literals — the extraction's stated purpose ("so the two cannot
 * silently drift") was unenforced convention, not derivation. This file
 * renders the real `QRDisplay` component with `qrcode` mocked and asserts
 * on the actual `QRCode.toCanvas` call it makes, converting both claims
 * into something a code change can break.
 */
import { render, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

const { toCanvas } = vi.hoisted(() => ({
  toCanvas: vi.fn().mockResolvedValue(undefined),
}));

// QRDisplay does `import('qrcode').then((QRCode) => QRCode.toCanvas(...))`
// — the dynamic-import namespace object needs `toCanvas` reachable both as
// a named export and via `.default` so this mock matches real interop
// shapes regardless of how the bundler resolves the CJS `qrcode` package.
vi.mock('qrcode', () => ({ toCanvas, default: { toCanvas } }));

import { QRDisplay } from '../react/QRDisplay';
import { QR_COLOR, QR_MARGIN } from '../react/qr-render-options';

describe('QRDisplay renders through the shared qr-render-options constants', () => {
  test('passes QR_MARGIN/QR_COLOR from qr-render-options, and no errorCorrectionLevel', async () => {
    toCanvas.mockClear();
    render(<QRDisplay url="http://192.168.1.42:3141" size={160} />);

    await waitFor(() => expect(toCanvas).toHaveBeenCalledTimes(1));

    const [, url, options] = toCanvas.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
    ];
    expect(url).toBe('http://192.168.1.42:3141');
    // Exact-match on the whole options object, not `toMatchObject`: a
    // subset check would still pass if QRDisplay started also passing
    // `errorCorrectionLevel` (or any other option) alongside the correct
    // margin/color — the object-level `toEqual` is what makes the
    // "and no errorCorrectionLevel" half of this test's title load-bearing
    // rather than redundant with the property check below.
    expect(options).toEqual({
      width: 160,
      margin: QR_MARGIN,
      color: QR_COLOR,
    });
    expect(options).not.toHaveProperty('errorCorrectionLevel');
  });
});
