/**
 * `allow-same-origin` is safe only when the frame origin is distinct from
 * Station. Keep this predicate dependency-free: plugin isolation needs it
 * without loading the much larger MCP App host and its split CSS.
 */
export function isDistinctFrameOrigin(frameOrigin?: string): boolean {
  if (!frameOrigin || typeof window === 'undefined') return false;
  try {
    return new URL(frameOrigin).origin !== window.location.origin;
  } catch {
    return false;
  }
}
