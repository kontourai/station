/**
 * Desktop app self-update state (#3851).
 *
 * The native desktop shell owns this state (`src-desktop/src/desktop_update.rs`)
 * and emits it on {@link DESKTOP_UPDATE_STATE_EVENT}; the window and the tray
 * read the same value. Every phase is one a native transition produces. A
 * failure is not a phase: it returns to the most useful prior phase and is
 * reported beside it in `error` (a failed download is still `available`, a
 * failed install is still `ready`).
 *
 * Timestamps are Unix epoch milliseconds.
 */

/** The native event every state change is emitted on. */
export const DESKTOP_UPDATE_STATE_EVENT = 'station://desktop-update-state';

/**
 * When an available update downloads without a click. A manual download
 * always works; restart is never automatic under any policy.
 */
export const DESKTOP_UPDATE_DOWNLOAD_POLICIES = [
  'never',
  'after-24h',
  'immediately',
] as const;
export type DesktopUpdateDownloadPolicy =
  (typeof DESKTOP_UPDATE_DOWNLOAD_POLICIES)[number];
export const DEFAULT_DESKTOP_UPDATE_DOWNLOAD_POLICY: DesktopUpdateDownloadPolicy =
  'after-24h';

export type DesktopUpdatePhase =
  /** This build has no usable update channel; nothing is checked. */
  | { status: 'disabled' }
  /** Configured; no check has finished yet in this run. */
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'up-to-date'; checkedAt: number }
  | {
      status: 'available';
      version: string;
      notes: string | null;
      /** First seen available on this machine; survives restarts. */
      availableSince: number;
    }
  | {
      status: 'downloading';
      version: string;
      downloadedBytes: number;
      /** Null when the server did not report a length. */
      totalBytes: number | null;
    }
  /** Downloaded and signature-verified; waits for a confirmed restart. */
  | { status: 'ready'; version: string }
  | { status: 'installing'; version: string };

export type DesktopUpdateStatus = DesktopUpdatePhase['status'];

export type DesktopUpdateErrorContext = 'check' | 'download' | 'install';

export interface DesktopUpdateError {
  context: DesktopUpdateErrorContext;
  /** The updater's own message, unclassified. */
  message: string;
  version: string | null;
}

export interface DesktopUpdateState {
  phase: DesktopUpdatePhase;
  error: DesktopUpdateError | null;
  policy: DesktopUpdateDownloadPolicy;
  /** The running desktop app's version. */
  currentVersion: string;
  /**
   * When the policy downloads the available update by itself; null when it
   * never will (policy `never`, or nothing is available).
   */
  autoDownloadAt: number | null;
  /**
   * Increases with every emitted change while the app runs. A reader keeps
   * the highest it has seen and drops older events and snapshots.
   */
  sequence: number;
}
