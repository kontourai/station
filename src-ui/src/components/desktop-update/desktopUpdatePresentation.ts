import type { DesktopUpdateState } from '@kontourai/station-contracts/desktop-update';
import { formatBytes } from '../../utils/formatBytes';

/**
 * The desktop summary on the shared Updates control. Check failures stay
 * inside the panel: an offline laptop's hourly check must not raise chrome.
 */
export type DesktopUpdateControlView =
  | { kind: 'hidden' }
  | { kind: 'download'; version: string; failed: boolean }
  | {
      kind: 'downloading';
      version: string;
      /** Whole percent, or null when the size is unknown. */
      percent: number | null;
      progressText: string;
    }
  | { kind: 'restart'; version: string; failed: boolean }
  | { kind: 'installing'; version: string };

export function downloadPercent(
  downloadedBytes: number,
  totalBytes: number | null,
): number | null {
  if (totalBytes === null || totalBytes <= 0) return null;
  return Math.floor((Math.min(downloadedBytes, totalBytes) * 100) / totalBytes);
}

export function desktopUpdateControlView(
  state: DesktopUpdateState | null,
): DesktopUpdateControlView {
  if (!state) return { kind: 'hidden' };
  const { phase, error } = state;
  switch (phase.status) {
    case 'available':
      return {
        kind: 'download',
        version: phase.version,
        failed: error?.context === 'download',
      };
    case 'downloading': {
      const percent = downloadPercent(phase.downloadedBytes, phase.totalBytes);
      return {
        kind: 'downloading',
        version: phase.version,
        percent,
        progressText:
          percent === null ? formatBytes(phase.downloadedBytes) : `${percent}%`,
      };
    }
    case 'ready':
      return {
        kind: 'restart',
        version: phase.version,
        failed: error?.context === 'install',
      };
    case 'installing':
      return { kind: 'installing', version: phase.version };
    default:
      return { kind: 'hidden' };
  }
}
