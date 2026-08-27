/**
 * `qrcode` rendering options `QRDisplay` passes to `QRCode.toCanvas`.
 * Exported so `qr-round-trip.test.ts` can rasterize modules with the exact
 * same margin/colors instead of a second hand-maintained copy — a
 * round-trip test asserting a set of literals that merely *happen* to match
 * the component today is a test that silently starts covering a different
 * QR code than production renders the moment either copy drifts
 * (station#3423 review LOW).
 */
export const QR_MARGIN = 2;
export const QR_COLOR = { dark: '#000000', light: '#ffffff' } as const;
