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

/**
 * True only when the capture API is missing because the page is not a secure
 * context (plain HTTP on a LAN address). A secure page can also lack the API,
 * for example a WebView with media capture turned off; that is not this case.
 */
export function cameraApiBlockedByInsecureContext(): boolean {
  return (
    !hasCameraApi() &&
    typeof window !== 'undefined' &&
    window.isSecureContext === false
  );
}
