/**
 * Whether this browser exposes a camera capture API at all. It is missing
 * outside a secure context (plain HTTP on a LAN address) and in some shells.
 * Its presence does not prove a camera exists: only a capture attempt does.
 */
export function hasCameraApi(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}
