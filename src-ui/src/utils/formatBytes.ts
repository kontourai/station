/**
 * `1048576` → `1.0 MB`.
 *
 * Shared by the composer's attachment strip and its preview popover so the two
 * surfaces describing the same attachment cannot report its size in different
 * units (archive#3375): the popover used to render a resized 1 MB image
 * as `1024.0 KB` beside the strip's `1.0 MB`.
 *
 * Scope is those two surfaces, not the app: `AgentConnectionView` keeps its own
 * private copy, which this change deliberately did not touch.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}
