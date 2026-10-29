/**
 * `1048576` → `1.0 MB`.
 *
 * The UI's one byte-size format, so two surfaces describing the same thing
 * cannot report it in different units (archive#3375): the composer's preview
 * popover used to render a resized 1 MB image as `1024.0 KB` beside the
 * attachment strip's `1.0 MB`.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}
